import { config } from './config.js';
import { logger } from './logger.js';

export interface AiVerdict {
  isSpam: boolean;
  score: number;   // 0..1
  reason: string;  // PT-BR curto
}

export interface AiInput {
  from: string | null;
  subject: string | null;
  bodyText: string | null;
  authSummary: string; // ex.: "spf=pass dkim=pass dmarc=pass"
}

const SYSTEM = `Você é um filtro antispam de uma caixa de email de um escritório de advocacia no Brasil.
Classifique a mensagem como spam ou legítima. Seja CONSERVADOR: só marque como spam quando houver sinais claros
(golpe/phishing, propaganda em massa não solicitada, cobrança falsa, prêmio/sorteio, conteúdo adulto, malware).
Emails de tribunais, clientes, bancos legítimos, notas fiscais, intimações e comunicações profissionais NÃO são spam.
Responda APENAS com um JSON válido, sem texto extra, no formato:
{"is_spam": boolean, "score": number entre 0 e 1, "reason": "motivo curto em português"}`;

function extractJson(text: string): AiVerdict | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    const score = Math.max(0, Math.min(1, Number(obj.score)));
    return {
      isSpam: Boolean(obj.is_spam),
      score: Number.isFinite(score) ? score : (obj.is_spam ? 0.9 : 0.1),
      reason: String(obj.reason ?? '').slice(0, 200),
    };
  } catch {
    return null;
  }
}

/** Classifica via IA (DeepSeek). Retorna null em falha (mantém veredito determinístico). */
export async function classifyWithAi(input: AiInput): Promise<AiVerdict | null> {
  if (!config.spamAi.enabled) return null;

  const body = (input.bodyText ?? '').replace(/\s+/g, ' ').slice(0, 2500);
  const userMsg =
    `De: ${input.from ?? '(desconhecido)'}\n` +
    `Autenticação: ${input.authSummary || '(sem dados)'}\n` +
    `Assunto: ${input.subject ?? '(sem assunto)'}\n\n` +
    `Corpo:\n${body || '(vazio)'}`;

  try {
    const res = await fetch(config.spamAi.proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // service role é um JWT válido -> passa no verify_jwt do proxy
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // mapeado para deepseek-chat no proxy
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'spam-ai: proxy retornou erro');
      return null;
    }
    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const verdict = extractJson(content);
    if (!verdict) logger.warn({ content: content.slice(0, 200) }, 'spam-ai: resposta sem JSON válido');
    return verdict;
  } catch (err) {
    logger.warn({ err }, 'spam-ai: falha ao classificar');
    return null;
  }
}
