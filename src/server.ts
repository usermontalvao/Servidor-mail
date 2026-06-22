import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { sendEmail, type SendInput } from './smtp.js';
import { storeOutgoing } from './store.js';

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Health check (sem auth) para o Portainer/healthcheck
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Auth simples por bearer token compartilhado com o CRM/edge function
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== config.apiToken) {
      return res.status(401).json({ error: 'nao autorizado' });
    }
    next();
  };

  // Envio de email
  app.post('/send', auth, async (req: Request, res: Response) => {
    const body = req.body as SendInput & {
      senderUserId?: string;
      clientId?: string;
      threadKey?: string;
    };

    if (!body.to || !body.subject || (!body.text && !body.html)) {
      return res
        .status(400)
        .json({ error: 'campos obrigatorios: to, subject e (text ou html)' });
    }

    try {
      const result = await sendEmail(body);
      await storeOutgoing({
        messageId: result.messageId,
        subject: body.subject,
        to: Array.isArray(body.to) ? body.to.join(', ') : body.to,
        bodyText: body.text,
        bodyHtml: body.html,
        inReplyTo: body.inReplyTo,
        threadKey: body.threadKey,
        senderUserId: body.senderUserId,
        clientId: body.clientId,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'falha no envio');
      res.status(502).json({ error: 'falha ao enviar email' });
    }
  });

  return app;
}
