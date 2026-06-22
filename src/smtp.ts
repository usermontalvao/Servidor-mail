import nodemailer from 'nodemailer';
import { config } from './config.js';
import { logger } from './logger.js';

export const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.password,
  },
});

export interface SendInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: Array<{
    filename: string;
    content: string; // base64
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const info = await transporter.sendMail({
    from: config.smtp.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType,
    })),
  });

  logger.info({ messageId: info.messageId, accepted: info.accepted }, 'email enviado');

  return {
    messageId: info.messageId,
    accepted: (info.accepted as string[]) ?? [],
    rejected: (info.rejected as string[]) ?? [],
  };
}

export async function verifySmtp(): Promise<void> {
  await transporter.verify();
  logger.info('SMTP verificado com sucesso');
}
