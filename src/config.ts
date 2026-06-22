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
};
