-- ============================================================================
-- Migration: 20260601000000_billing_code_tables_updated_at.sql
-- Purpose:   Add an `updated_at` column + before-update trigger to the
--            diagnosis_codes and procedure_codes reference tables so the
--            scheduled code-set refresh records when each code was last
--            touched. Used by the in-app "Code Sets" freshness panel
--            (Task #197) to show billers when each code system was last
--            loaded and to flag stale releases.
-- ============================================================================

alter table public.diagnosis_codes
  add column if not exists updated_at timestamptz not null default now();

alter table public.procedure_codes
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.tg_billing_code_tables_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_diagnosis_codes_touch_updated_at on public.diagnosis_codes;
create trigger trg_diagnosis_codes_touch_updated_at
  before update on public.diagnosis_codes
  for each row
  execute function public.tg_billing_code_tables_touch_updated_at();

drop trigger if exists trg_procedure_codes_touch_updated_at on public.procedure_codes;
create trigger trg_procedure_codes_touch_updated_at
  before update on public.procedure_codes
  for each row
  execute function public.tg_billing_code_tables_touch_updated_at();

-- Backfill existing rows so the freshness panel doesn't show every row
-- as "loaded just now" right after the migration runs.
update public.diagnosis_codes set updated_at = created_at where updated_at <> created_at;
update public.procedure_codes set updated_at = created_at where updated_at <> created_at;

select pg_notify('pgrst', 'reload schema');
