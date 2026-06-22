import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return v;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: num('PORT', 8080),
  apiToken: req('BRIDGE_API_TOKEN'),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  imap: {
    host: req('IMAP_HOST'),
    port: num('IMAP_PORT', 993),
    secure: bool('IMAP_SECURE', true),
    user: req('IMAP_USER'),
    password: req('IMAP_PASSWORD'),
    mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
    // Além da INBOX, a ponte descobre e monitora a pasta de Spam/Junk do servidor
    // (senão e-mails filtrados pelo provedor NUNCA chegam ao CRM até serem movidos
    // manualmente). Pastas extras podem ser forçadas via IMAP_MAILBOXES (lista
    // separada por vírgula). A Lixeira fica de fora por padrão (re-importaria
    // e-mails apagados) — ligue com IMAP_INCLUDE_TRASH=true se quiser.
    extraMailboxes: (process.env.IMAP_MAILBOXES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    includeTrash: bool('IMAP_INCLUDE_TRASH', false),
    // Rede de segurança: reconcilia a caixa a cada N ms mesmo que o IDLE pare de
    // notificar (socket zumbi). Barato — só busca de last_uid+1 e o dedupe ignora
    // o que já existe. Limita a latência máxima de um email novo a esse intervalo.
    pollIntervalMs: num('IMAP_POLL_INTERVAL_MS', 60_000),
  },

  smtp: {
    host: req('SMTP_HOST'),
    port: num('SMTP_PORT', 465),
    secure: bool('SMTP_SECURE', true),
    user: req('SMTP_USER'),
    password: req('SMTP_PASSWORD'),
    from: process.env.SMTP_FROM ?? req('SMTP_USER'),
  },

  supabase: {
    url: req('SUPABASE_URL'),
    serviceRoleKey: req('SUPABASE_SERVICE_ROLE_KEY'),
  },

  receiveEnabled: bool('RECEIVE_ENABLED', true),
  attachmentsBucket: process.env.ATTACHMENTS_BUCKET ?? 'email-attachments',

  // Classificação de spam por IA (DeepSeek via edge openai-proxy). Roda só em
  // emails recebidos novos e ambíguos (whitelist/blocklist decidem antes).
  spamAi: {
    enabled: bool('SPAM_AI_ENABLED', true),
    // Endpoint do proxy de IA (failover DeepSeek->Groq->OpenAI).
    proxyUrl: process.env.SPAM_AI_PROXY_URL ?? `${req('SUPABASE_URL')}/functions/v1/openai-proxy`,
  },
};
