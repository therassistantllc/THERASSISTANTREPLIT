-- Payer-specific handling rules. Two entry points write here:
--
--   1. Denials-by-RARC workqueue / POST /api/billing/payer-rules
--      ("When Aetna returns RARC M25, attach the treatment plan and
--      resubmit") — informational guidance keyed by (payer, RARC, CARC),
--      surfaced as notes on claims and editable from the admin
--      payer-rules surface.
--
--   2. Task #466 — Denied Claims by CARC "Create payer rule" / promote
--      proposal. Writes auto-flagging rules consumed by the
--      pre-submission Claim Content Validation engine
--      (lib/validation/claim/runClaimContentValidation.ts), which emits
--      a finding per active rule for the claim's payer. `action='warn'`
--      flags the claim; `action='block'` blocks submission via the
--      readiness gate.
--
-- Both entry points share one table so the admin surface can list,
-- edit, and archive rules from either source. Distinct from
-- `payer_profiles.billing_rules` (a small set of well-typed payer
-- requirements like allowed POS / denied CPT / timely-filing).

create table if not exists public.payer_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Nullable to allow "any payer" rules from the denials-by-RARC flow;
  -- Task #466 rules always populate it.
  payer_profile_id uuid references public.payer_profiles(id) on delete set null,
  payer_name text,
  rarc_code text,
  carc_code text,
  rule text not null,
  recommended_action text,
  source text not null default 'denials_by_rarc',
  -- Task #466 auto-flagging fields. `action` controls severity emitted
  -- by the validation engine; `status` keeps archived rules from
  -- firing without losing history. `pending_approval` reserved for a
  -- future review workflow.
  action text not null default 'warn',
  status text not null default 'active',
  source_alert_id uuid references public.billing_alerts(id) on delete set null,
  source_claim_id uuid references public.professional_claims(id) on delete set null,
  created_by_user_id uuid references auth.users(id),
  updated_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint payer_rules_action_chk check (action in ('warn', 'block')),
  constraint payer_rules_status_chk check (status in ('active', 'pending_approval', 'archived'))
);

create index if not exists idx_payer_rules_org
  on public.payer_rules (organization_id, updated_at desc)
  where archived_at is null;

create index if not exists idx_payer_rules_lookup
  on public.payer_rules (organization_id, rarc_code, carc_code, payer_name)
  where archived_at is null;

-- Deterministic upsert key for the denials-by-RARC flow: one active
-- rule per (org, payer-label, rarc, carc) tuple. NULLs collapse so an
-- "any payer" rule and a payer-specific rule are distinct rows.
create unique index if not exists payer_rules_unique_active
  on public.payer_rules (
    organization_id,
    coalesce(lower(payer_name), ''),
    coalesce(upper(rarc_code), ''),
    coalesce(upper(carc_code), '')
  )
  where archived_at is null;

-- Task #466 lookup index: the validation engine joins active auto-
-- flagging rules by (org, payer_profile_id) on every per-claim run.
create index if not exists idx_payer_rules_org_payer_active
  on public.payer_rules (organization_id, payer_profile_id)
  where status = 'active' and archived_at is null;

create index if not exists idx_payer_rules_source_alert
  on public.payer_rules (source_alert_id)
  where source_alert_id is not null;

alter table public.payer_rules enable row level security;

drop policy if exists "payer_rules_tenant" on public.payer_rules;
create policy "payer_rules_tenant" on public.payer_rules
  for all using (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  );

create or replace function public.payer_rules_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payer_rules_set_updated_at on public.payer_rules;
create trigger payer_rules_set_updated_at
  before update on public.payer_rules
  for each row execute function public.payer_rules_touch_updated_at();

grant select, insert, update, delete on public.payer_rules
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
