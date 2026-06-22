# email-bridge

Ponte de email para o CRM. **Não** hospeda caixas postais — conecta na caixa que
já existe (Hostinger) via IMAP/SMTP, persiste tudo no Supabase e expõe uma API
HTTP de envio para o CRM consumir.

```
CRM / edge function  --POST /send-->  email-bridge  --SMTP-->  Hostinger
                                            |
Hostinger  --IMAP IDLE-->  email-bridge ----+---> Supabase (email_messages + Storage)
```

## Componentes

| Arquivo            | Papel                                                        |
|--------------------|-------------------------------------------------------------|
| `src/imap.ts`      | Conecta no IMAP, escuta novas mensagens (IDLE), reconecta    |
| `src/store.ts`     | Persiste no Supabase (dedupe por message_id) + anexos no Storage |
| `src/smtp.ts`      | Envio via SMTP (nodemailer)                                  |
| `src/server.ts`    | API HTTP: `POST /send` (auth por Bearer token) e `GET /health` |
| `sql/001_email_schema.sql` | Tabela `email_messages`, índices, RLS               |

## Deploy via Portainer (Git)

1. Suba este diretório como um **repositório Git novo** (GitHub/GitLab privado).
2. No Portainer: **Stacks → Add stack → Git repository**, aponte para o repo,
   `Compose path` = `docker-compose.yml`.
3. Em **Environment variables**, preencha as vars do `.env.example`
   (segredos ficam só aqui, nunca no repo).
4. Deploy. Para atualizar: `git push` + redeploy (ou ative o webhook do Portainer).

## Acesso via Cloudflare Tunnel

O container publica no host na porta **`HOST_PORT`** (padrão `8084`; evite 9000/8080/8082/8083
que já estão em uso). Adicione uma rota no tunnel:

```
email.jurius-api.com  ->  http://localhost:8084
```

A `/send` exige `Authorization: Bearer <BRIDGE_API_TOKEN>`, então é seguro expor publicamente.
O recebimento IMAP é uma conexão de SAÍDA do container — não precisa de rota de entrada.

## Banco

Rode `sql/001_email_schema.sql` no Supabase e crie o bucket privado
`email-attachments` no Storage.

## Enviar email (do CRM / edge function)

```http
POST https://email.jurius-api.com/send
Authorization: Bearer <BRIDGE_API_TOKEN>
Content-Type: application/json

{
  "to": "cliente@exemplo.com",
  "subject": "Assunto",
  "html": "<p>Olá</p>",
  "clientId": "uuid-opcional",
  "senderUserId": "uuid-opcional",
  "inReplyTo": "<id-da-msg-original>"
}
```

## Dev local

```bash
npm install
cp .env.example .env   # preencha
npm run dev
```
