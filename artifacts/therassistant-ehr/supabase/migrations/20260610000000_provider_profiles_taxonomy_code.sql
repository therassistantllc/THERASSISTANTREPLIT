-- Add a real NUCC taxonomy_code column to provider_profiles so the
-- Provider Enrollment Issues workqueue and the 837P writer stop treating
-- `specialty` / `provider_type` as a stand-in. NUCC taxonomy codes are
-- exactly 10 characters: 9 alphanumeric + a trailing 'X'.
--
-- We backfill from the existing specialty/provider_type columns ONLY when
-- the legacy value already happens to be a valid NUCC code; otherwise the
-- new column stays NULL so the enrollment workqueue surfaces it as a real
-- "taxonomy_issue" instead of silently using a non-NUCC string.

alter table public.provider_profiles
  add column if not exists taxonomy_code text;

-- Normalize any pre-existing data to uppercase before applying the CHECK.
update public.provider_profiles
   set taxonomy_code = upper(taxonomy_code)
 where taxonomy_code is not null
   and taxonomy_code <> upper(taxonomy_code);

-- Backfill from specialty / provider_type when those legacy values are
-- already valid NUCC taxonomy codes (10 chars, end in X).
update public.provider_profiles
   set taxonomy_code = upper(specialty)
 where taxonomy_code is null
   and specialty is not null
   and upper(specialty) ~ '^[A-Z0-9]{9}X$';

update public.provider_profiles
   set taxonomy_code = upper(provider_type)
 where taxonomy_code is null
   and provider_type is not null
   and upper(provider_type) ~ '^[A-Z0-9]{9}X$';

-- NUCC Health Care Provider Taxonomy code format: exactly 10 characters,
-- 9 leading alphanumerics + trailing literal 'X'. Allow NULL so legacy
-- rows without a code can still exist (and be surfaced as taxonomy
-- issues by the enrollment workqueue).
alter table public.provider_profiles
  drop constraint if exists provider_profiles_taxonomy_code_format;
alter table public.provider_profiles
  add constraint provider_profiles_taxonomy_code_format
  check (taxonomy_code is null or taxonomy_code ~ '^[A-Z0-9]{9}X$');

comment on column public.provider_profiles.taxonomy_code is
  'NUCC Health Care Provider Taxonomy code (10 chars, ends in X). '
  'Authoritative source for 837P loop 2310B PRV*PXC segment. '
  'NULL means not yet captured — surfaces as a taxonomy issue in the '
  'Provider Enrollment Issues workqueue.';

-- PostgREST schema reload so the new column is immediately queryable.
notify pgrst, 'reload schema';
