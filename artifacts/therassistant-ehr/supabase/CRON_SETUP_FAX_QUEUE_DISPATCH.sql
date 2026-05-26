-- Run this ONCE in the Supabase SQL editor:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Before running, replace:
--   <APP_BASE_URL>  with the deployed Next.js app origin
--                   (e.g. https://therassistant.example.com — no trailing slash)
--   <CRON_SECRET>   with the value of the CRON_SECRET env var set on the
--                   Next.js deployment (the same secret the route checks
--                   via the `x-cron-secret` header).
--
-- This schedules the outbound fax-queue dispatcher. The route itself fans
-- out across every organization that currently has a pending fax_queue
-- row, downloads the documents referenced by the matching
-- claim_documentation_transmissions row, merges them into one PDF, hands
-- the signed URL to the configured fax provider (Telnyx), and flips each
-- row to 'sent' / 'failed' with the real outcome.
--
-- Cadence: every 5 minutes. Pending faxes are operator-facing work
-- (medical-review "Send documentation" → payer fax), so a short interval
-- keeps latency tight. The dispatcher is idempotent — it only picks rows
-- in status='pending' and atomically claims each one before sending, so
-- overlapping runs (manual retry + cron) cannot double-transmit.
--
-- Provider credentials are NOT configured here. Set them via either:
--   * Replit Connectors → telnyx (api_key, from_number, optional connection_id)
--   * Env vars: TELNYX_API_KEY, TELNYX_FROM_NUMBER, [TELNYX_CONNECTION_ID]
-- If neither is present the worker flips each row to 'failed' with a
-- clear message instead of leaving it stuck on 'pending' forever.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior schedule with this name before re-creating.
do $$
declare j_id bigint;
begin
  select jobid into j_id from cron.job where jobname = 'billing-fax-queue-dispatch-every-5min';
  if j_id is not null then
    perform cron.unschedule(j_id);
  end if;
end $$;

select cron.schedule(
  'billing-fax-queue-dispatch-every-5min',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url     := '<APP_BASE_URL>/api/billing/fax-queue/cron/dispatch',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);

-- Verify the schedule:
--   select jobname, schedule, command from cron.job where jobname = 'billing-fax-queue-dispatch-every-5min';
-- Recent runs:
--   select * from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'billing-fax-queue-dispatch-every-5min')
--     order by start_time desc limit 10;
