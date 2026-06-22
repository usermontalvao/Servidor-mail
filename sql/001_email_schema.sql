-- Schema do modulo de Email para o CRM.
-- Rode no Supabase (SQL Editor ou migration). Revise as policies de RLS
-- conforme seu padrao de seguranca (anon revogado; acesso so authenticated).

create table if not exists public.email_messages (
  id              uuid primary key default gen_random_uuid(),
  direction       text not null check (direction in ('inbound', 'outbound')),
  mailbox         text not null default 'INBOX',
  message_id      text not null,
  in_reply_to     text,
  email_references text,
  thread_key      text,
  subject         text,
  from_address    text,
  from_text       text,
  to_text         text,
  cc_text         text,
  body_text       text,
  body_html       text,
  attachments     jsonb not null default '[]'::jsonb,
  raw_headers     jsonb,
  sent_at         timestamptz,
  -- vinculos com o CRM
  client_id       uuid references public.clients(id) on delete set null,
  sender_user_id  uuid,
  -- caixa compartilhada (igual ao WhatsApp)
  assigned_user_id uuid,
  is_read         boolean not null default false,
  created_at      timestamptz not null default now()
);

-- idempotencia do recebimento: nao duplica a mesma mensagem na mesma caixa
create unique index if not exists uq_email_messages_mailbox_msgid
  on public.email_messages (mailbox, message_id);

create index if not exists idx_email_messages_thread on public.email_messages (thread_key);
create index if not exists idx_email_messages_client on public.email_messages (client_id);
create index if not exists idx_email_messages_from on public.email_messages (from_address);
create index if not exists idx_email_messages_sent_at on public.email_messages (sent_at desc);

alter table public.email_messages enable row level security;

-- Leitura/escrita apenas para usuarios autenticados (staff).
-- A service-role do container bypassa RLS automaticamente.
drop policy if exists email_messages_select_authenticated on public.email_messages;
create policy email_messages_select_authenticated
  on public.email_messages for select
  to authenticated
  using (true);

drop policy if exists email_messages_update_authenticated on public.email_messages;
create policy email_messages_update_authenticated
  on public.email_messages for update
  to authenticated
  using (true)
  with check (true);

-- anon nao tem acesso (coerente com a auditoria de seguranca).
revoke all on public.email_messages from anon;

-- Bucket de anexos (criar no Storage; privado).
-- insert into storage.buckets (id, name, public) values
--   ('email-attachments', 'email-attachments', false)
-- on conflict (id) do nothing;
