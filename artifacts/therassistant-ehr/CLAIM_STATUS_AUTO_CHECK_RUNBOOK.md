# Claim-status auto-check cron

Scheduled 276 poller that keeps the Payer Received queue moving without a
biller manually clicking "Check status" on every claim. Backs the
`POST /api/billing/claim-status/cron/auto-check` route added in Task #540
and wired up on the schedule in Task #630.

## Cadence

- **Schedule:** daily at 09:00 UTC (`0 9 * * *`).
- **Where it's registered:** Supabase pg_cron, via
  `supabase/CRON_SETUP_CLAIM_STATUS_AUTO_CHECK.sql`. Run that file once in
  the Supabase SQL editor against the production project after substituting
  `<APP_BASE_URL>` and `<CRON_SECRET>`. The same script is idempotent —
  re-running drops and re-creates the schedule.
- **Bumping to twice-daily:** change the cron expression to `0 9,21 * * *`
  and re-run the setup script. The route is safe to call repeatedly; the
  per-org `auto_recheck_interval_days` guard skips any claim that was
  already polled inside the window.

## How the route decides what to poll

For each org with at least one claim in `accepted_payer`:

- Only claims whose `submitted_at` is older than
  `payer_status.auto_check_age_days` (default 3) are eligible.
- Within that pool, claims polled inside
  `payer_status.auto_recheck_interval_days` (default 2) are skipped so we
  don't stomp on a biller's manual check.
- Each dispatched poll writes a row to `claim_status_inquiries` with
  `trigger_source = 'auto'`.

## Verifying it ran

In the Supabase SQL editor:

```sql
-- Last 10 cron executions (HTTP status + body live in `return_message`)
select start_time, status, return_message
from cron.job_run_details
where jobid = (
  select jobid from cron.job where jobname = 'claim-status-auto-check-daily'
)
order by start_time desc
limit 10;

-- Auto-polled inquiries from the last 24h, newest first
select id, organization_id, professional_claim_id, status, created_at
from claim_status_inquiries
where trigger_source = 'auto'
  and created_at > now() - interval '24 hours'
order by created_at desc;
```

The route also returns a JSON summary (`{ ok, organizations, totals, perOrg }`)
captured in `cron.job_run_details.return_message` — `totals.dispatched`
should match the count of new `trigger_source='auto'` rows for the same
window.

## Troubleshooting

- **No new `trigger_source='auto'` rows after a run:** check that the
  CRON_SECRET header matches the deployment's `CRON_SECRET` env var. If the
  header is wrong, the route falls through to its authenticated-biller
  branch, sees no `organizationId` in the body, and returns 400/403 —
  visible in `return_message`.
- **`Database unavailable` (503):** Supabase service-role env vars missing
  on the Next.js deployment; fix and redeploy.
- **A specific org isn't being polled:** confirm at least one claim is in
  `accepted_payer`, then check its `submitted_at` against that org's
  `payer_status.auto_check_age_days` setting.

## Manual / catch-up run

A biller (admin or biller role) can trigger a one-off run for a single org
without the cron secret — useful after a payer outage:

```bash
curl -X POST "$APP_BASE_URL/api/billing/claim-status/cron/auto-check" \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"organizationId":"<org-uuid>"}'
```

`ageDays`, `recheckIntervalDays`, and `maxClaims` are optional overrides on
the body for one-off catch-up runs.
