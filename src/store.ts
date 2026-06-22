import type { ParsedMail, AddressObject } from 'mailparser';
import { supabase } from './supabase.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { classifyWithAi } from './spamAi.js';

/** Junta authentication-results + arc-authentication-results (pode ser array) em texto. */
function authText(headers: Record<string, unknown>): string {
  const toStr = (v: unknown): string =>
    Array.isArray(v) ? v.map((x) => String(x)).join(' ') : typeof v === 'string' ? v : '';
  return (toStr(headers['authentication-results']) + ' ' + toStr(headers['arc-authentication-results'])).toLowerCase();
}

/** Resume SPF/DKIM/DMARC a partir do texto de autenticação. */
function authSummary(t: string): string {
  const out: string[] = [];
  for (const k of ['spf', 'dkim', 'dmarc']) {
    const m = t.match(new RegExp(`${k}=(\\w+)`));
    if (m) out.push(`${k}=${m[1]}`);
  }
  return out.join(' ');
}

// Vereditos determinísticos do trigger que a IA NÃO deve sobrescrever.
const HARD_REASON = /whitelist|sinalizado como spam|bloqueado|regra de bloqueio/i;

function addrText(a?: AddressObject | AddressObject[]): string | null {
  if (!a) return null;
  const arr = Array.isArray(a) ? a : [a];
  return arr.map((x) => x.text).join(', ') || null;
}

function addrList(a?: AddressObject | AddressObject[]): { name: string; address: string }[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((x) =>
    x.value.map((v) => ({ name: v.name ?? '', address: v.address ?? '' })),
  );
}

/**
 * Persiste um email recebido. Idempotente por (mailbox, message_id):
 * a tabela tem indice unico, entao reentregas do IMAP nao duplicam.
 * Retorna true se inseriu, false se ja existia.
 */
export async function storeIncoming(
  parsed: ParsedMail,
  uid: number,
  mailbox: string = config.imap.mailbox,
  fromSpamFolder = false,
): Promise<boolean> {
  const messageId = parsed.messageId ?? `no-id-${mailbox}-${uid}`;

  // Dedupe GLOBAL por message_id (não por pasta): quando o provedor move um
  // e-mail entre pastas (ex.: Spam -> INBOX) a ponte o reveria em outra pasta e
  // criaria uma 2ª cópia. Dedupando só por message_id, a 1ª gravação vence.
  const { data: existing } = await supabase
    .from('email_messages')
    .select('id')
    .eq('message_id', messageId)
    .limit(1);

  if (existing && existing.length > 0) {
    logger.debug({ messageId, mailbox }, 'email ja existente, ignorando');
    return false;
  }

  const fromList = addrList(parsed.from);
  const fromAddress = fromList[0]?.address ?? null;

  // anexos -> Storage
  const attachmentsMeta: Array<Record<string, unknown>> = [];
  for (const att of parsed.attachments ?? []) {
    const safeName = (att.filename ?? 'anexo').replace(/[^\w.\-]/g, '_');
    const path = `${mailbox}/${encodeURIComponent(messageId)}/${safeName}`;
    const { error: upErr } = await supabase.storage
      .from(config.attachmentsBucket)
      .upload(path, att.content, {
        contentType: att.contentType,
        upsert: true,
      });
    if (upErr) {
      logger.error({ err: upErr, path }, 'falha ao subir anexo');
    } else {
      attachmentsMeta.push({
        filename: att.filename,
        content_type: att.contentType,
        size: att.size,
        path,
      });
    }
  }

  const row = {
    direction: 'inbound' as const,
    mailbox,
    message_id: messageId,
    in_reply_to: parsed.inReplyTo ?? null,
    email_references: Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : parsed.references ?? null,
    thread_key: parsed.inReplyTo ?? messageId,
    subject: parsed.subject ?? null,
    from_address: fromAddress,
    from_text: addrText(parsed.from),
    to_text: addrText(parsed.to),
    cc_text: addrText(parsed.cc),
    body_text: parsed.text ?? null,
    body_html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments: attachmentsMeta,
    sent_at: parsed.date ? parsed.date.toISOString() : null,
    raw_headers: Object.fromEntries(parsed.headers as Map<string, unknown>),
  };

  const { data: inserted, error } = await supabase
    .from('email_messages')
    .insert(row)
    .select('id, is_spam, spam_reason')
    .single();
  if (error) {
    // 23505 = unique violation (corrida entre processos) -> trata como ja existente
    if ((error as { code?: string }).code === '23505') {
      logger.debug({ messageId }, 'insert colidiu com unique, ja existe');
      return false;
    }
    throw error;
  }

  logger.info({ messageId, from: fromAddress, subject: row.subject, mailbox, fromSpamFolder }, 'email recebido gravado');

  const isHard = HARD_REASON.test(inserted?.spam_reason ?? '');

  // Veio da pasta de Spam/Junk DO SERVIDOR: espelha a classificação — marca como
  // spam no CRM (a não ser que haja veredito duro, ex.: remetente na whitelist).
  // Não roda IA: o provedor já decidiu, e re-classificar poderia "des-spammar".
  if (fromSpamFolder && inserted && !isHard) {
    const { error: upErr } = await supabase
      .from('email_messages')
      .update({
        is_spam: true,
        spam_score: 1,
        spam_reason: 'Marcado como spam pelo servidor de e-mail',
        spam_checked: true,
      })
      .eq('id', inserted.id);
    if (upErr) logger.warn({ err: upErr, id: inserted.id }, 'spam-folder: falha ao marcar spam');
    else logger.info({ id: inserted.id }, 'spam-folder: marcado como spam (espelho do servidor)');
    return true;
  }

  // Refino por IA (DeepSeek): só em casos ambíguos — whitelist/blocklist já decidem.
  if (config.spamAi.enabled && inserted && !isHard) {
    const auth = authSummary(authText(row.raw_headers as Record<string, unknown>));
    const verdict = await classifyWithAi({
      from: fromAddress,
      subject: row.subject,
      bodyText: row.body_text,
      authSummary: auth,
    });
    if (verdict) {
      const { error: upErr } = await supabase
        .from('email_messages')
        .update({
          is_spam: verdict.isSpam,
          spam_score: verdict.score,
          spam_reason: `IA: ${verdict.reason}`,
          spam_checked: true,
        })
        .eq('id', inserted.id);
      if (upErr) logger.warn({ err: upErr, id: inserted.id }, 'spam-ai: falha ao gravar veredito');
      else logger.info({ id: inserted.id, isSpam: verdict.isSpam, score: verdict.score }, 'spam-ai: classificado');
    }
  }

  return true;
}

/** Registra um email enviado para aparecer na mesma thread do CRM. */
export async function storeOutgoing(input: {
  messageId: string;
  subject: string;
  to: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  threadKey?: string;
  senderUserId?: string;
  clientId?: string;
}): Promise<void> {
  const { error } = await supabase.from('email_messages').insert({
    direction: 'outbound',
    mailbox: config.imap.mailbox,
    message_id: input.messageId,
    in_reply_to: input.inReplyTo ?? null,
    thread_key: input.threadKey ?? input.inReplyTo ?? input.messageId,
    subject: input.subject,
    from_address: config.smtp.user,
    from_text: config.smtp.from,
    to_text: input.to,
    body_text: input.bodyText ?? null,
    body_html: input.bodyHtml ?? null,
    sent_at: new Date().toISOString(),
    sender_user_id: input.senderUserId ?? null,
    client_id: input.clientId ?? null,
  });
  if (error) logger.error({ err: error }, 'falha ao gravar email enviado');
}
