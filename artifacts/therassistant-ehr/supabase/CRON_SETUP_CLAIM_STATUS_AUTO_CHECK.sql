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
-- This schedules the 276 claim-status auto-checker for the Payer Received
-- queue (Task #540 / Task #630). It mirrors the setup for the existing
-- payments no-response-scan cron: a daily POST to the Next.js route, gated
-- by the shared CRON_SECRET header, with the route itself fanning out
-- across every organization that has a claim in `accepted_payer`.
--
-- Cadence: 09:00 UTC daily (~early morning ET, after overnight payer
-- batches have settled). Bump to `0 9,21 * * *` for twice-daily if a
-- practice asks for faster turnaround — the route is idempotent within the
-- recheck-interval window so re-running is safe.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior schedule with this name before re-creating.
do $$
declare j_id bigint;
begin
  select jobid into j_id from cron.job where jobname = 'claim-status-auto-check-daily';
  if j_id is not null then
    perform cron.unschedule(j_id);
  end if;
end $$;

select cron.schedule(
  'claim-status-auto-check-daily',
  '0 9 * * *',
  $cron$
    select net.http_post(
      url     := '<APP_BASE_URL>/api/billing/claim-status/cron/auto-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$
);

-- Verify the schedule:
--   select jobname, schedule, command from cron.job where jobname = 'claim-status-auto-check-daily';
-- Recent runs (status, HTTP code, response body):
--   select * from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'claim-status-auto-check-daily')
--     order by start_time desc limit 10;
