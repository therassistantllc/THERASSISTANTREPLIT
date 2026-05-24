-- Task #540: Auto-check payer status on a schedule instead of only on demand.
--
-- Adds a `trigger_source` column to `claim_status_inquiries` so the UI can
-- distinguish 276/277 inquiries that were fired by the scheduled cron
-- (`trigger_source='auto'`) from ones a biller explicitly kicked off with
-- the "Check payer status" button (`trigger_source='manual'`).
--
-- Defaults to 'manual' so historical rows and any code path that has not
-- been updated yet keep behaving exactly as before.

alter table if exists public.claim_status_inquiries
  add column if not exists trigger_source text not null default 'manual';

alter table if exists public.claim_status_inquiries
  drop constraint if exists claim_status_inquiries_trigger_source_chk;

alter table if exists public.claim_status_inquiries
  add constraint claim_status_inquiries_trigger_source_chk
  check (trigger_source in ('manual', 'auto'));

-- Lets the auto-check scheduler quickly find "did we already auto-check
-- this claim in the last N hours?" without scanning the whole table.
create index if not exists idx_claim_status_inquiries_org_claim_requested_desc
  on public.claim_status_inquiries (organization_id, claim_id, requested_at desc);
