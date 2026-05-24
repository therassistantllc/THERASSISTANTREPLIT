-- Drop the legacy `title` column from `mailroom_items`.
--
-- The original digital-mailroom migration (20260511212500) shipped a
-- NOT NULL `title text` column. The newer compat columns (`file_name`,
-- `status`, `source`, `notes`) cover the same surface and are what every
-- current code path actually reads. The legacy column has become a
-- regression magnet: any new writer that forgets to backfill `title`
-- from the file name (or a generic fallback) blows up with a not-null
-- constraint violation (see Task #403). Dropping it eliminates the
-- whole class of bug.

alter table public.mailroom_items
  drop column if exists title;

select pg_notify('pgrst', 'reload schema');
