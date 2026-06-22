import type { ParsedMail, AddressObject } from 'mailparser';
import { supabase } from './supabase.js';
import { config } from './config.js';
import { logger } from './logger.js';

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
export async function storeIncoming(parsed: ParsedMail, uid: number): Promise<boolean> {
  const messageId = parsed.messageId ?? `no-id-${config.imap.mailbox}-${uid}`;

  // dedupe explicito (alem do indice unico) para evitar reprocessar anexos
  const { data: existing } = await supabase
    .from('email_messages')
    .select('id')
    .eq('mailbox', config.imap.mailbox)
    .eq('message_id', messageId)
    .maybeSingle();

  if (existing) {
    logger.debug({ messageId }, 'email ja existente, ignorando');
    return false;
  }

  const fromList = addrList(parsed.from);
  const fromAddress = fromList[0]?.address ?? null;

  // anexos -> Storage
  const attachmentsMeta: Array<Record<string, unknown>> = [];
  for (const att of parsed.attachments ?? []) {
    const safeName = (att.filename ?? 'anexo').replace(/[^\w.\-]/g, '_');
    const path = `${config.imap.mailbox}/${encodeURIComponent(messageId)}/${safeName}`;
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
    mailbox: config.imap.mailbox,
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

  const { error } = await supabase.from('email_messages').insert(row);
  if (error) {
    // 23505 = unique violation (corrida entre processos) -> trata como ja existente
    if ((error as { code?: string }).code === '23505') {
      logger.debug({ messageId }, 'insert colidiu com unique, ja existe');
      return false;
    }
    throw error;
  }

  logger.info({ messageId, from: fromAddress, subject: row.subject }, 'email recebido gravado');
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
