-- Task #790: bound automatic fax retries with backoff + max attempts.
--
-- The dispatch cron picks up every fax_queue row in status='pending' every
-- five minutes. Before this migration there was nothing tracking how many
-- times a row had already been attempted, so a fax with a permanently bad
-- recipient (wrong number, payer fax line down) could be re-attempted
-- forever every time a biller hit Retry or a row was reset to pending.
--
-- Adds:
--   attempt_count      — how many times the dispatcher has tried to send
--                        this row. Reset to 0 by an explicit manual retry.
--   next_attempt_at    — earliest moment the dispatcher is allowed to
--                        claim this row again. Set into the future after
--                        each automatic failure (exponential backoff).
--                        Cleared on manual retry so the biller's explicit
--                        ask isn't delayed.
--   last_attempted_at  — wall-clock of the most recent claim; useful for
--                        ops dashboards / debugging.

alter table public.fax_queue
  add column if not exists attempt_count int not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_attempted_at timestamptz;

-- Pending sweeps now need to filter by "is the backoff window over?". Index
-- the (org, status, next_attempt_at) tuple so the dispatcher's scan stays
-- cheap as the failed-then-retrying pile grows.
create index if not exists idx_fax_queue_pending_due
  on public.fax_queue (organization_id, next_attempt_at)
  where status = 'pending';

notify pgrst, 'reload schema';
