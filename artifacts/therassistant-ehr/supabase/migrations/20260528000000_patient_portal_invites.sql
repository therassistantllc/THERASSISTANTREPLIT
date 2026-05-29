-- Migration: 20260528000000_patient_portal_invites.sql
-- Purpose: Patient portal invite/access tokens. Adds portal_status to clients
--          and creates portal_invites (one-time tokens with delivery tracking)
--          so staff can send/resend portal access invitations from the chart.

alter table public.clients
  add column if not exists portal_status text
    check (portal_status in ('not_invited', 'invited', 'active', 'revoked'))
    default 'not_invited';

create table if not exists public.portal_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivery_method text
    check (delivery_method in ('clipboard', 'email'))
    default 'clipboard',
  delivered_to_email text,
  delivered_at timestamptz,
  delivery_error text,
  delivery_provider_id text,
  delivery_status text
    check (delivery_status in ('pending', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  delivery_status_at timestamptz
);

create index if not exists idx_portal_invites_org_client
  on public.portal_invites (organization_id, client_id, created_at desc);

create index if not exists idx_portal_invites_token
  on public.portal_invites (token);

alter table public.portal_invites enable row level security;

drop policy if exists portal_invites_org_policy on public.portal_invites;
create policy portal_invites_org_policy on public.portal_invites
  for all to authenticated
  using (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  )
  with check (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

select pg_notify('pgrst', 'reload schema');
