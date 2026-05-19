-- File: supabase/migrations/20260514000000_ehr_completion_patches.sql
-- Purpose: Finish minimum end-to-end claim flow setup for THERASSISTANT EHR.
--   1. encounter_id FK on professional_claims
--   2. billing/rendering provider taxonomy on claim_parties_snapshot
--   3. audit_logs full Medplum-style columns
--   4. eligibility_service_type_code on clearinghouse_connections
--   5. workqueue aging-bucket and billing work_type catalog
--   6. era_mismatch and recoupment workqueue items table
--   7. RLS policies and indexes for all new columns

create extension if not exists pgcrypto;

-- ─── 1. professional_claims: add encounter_id ────────────────────────────────
alter table public.professional_claims
  add column if not exists encounter_id uuid references public.encounters(id) on delete set null;

create index if not exists idx_professional_claims_encounter_id
  on public.professional_claims (encounter_id)
  where encounter_id is not null;

-- ─── 2. claim_parties_snapshot: add taxonomy columns ─────────────────────────
alter table public.claim_parties_snapshot
  add column if not exists billing_provider_taxonomy text,
  add column if not exists rendering_provider_taxonomy text;

-- ─── 3. audit_logs: add full Medplum-style columns ───────────────────────────
-- Existing columns: id, organization_id, patient_id, appointment_id,
--   encounter_id, claim_id, clinical_note_id, workqueue_item_id,
--   event_type, event_summary, event_metadata, created_at
alter table public.audit_logs
  add column if not exists user_id uuid,
  add column if not exists user_role text,
  add column if not exists action text,
  add column if not exists object_type text,
  add column if not exists object_id uuid,
  add column if not exists before_value jsonb,
  add column if not exists after_value jsonb;

create index if not exists idx_audit_logs_org_object
  on public.audit_logs (organization_id, object_type, object_id, created_at desc)
  where organization_id is not null;

create index if not exists idx_audit_logs_user_id
  on public.audit_logs (user_id, created_at desc)
  where user_id is not null;

-- ─── 4. clearinghouse_connections: eligibility service type ──────────────────
alter table public.clearinghouse_connections
  add column if not exists eligibility_service_type_code text not null default '98',
  add column if not exists eligibility_transaction_set text not null default '270';

comment on column public.clearinghouse_connections.eligibility_service_type_code
  is 'X12 270 service type code. 98 = Health Benefit Plan Coverage (default for Office Ally).';

-- ─── 5. workqueue_items: add work_type_catalog table ─────────────────────────
-- Catalog table for allowed work_type values with AR-aging bucket metadata.
create table if not exists public.workqueue_type_catalog (
  work_type text primary key,
  label text not null,
  category text not null check (category in ('ar_aging', 'payer_response', 'eligibility', 'billing', 'era', 'admin')),
  aging_days_min integer,
  aging_days_max integer,
  sort_order integer not null default 99,
  is_active boolean not null default true
);

insert into public.workqueue_type_catalog (work_type, label, category, aging_days_min, aging_days_max, sort_order) values
  ('no_response',            'No Response',               'ar_aging',       null, null,  1),
  ('aging_0_30',             'AR 0–30 Days',              'ar_aging',          0,   30,  2),
  ('aging_31_60',            'AR 31–60 Days',             'ar_aging',         31,   60,  3),
  ('aging_61_90',            'AR 61–90 Days',             'ar_aging',         61,   90,  4),
  ('aging_91_120',           'AR 91–120 Days',            'ar_aging',         91,  120,  5),
  ('aging_120_plus',         'AR 120+ Days',              'ar_aging',        121, null,  6),
  ('denied',                 'Denial',                    'payer_response', null, null,  7),
  ('clearinghouse_rejection','Clearinghouse Rejection',   'payer_response', null, null,  8),
  ('payer_rejection',        'Payer Rejection',           'payer_response', null, null,  9),
  ('eligibility_issue',      'Eligibility Issue',         'eligibility',    null, null, 10),
  ('eligibility_needed',     'Eligibility Needed',        'eligibility',    null, null, 11),
  ('era_mismatch',           'ERA Mismatch',              'era',            null, null, 12),
  ('era_unmatched_claim',    'ERA Unmatched Claim',       'era',            null, null, 13),
  ('era_recoupment_review',  'ERA Recoupment Review',     'era',            null, null, 14),
  ('appeal_needed',          'Appeal Needed',             'payer_response', null, null, 15),
  ('recoupment',             'Recoupment',                'payer_response', null, null, 16),
  ('ready_to_bill',          'Ready to Bill',             'billing',        null, null, 17),
  ('biller_review',          'Biller Review',             'billing',        null, null, 18)
on conflict (work_type) do nothing;

-- ─── 6. workqueue_items: add work_type FK (soft constraint via catalog) ───────
-- We use a comment-style approach because existing data may have text values
-- not yet in the catalog. The catalog is the authoritative reference.
comment on column public.workqueue_items.work_type
  is 'References workqueue_type_catalog.work_type. Valid values: no_response, aging_0_30, aging_31_60, aging_61_90, aging_91_120, aging_120_plus, denied, clearinghouse_rejection, payer_rejection, eligibility_issue, eligibility_needed, era_mismatch, appeal_needed, recoupment, ready_to_bill, biller_review.';

-- Add a work_type filter index for AR aging queries
do $$
begin
  if to_regclass('public.workqueue_items') is not null then
    create index if not exists idx_workqueue_items_open_work_type_claim
      on public.workqueue_items (organization_id, work_type, claim_id, created_at desc)
      where archived_at is null and status in ('open', 'in_progress', 'blocked');
  end if;
end $$;

-- ─── 7. RLS on workqueue_type_catalog (public read) ──────────────────────────
alter table public.workqueue_type_catalog enable row level security;

drop policy if exists workqueue_type_catalog_read_policy on public.workqueue_type_catalog;
create policy workqueue_type_catalog_read_policy
  on public.workqueue_type_catalog
  for select
  to authenticated
  using (true);

-- ─── 8. Backfill: link existing professional_claims to encounters ─────────────
-- Use charge_capture_items as the bridge (encounter_id → charge → claim_id).
update public.professional_claims pc
set encounter_id = cci.encounter_id
from public.charge_capture_items cci
where cci.claim_id = pc.id
  and pc.encounter_id is null
  and cci.encounter_id is not null;

-- ─── 9. RLS on audit_logs: scoped to organization ────────────────────────────
-- Only apply if RLS is not already enabled (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'audit_logs' and c.relrowsecurity = true
  ) then
    execute 'alter table public.audit_logs enable row level security';
  end if;
end $$;

drop policy if exists audit_logs_org_policy on public.audit_logs;
create policy audit_logs_org_policy
  on public.audit_logs
  for all
  to authenticated
  using (
    organization_id is null or
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

-- ─── 10. workqueue_items: add professional_claim_id FK ───────────────────────
-- Separate from legacy claim_id which references public.claims.
-- All services that create items for professional claims write here; legacy
-- modules that create items for public.claims continue to write claim_id only.
alter table public.workqueue_items
  add column if not exists professional_claim_id uuid
    references public.professional_claims(id) on delete set null;

do $$
begin
  if to_regclass('public.workqueue_items') is not null then
    create index if not exists idx_workqueue_items_professional_claim_id
      on public.workqueue_items (organization_id, professional_claim_id)
      where professional_claim_id is not null;
  end if;
end $$;

comment on column public.workqueue_items.professional_claim_id
  is 'FK to professional_claims.id. Set by billing-flow services (aging, ERA, rejection). '
     'Distinct from legacy claim_id which references public.claims (workflow engine).';

select pg_notify('pgrst', 'reload schema');
