-- Client import traceability and promotion bookkeeping
-- Adds external source ID lineage and promotion diagnostics for backend-only import workflows.

alter table if exists public.client_import_jobs
  add column if not exists promotion_summary jsonb;

alter table if exists public.client_import_rows
  add column if not exists source_client_id text,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_strategy text,
  add column if not exists promoted_policy_id uuid,
  add column if not exists promotion_error text;

create index if not exists idx_client_import_rows_source_client_id
  on public.client_import_rows (source_client_id);

create index if not exists idx_client_import_rows_promoted_policy_id
  on public.client_import_rows (promoted_policy_id);

comment on column public.client_import_jobs.promotion_summary is
  'Aggregate promotion outcomes: total/valid/invalid/duplicates/promoted/skipped/failed.';

comment on column public.client_import_rows.source_client_id is
  'External source-system client identifier extracted from mapped import row.';

comment on column public.client_import_rows.duplicate_reason is
  'Human-readable explanation for duplicate classification.';

comment on column public.client_import_rows.duplicate_strategy is
  'Duplicate strategy used: source_client_id or name_dob.';

comment on column public.client_import_rows.promoted_policy_id is
  'Primary insurance policy id created/linked during promotion.';

comment on column public.client_import_rows.promotion_error is
  'Terminal row-level promotion error message when import_status=failed.';
