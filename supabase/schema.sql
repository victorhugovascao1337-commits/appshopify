-- Painel Contingência — esquema do banco (Supabase / Postgres)
-- Rode isto uma vez no Supabase: Dashboard → SQL Editor → New query → cole → Run.

-- Guarda os documentos do painel: lojas (com token criptografado), flow, automatch e pós-compra.
create table if not exists public.app_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- SEGURANÇA: esta tabela guarda os tokens da Shopify.
-- Com RLS ligado e nenhuma policy criada, a chave pública (anon) não lê nada.
-- O painel acessa pelo servidor com a service_role key, que ignora RLS de propósito.
alter table public.app_state enable row level security;

revoke all on public.app_state from anon;
revoke all on public.app_state from authenticated;
