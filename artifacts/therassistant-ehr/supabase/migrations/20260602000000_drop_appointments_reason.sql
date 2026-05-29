-- The calendar drawer's memo input writes to a dedicated `memo` column and
-- historical memos were backfilled out of `reason` by
-- 20260601000000_appointments_memo_backfill_from_reason.sql. Nothing
-- user-facing reads or writes `appointments.reason` anymore, so retire the
-- legacy column to remove a permanent source of drift with `memo`.

alter table if exists public.appointments
  drop column if exists reason;
