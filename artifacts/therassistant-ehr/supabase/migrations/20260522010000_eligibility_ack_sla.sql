-- Phase 4 (CORE Eligibility Infrastructure Rule vEB.2.0 §2–§4):
-- Surface 999 functional acknowledgement state on real-time eligibility
-- transactions, and make the 24-hour batch 999 deadline queryable.
--
-- Real-time submitters (270/271) get either a 271 or a 999 within 20s;
-- batch submitters get a 999 within 24h. The 837P pipeline already uses
-- public.edi_acknowledgements for batch 999 storage — we reuse it and
-- only add the columns needed to compute "999 overdue" on the parent
-- public.edi_batches row.

alter table if exists public.edi_transactions
  add column if not exists ack_status text,
  add column if not exists ack_received_at timestamptz,
  add column if not exists ack_payload text,
  add column if not exists timed_out_at timestamptz;

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'edi_transactions') then
    -- Drop and recreate the check so re-runs pick up the latest value set.
    begin
      alter table public.edi_transactions drop constraint if exists edi_transactions_ack_status_check;
    exception when others then null;
    end;
    alter table public.edi_transactions
      add constraint edi_transactions_ack_status_check
      check (
        ack_status is null
        or ack_status in (
          'accepted',
          'accepted_with_errors',
          'partially_accepted',
          'rejected',
          'pending',
          'overdue',
          'timeout'
        )
      );
  end if;
end$$;

create index if not exists idx_edi_transactions_ack_status
  on public.edi_transactions (ack_status);

create index if not exists idx_edi_transactions_pending_ack
  on public.edi_transactions (transaction_type, ack_status, sent_at)
  where ack_status is null or ack_status = 'pending';

-- Batch 999 expectation tracking. The 837P transport already records the
-- batch send time in public.edi_batches.submitted_at and links acks via
-- public.edi_acknowledgements.edi_batch_id; we add a derived view so the
-- batch overdue tracker is a single SELECT, not a join the app has to
-- assemble.
create or replace view public.edi_batch_ack_status as
select
  b.id as edi_batch_id,
  b.organization_id,
  b.transaction_type,
  b.status as batch_status,
  b.submitted_at,
  ack.received_at as ack_received_at,
  ack.acknowledgement_type as ack_type,
  case
    when ack.id is not null then 'received'
    when b.submitted_at is null then 'not_submitted'
    when b.submitted_at > now() - interval '24 hours' then 'pending'
    else 'overdue'
  end as ack_window_status,
  case
    when ack.id is not null then null
    when b.submitted_at is null then null
    else extract(epoch from (now() - b.submitted_at)) / 3600.0
  end as hours_since_submit
from public.edi_batches b
left join lateral (
  select id, received_at, acknowledgement_type
  from public.edi_acknowledgements a
  where a.edi_batch_id = b.id
    and a.acknowledgement_type = '999'
  order by a.received_at desc
  limit 1
) ack on true;

comment on view public.edi_batch_ack_status is
  '999 ack window status per batch. ack_window_status is one of received|pending|overdue|not_submitted; overdue means >24h elapsed since submit with no 999 (CAQH CORE Infrastructure Rule vEB.2.0 §3.2.2).';

comment on column public.edi_transactions.ack_status is
  '999 functional acknowledgement state for this 270/271 exchange. Null until a 999 is received or the request times out. See edi_batch_ack_status for batch-level rollup.';

comment on column public.edi_transactions.ack_received_at is
  'Timestamp the 999 functional acknowledgement was received for this transaction.';

comment on column public.edi_transactions.ack_payload is
  'Raw X12 999 functional acknowledgement payload, when one was returned alongside or instead of a 271.';

comment on column public.edi_transactions.timed_out_at is
  'Set when the 20s real-time SLA (CAQH CORE Infrastructure Rule vEB.2.0 §4) expired without a 271 or 999 response.';
