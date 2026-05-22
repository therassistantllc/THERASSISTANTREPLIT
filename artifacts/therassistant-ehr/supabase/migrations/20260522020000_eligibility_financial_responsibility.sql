-- Phase 5 (CAQH CORE Eligibility & Benefits Data Content Rule vEB.2.1
-- §1.3.2.5–§1.3.2.13): make patient financial responsibility, telemedicine
-- coverage, authorization requirements, tiered benefits, and max/remaining
-- coverage queryable.
--
-- IMPORTANT: `public.eligibility_benefit_segments` already exists (created
-- by `20260505030000_office_ally_response_schemas.sql`) with legacy
-- columns: benefit_information_code, percent_amount,
-- authorization_or_certification_required, in_plan_network_indicator,
-- raw_eb_segment, client_id, payer_id, payer_name, service_type_code,
-- service_type_description, benefit_description, messages,
-- eligibility_date_from/_to, archived_at. We ADD the Phase 5
-- categorization columns to the existing table — we do NOT create a new
-- one — so both the X12 path (ClearinghouseService) and the Coverages
-- JSON path (AvailityJsonApiAdapter) share one canonical table.

alter table if exists public.eligibility_checks
  add column if not exists out_of_pocket_total numeric,
  add column if not exists telemedicine_covered boolean,
  add column if not exists authorization_required boolean,
  add column if not exists benefit_tier text,
  add column if not exists max_coverage_amount numeric,
  add column if not exists max_coverage_period text,
  add column if not exists remaining_coverage_amount numeric,
  add column if not exists remaining_coverage_period text;

alter table if exists public.eligibility_requests
  add column if not exists out_of_pocket_total numeric,
  add column if not exists telemedicine_covered boolean,
  add column if not exists authorization_required boolean,
  add column if not exists benefit_tier text;

comment on column public.eligibility_checks.out_of_pocket_total is
  'Plan out-of-pocket maximum from EB01=G when not flagged remaining (CORE Data Content Rule §1.3.2.7).';
comment on column public.eligibility_checks.telemedicine_covered is
  'True when the payer returned an EB / III / MSG segment indicating telemedicine is a covered benefit (CORE Data Content Rule §1.3.2.10).';
comment on column public.eligibility_checks.authorization_required is
  'EB11 Authorization or Certification Indicator rolled up across returned benefits (CORE Data Content Rule §1.3.2.11). True when any benefit requires auth.';
comment on column public.eligibility_checks.benefit_tier is
  'Tiered benefit level when the payer returned distinct EB segments per tier (CORE Data Content Rule §1.3.2.12).';
comment on column public.eligibility_checks.max_coverage_amount is
  'Headline maximum coverage benefit dollars (CORE Data Content Rule §1.3.2.13, Appendix Table 2).';
comment on column public.eligibility_checks.max_coverage_period is
  'Time period qualifier (EB06) the max coverage applies to — e.g. calendar_year, service_year, episode, visit, lifetime.';
comment on column public.eligibility_checks.remaining_coverage_amount is
  'Headline remaining coverage benefit dollars (CORE Data Content Rule §1.3.2.13, Appendix Table 3).';
comment on column public.eligibility_checks.remaining_coverage_period is
  'Time period qualifier (EB06) for remaining coverage — e.g. calendar_year, service_year, episode, visit, lifetime_remaining.';

-- Phase 5 categorization columns on the existing per-benefit table.
alter table if exists public.eligibility_benefit_segments
  add column if not exists segment_index integer,
  add column if not exists category text,
  add column if not exists is_remaining boolean not null default false,
  add column if not exists is_in_network boolean,
  add column if not exists benefit_tier text,
  add column if not exists telemedicine_flag boolean,
  add column if not exists message_text text;

-- Allowed category values per CORE Data Content Rule §1.3.2.5–§1.3.2.13.
-- Drop-then-add the check so re-running this migration in a partially
-- applied environment converges cleanly.
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public'
       and table_name = 'eligibility_benefit_segments'
       and constraint_name = 'eligibility_benefit_segments_category_check'
  ) then
    alter table public.eligibility_benefit_segments
      drop constraint eligibility_benefit_segments_category_check;
  end if;
end $$;

alter table public.eligibility_benefit_segments
  add constraint eligibility_benefit_segments_category_check check (
    category is null or category in (
      'active_coverage',
      'inactive_coverage',
      'copay',
      'coinsurance',
      'deductible',
      'out_of_pocket',
      'limitation',
      'exclusion',
      'non_covered',
      'max_coverage',
      'remaining_coverage',
      'telemedicine',
      'authorization',
      'benefit_description',
      'other'
    )
  );

create index if not exists idx_eligibility_benefit_segments_category
  on public.eligibility_benefit_segments (organization_id, category)
  where archived_at is null;

comment on column public.eligibility_benefit_segments.category is
  'CORE Data Content Rule categorization of this EB segment. Computed at parse time from EB01 + QTY + MSG context.';
comment on column public.eligibility_benefit_segments.is_remaining is
  'True when this benefit represents a remaining balance (EB06=29, EB09=29, or attached MSG says REMAINING). Used to split base vs remaining deductible/OOP/coverage.';
comment on column public.eligibility_benefit_segments.telemedicine_flag is
  'True when an EB/III/MSG attached to this segment identifies telemedicine.';
comment on column public.eligibility_benefit_segments.benefit_tier is
  'Detected tier label (e.g. "Tier 1") parsed from EB05 plan description or attached MSG.';
