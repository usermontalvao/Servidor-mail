import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { logger } from './logger.js';
import { storeIncoming } from './store.js';
import { supabase } from './supabase.js';

let stopping = false;
// Todas as conexões ativas (uma por pasta monitorada) — p/ logout no shutdown.
const clients = new Set<ImapFlow>();

interface Target {
  mailbox: string;
  isSpam: boolean;
}

interface SyncState {
  uidValidity: number;
  lastUid: number;
}

// Mutex global encadeado: serializa a gravação entre TODAS as pastas. Como cada
// pasta tem sua própria conexão/IDLE, sem isso duas pastas poderiam inserir o
// mesmo message_id ao mesmo tempo (corrida no dedupe). Spam não é latência‑
// crítico, então serializar é seguro e simples.
let chain: Promise<void> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadState(mailbox: string): Promise<SyncState> {
  const { data, error } = await supabase
    .from('email_sync_state')
    .select('uid_validity, last_uid')
    .eq('mailbox', mailbox)
    .maybeSingle();
  if (error) {
    // NÃO cair para {0,0} aqui: uidValidity=0 faz o syncByUid varrer a caixa
    // INTEIRA (from=1, ~milhares de msgs) a cada falha transitória de leitura.
    // Aborta o ciclo preservando o watermark; o próximo resync tenta de novo.
    logger.error({ err: error, mailbox }, 'falha ao ler email_sync_state — abortando ciclo de sync');
    throw new Error(`loadState falhou: ${error.message}`);
  }
  return {
    uidValidity: Number(data?.uid_validity ?? 0),
    lastUid: Number(data?.last_uid ?? 0),
  };
}

async function saveState(mailbox: string, uidValidity: number, lastUid: number): Promise<void> {
  const { error } = await supabase.from('email_sync_state').upsert(
    {
      mailbox,
      uid_validity: uidValidity,
      last_uid: lastUid,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'mailbox' },
  );
  if (error) logger.error({ err: error, mailbox }, 'falha ao gravar email_sync_state');
}

/**
 * Sincroniza UMA pasta por UID (e nao por flag \Seen). O watermark (last_uid) +
 * uid_validity ficam por pasta no Supabase. O dedupe GLOBAL por message_id no
 * store evita duplicacao quando o provedor move um email entre pastas.
 *
 * `processingRef` evita empilhar varias syncs pendentes da MESMA pasta; a
 * execucao em si passa pelo mutex global (runExclusive).
 */
async function syncByUid(
  c: ImapFlow,
  target: Target,
  processingRef: { busy: boolean },
): Promise<void> {
  if (processingRef.busy) return; // já há uma sync desta pasta na fila/rodando
  processingRef.busy = true;
  try {
    await runExclusive(async () => {
      const lock = await c.getMailboxLock(target.mailbox);
      try {
        const mb = c.mailbox;
        const serverUidValidity =
          mb && typeof mb === 'object' && 'uidValidity' in mb ? Number(mb.uidValidity) : 0;

        const state = await loadState(target.mailbox);
        const validityChanged =
          serverUidValidity !== 0 && state.uidValidity !== 0 && serverUidValidity !== state.uidValidity;

        let from = state.lastUid + 1;
        if (state.uidValidity === 0 || validityChanged) {
          // primeira execucao ou caixa reindexada -> varre tudo (dedupe protege)
          from = 1;
          if (validityChanged) {
            logger.warn(
              { antigo: state.uidValidity, novo: serverUidValidity, mailbox: target.mailbox },
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
            await storeIncoming(parsed, msg.uid, target.mailbox, target.isSpam);
          } catch (err) {
            logger.error({ err, uid: msg.uid, mailbox: target.mailbox }, 'falha ao processar mensagem');
          }
          if (msg.uid > maxUid) maxUid = msg.uid;
        }

        if (maxUid !== state.lastUid || serverUidValidity !== state.uidValidity) {
          await saveState(target.mailbox, serverUidValidity || state.uidValidity, maxUid);
        }
      } finally {
        lock.release();
      }
    });
  } finally {
    processingRef.busy = false;
  }
}

function newClient(): ImapFlow {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  });
}

/**
 * Descobre as pastas a monitorar: INBOX sempre + a pasta de Spam/Junk do
 * servidor (por special-use \Junk ou pelo nome). Lixeira só se IMAP_INCLUDE_TRASH.
 * Pastas extras podem ser forçadas via IMAP_MAILBOXES. Tolerante a falhas: se a
 * listagem falhar, volta a monitorar só a INBOX (comportamento antigo).
 */
async function discoverTargets(): Promise<Target[]> {
  const targets = new Map<string, boolean>(); // mailbox -> isSpam
  targets.set(config.imap.mailbox, false); // INBOX sempre, não-spam

  const c = newClient();
  try {
    await c.connect();
    const boxes = await c.list();
    for (const b of boxes) {
      const su = String((b as { specialUse?: string }).specialUse ?? '').toLowerCase();
      const path = b.path;
      const looksJunk = su === '\\junk' || /(^|[./])(junk|spam)([./]|$)/i.test(path);
      const looksTrash = su === '\\trash' || /(^|[./])(trash|deleted|lixeira)([./]|$)/i.test(path);
      if (looksJunk) targets.set(path, true);
      else if (looksTrash && config.imap.includeTrash) targets.set(path, true);
    }
  } catch (err) {
    logger.error({ err }, 'falha ao listar pastas IMAP — monitorando só a INBOX');
  } finally {
    try {
      await c.logout();
    } catch {
      /* noop */
    }
  }

  // Pastas extras forçadas por env (spam se o nome sugerir).
  for (const m of config.imap.extraMailboxes) {
    if (!targets.has(m)) targets.set(m, /junk|spam/i.test(m));
  }

  return [...targets].map(([mailbox, isSpam]) => ({ mailbox, isSpam }));
}

/** Loop de monitoramento de UMA pasta: conecta, sincroniza, IDLE, resync, reconecta. */
function watch(target: Target): void {
  const processingRef = { busy: false };

  const loop = async (): Promise<void> => {
    while (!stopping) {
      let client: ImapFlow | null = null;
      try {
        client = newClient();
        clients.add(client);
        client.on('error', (err) => logger.error({ err, mailbox: target.mailbox }, 'erro IMAP'));

        await client.connect();
        await client.mailboxOpen(target.mailbox);
        logger.info({ mailbox: target.mailbox, isSpam: target.isSpam }, 'IMAP conectado (pasta)');

        // 1) backlog na conexão
        await syncByUid(client, target, processingRef);

        // 2) novas mensagens em tempo real (IDLE)
        const c = client;
        c.on('exists', () => {
          syncByUid(c, target, processingRef).catch((err) =>
            logger.error({ err, mailbox: target.mailbox }, 'falha ao processar novas mensagens'),
          );
        });

        // 3) rede de segurança: alguns servidores param de emitir IDLE de forma
        // confiável (socket zumbi). Reconcilia periodicamente.
        const resync = setInterval(() => {
          if (stopping) return;
          syncByUid(c, target, processingRef).catch((err) =>
            logger.error({ err, mailbox: target.mailbox }, 'falha no resync periódico'),
          );
        }, config.imap.pollIntervalMs);

        // mantém viva até cair
        await new Promise<void>((resolve) => c.on('close', () => resolve()));
        clearInterval(resync);
        logger.warn({ mailbox: target.mailbox }, 'conexao IMAP fechada, reconectando em 5s');
      } catch (err) {
        logger.error({ err, mailbox: target.mailbox }, 'falha na conexao IMAP, retry em 10s');
        await new Promise((r) => setTimeout(r, 10_000));
      } finally {
        if (client) clients.delete(client);
      }
      if (!stopping) await new Promise((r) => setTimeout(r, 5_000));
    }
  };

  void loop();
}

export async function startImap(): Promise<void> {
  if (!config.receiveEnabled) {
    logger.warn('RECEIVE_ENABLED=false — recebimento IMAP desativado');
    return;
  }

  let targets: Target[];
  try {
    targets = await discoverTargets();
  } catch (err) {
    logger.error({ err }, 'discoverTargets falhou — monitorando só a INBOX');
    targets = [{ mailbox: config.imap.mailbox, isSpam: false }];
  }

  logger.info({ targets }, 'IMAP: pastas monitoradas');
  for (const t of targets) watch(t);
}

export async function stopImap(): Promise<void> {
  stopping = true;
  for (const c of clients) {
    try {
      await c.logout();
    } catch {
      /* noop */
    }
  }
}
