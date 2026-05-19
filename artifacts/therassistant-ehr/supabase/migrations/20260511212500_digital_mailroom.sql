create extension if not exists pgcrypto;

create table if not exists public.mailroom_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  uploaded_by_user_id uuid,
  assigned_to_user_id uuid,
  mail_status text not null default 'unsorted' check (
    mail_status in ('unsorted', 'pending_action', 'filed', 'archived', 'voided')
  ),
  priority text not null default 'normal' check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  document_type text not null default 'payer_notice' check (
    document_type in ('paper_eob', 'payer_notice', 'refund_request', 'credentialing_notice', 'client_document', 'practice_document', 'other')
  ),
  title text not null,
  sender_name text,
  payer_name text,
  received_date date,
  notes text,
  file_name text,
  file_mime_type text,
  file_size_bytes integer,
  storage_bucket text,
  storage_path text,
  filed_location text check (filed_location in ('client_chart', 'practice_documents') or filed_location is null),
  filed_at timestamptz,
  filed_by_user_id uuid,
  resolved_at timestamptz,
  resolved_by_user_id uuid,
  handling_audit jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_mailroom_items_status
  on public.mailroom_items (organization_id, mail_status, created_at desc)
  where archived_at is null;

create index if not exists idx_mailroom_items_client
  on public.mailroom_items (organization_id, client_id, created_at desc)
  where archived_at is null;

create index if not exists idx_mailroom_items_type
  on public.mailroom_items (organization_id, document_type, created_at desc)
  where archived_at is null;

alter table public.mailroom_items enable row level security;

drop policy if exists mailroom_items_org_policy on public.mailroom_items;
create policy mailroom_items_org_policy
  on public.mailroom_items
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

select pg_notify('pgrst', 'reload schema');
