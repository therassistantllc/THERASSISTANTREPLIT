-- Task #459: Let clients self-update their insurance from a secure link.
--
-- Adds cob_client_update_links: one-time tokenized links the biller can
-- send (via email) when they route a COB-flagged claim back to the
-- client. Modeled on portal_invites / intake_links:
--   * token is unique, base64url, generated server-side
--   * expires_at defaults to a short lifespan (7 days)
--   * status follows pending -> completed | expired | revoked
--   * delivery_* columns track the email send result so billers can see
--     whether the message actually reached the client.
--
-- Submission flow: client opens /cob-update/<token>, confirms primary /
-- secondary order, answers "do you have other coverage?", optionally
-- uploads a card photo. The POST endpoint flips the link to 'completed'
-- and writes a `cob_client_update_received` audit row so the COB queue
-- reducer in app/api/billing/cob-issues/route.ts marks the claim
-- resolved automatically.

create table if not exists public.cob_client_update_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  submission_payload jsonb,
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

create index if not exists idx_cob_client_update_links_org_claim
  on public.cob_client_update_links (organization_id, claim_id, created_at desc);

create index if not exists idx_cob_client_update_links_org_client
  on public.cob_client_update_links (organization_id, client_id, created_at desc);

create index if not exists idx_cob_client_update_links_token
  on public.cob_client_update_links (token);

alter table public.cob_client_update_links enable row level security;

drop policy if exists cob_client_update_links_org_policy on public.cob_client_update_links;
create policy cob_client_update_links_org_policy on public.cob_client_update_links
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
