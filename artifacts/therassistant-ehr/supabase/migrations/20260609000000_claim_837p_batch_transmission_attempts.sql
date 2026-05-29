-- Task #442: Per-attempt transmission history for 837P batches.
--
-- Until now, the batches row only kept the LATEST attempt's metadata
-- (last_submission_endpoint, last_submission_http_status, attempt_count).
-- Billers triaging recurring failures need to see every attempt — when
-- it happened, where it went, what came back — to spot patterns like
-- five 502s in a row at 2 AM. This table captures one row per outbound
-- submission attempt, written by the submit route on both success and
-- failure paths.

create extension if not exists pgcrypto;

create table if not exists public.claim_837p_batch_transmission_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.claim_837p_batches(id) on delete cascade,
  attempt_number integer not null,
  attempted_at timestamptz not null default now(),
  endpoint text,
  http_status integer,
  idempotency_key text,
  external_transaction_id text,
  outcome text not null check (outcome in ('success','failure')),
  error_message text,
  response_excerpt text,
  actor_user_id uuid references auth.users(id),
  actor_display_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_837p_batch_tx_attempts_batch
  on public.claim_837p_batch_transmission_attempts (batch_id, attempted_at desc);

create index if not exists idx_837p_batch_tx_attempts_org
  on public.claim_837p_batch_transmission_attempts (organization_id, attempted_at desc);

select pg_notify('pgrst', 'reload schema');
