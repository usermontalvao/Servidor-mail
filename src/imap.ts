import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { logger } from './logger.js';
import { storeIncoming } from './store.js';

let client: ImapFlow | null = null;
let stopping = false;

async function processUnseen(c: ImapFlow): Promise<void> {
  // Busca tudo que ainda nao foi visto. O dedupe no store evita reprocesso.
  const lock = await c.getMailboxLock(config.imap.mailbox);
  try {
    for await (const msg of c.fetch({ seen: false }, { uid: true, source: true })) {
      if (!msg.source) continue;
      try {
        const parsed = await simpleParser(msg.source);
        await storeIncoming(parsed, msg.uid);
        // marca como lido para nao reprocessar; o CRM controla "lido" por usuario.
        await c.messageFlagsAdd({ uid: String(msg.uid) }, ['\\Seen'], { uid: true });
      } catch (err) {
        logger.error({ err, uid: msg.uid }, 'falha ao processar mensagem');
      }
    }
  } finally {
    lock.release();
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

    // 1) processa o backlog na conexao
    await processUnseen(client);

    // 2) escuta novas mensagens em tempo real (IDLE)
    client.on('exists', () => {
      processUnseen(client!).catch((err) =>
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
