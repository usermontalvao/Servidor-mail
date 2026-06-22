import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { logger } from './logger.js';
import { storeIncoming } from './store.js';
import { supabase } from './supabase.js';

let client: ImapFlow | null = null;
let stopping = false;
let processing = false;

interface SyncState {
  uidValidity: number;
  lastUid: number;
}

async function loadState(): Promise<SyncState> {
  const { data, error } = await supabase
    .from('email_sync_state')
    .select('uid_validity, last_uid')
    .eq('mailbox', config.imap.mailbox)
    .maybeSingle();
  if (error) logger.error({ err: error }, 'falha ao ler email_sync_state');
  return {
    uidValidity: Number(data?.uid_validity ?? 0),
    lastUid: Number(data?.last_uid ?? 0),
  };
}

async function saveState(uidValidity: number, lastUid: number): Promise<void> {
  const { error } = await supabase.from('email_sync_state').upsert(
    {
      mailbox: config.imap.mailbox,
      uid_validity: uidValidity,
      last_uid: lastUid,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'mailbox' },
  );
  if (error) logger.error({ err: error }, 'falha ao gravar email_sync_state');
}

/**
 * Sincroniza por UID (e nao por flag \Seen). Assim, mesmo que um email seja
 * lido no webmail/celular durante uma queda da ponte, ele ainda e capturado.
 * O dedupe por (mailbox, message_id) no store evita reprocesso/duplicacao.
 *
 * Estrategia:
 *  - guarda last_uid (watermark) + uid_validity no Supabase.
 *  - se uid_validity mudou (UIDs reatribuidos pelo servidor) ou e a 1a vez,
 *    faz backfill total (UID 1:*) — barato gracas ao dedupe.
 *  - caso normal, busca (last_uid+1):* — so o que chegou desde a ultima vez.
 */
async function syncByUid(c: ImapFlow): Promise<void> {
  if (processing) return; // serializa: evita corrida entre boot e evento 'exists'
  processing = true;
  const lock = await c.getMailboxLock(config.imap.mailbox);
  try {
    const mb = c.mailbox;
    const serverUidValidity =
      mb && typeof mb === 'object' && 'uidValidity' in mb ? Number(mb.uidValidity) : 0;

    const state = await loadState();
    const validityChanged =
      serverUidValidity !== 0 && state.uidValidity !== 0 && serverUidValidity !== state.uidValidity;

    let from = state.lastUid + 1;
    if (state.uidValidity === 0 || validityChanged) {
      // primeira execucao ou caixa reindexada -> varre tudo (dedupe protege)
      from = 1;
      if (validityChanged) {
        logger.warn(
          { antigo: state.uidValidity, novo: serverUidValidity },
          'UIDVALIDITY mudou — refazendo backfill',
        );
      }
    }

    let maxUid = state.lastUid;
    const range = `${from}:*`;
    for await (const msg of c.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= state.lastUid && state.uidValidity !== 0 && !validityChanged) continue;
      if (!msg.source) continue;
      try {
        const parsed = await simpleParser(msg.source);
        await storeIncoming(parsed, msg.uid);
      } catch (err) {
        logger.error({ err, uid: msg.uid }, 'falha ao processar mensagem');
      }
      if (msg.uid > maxUid) maxUid = msg.uid;
    }

    if (maxUid !== state.lastUid || serverUidValidity !== state.uidValidity) {
      await saveState(serverUidValidity || state.uidValidity, maxUid);
    }
  } finally {
    lock.release();
    processing = false;
  }
}

export async function startImap(): Promise<void> {
  if (!config.receiveEnabled) {
    logger.warn('RECEIVE_ENABLED=false — recebimento IMAP desativado');
    return;
  }

  const connect = async (): Promise<void> => {
    client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: { user: config.imap.user, pass: config.imap.password },
      logger: false,
    });

    client.on('error', (err) => logger.error({ err }, 'erro IMAP'));

    await client.connect();
    logger.info({ mailbox: config.imap.mailbox }, 'IMAP conectado');

    await client.mailboxOpen(config.imap.mailbox);

    // 1) sincroniza o backlog na conexao
    await syncByUid(client);

    // 2) escuta novas mensagens em tempo real (IDLE)
    client.on('exists', () => {
      if (!client) return;
      syncByUid(client).catch((err) =>
        logger.error({ err }, 'falha ao processar novas mensagens'),
      );
    });
  };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      try {
        await connect();
        // mantem viva ate cair
        await new Promise<void>((resolve) => {
          client!.on('close', () => resolve());
        });
        logger.warn('conexao IMAP fechada, reconectando em 5s');
      } catch (err) {
        logger.error({ err }, 'falha na conexao IMAP, retry em 15s');
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (!stopping) await new Promise((r) => setTimeout(r, 5_000));
    }
  };

  void loop();
}

export async function stopImap(): Promise<void> {
  stopping = true;
  if (client) {
    try {
      await client.logout();
    } catch {
      /* noop */
    }
  }
}
