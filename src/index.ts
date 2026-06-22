import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { verifySmtp } from './smtp.js';
import { startImap, stopImap } from './imap.js';

async function main() {
  // valida SMTP no boot (nao derruba o processo se falhar — apenas loga)
  try {
    await verifySmtp();
  } catch (err) {
    logger.error({ err }, 'SMTP indisponivel no boot (envio pode falhar)');
  }

  // inicia recebimento IMAP em background
  void startImap();

  // sobe a API HTTP de envio
  const app = createServer();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'email-bridge ouvindo');
  });

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'encerrando');
    await stopImap();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'falha fatal no boot');
  process.exit(1);
});
