-- Phase 3 (270/271 real-time eligibility): persist the X12 271 EB02
-- coverage-level code (e.g. individual, family, employee+spouse) alongside
-- copay/deductible so UI summary cards can render it. Column is nullable
-- so older check rows keep working unchanged.
alter table if exists public.eligibility_checks
  add column if not exists coverage_level text;

-- The latest-eligibility read path reads from eligibility_requests on some
-- deployments, so mirror the column there too.
alter table if exists public.eligibility_requests
  add column if not exists coverage_level text;
