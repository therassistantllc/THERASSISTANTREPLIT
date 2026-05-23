# Email Integration Setup Guide (Gmail + Outlook)

## Current state (what's real vs. what you must do)

| Piece | Status | Notes |
|---|---|---|
| Gmail OAuth start | **Built** | `supabase/functions/gmail-oauth-start/index.ts` |
| Gmail OAuth callback (token storage) | **Built** | `supabase/functions/gmail-oauth-callback/index.ts` writes `integration_connections` + `gmail_oauth_tokens`. |
| Gmail inbox poller | **Built** | `supabase/functions/gmail-poll-inbox/index.ts` — calls Gmail History API, refreshes tokens, writes to `inbound_email_messages` via the `route_inbound_gmail_message` RPC. |
| Gmail AI summarizer | **Built** | `supabase/functions/analyze-gmail-workqueue/index.ts` |
| Outlook OAuth start | **Built (new in this change)** | `supabase/functions/outlook-oauth-start/index.ts` |
| Outlook OAuth callback | **Built (new in this change)** | `supabase/functions/outlook-oauth-callback/index.ts` |
| Outlook poller | **Built (new in this change)** | `supabase/functions/outlook-poll-inbox/index.ts` (Microsoft Graph delta queries) |
| `outlook_oauth_tokens` table | **Built (new migration)** | `supabase/migrations/20260521000000_outlook_oauth_tokens.sql` |
| Inbound webhook (Resend delivery status) | **Built** | `app/api/intake/email-webhook/route.ts` |

> Note: The standalone Email page (`app/email`) and its `/api/email/*` routes have been removed. Inbound patient email now surfaces through the Inbox / workqueue flow; the Gmail/Outlook OAuth + poller functions above continue to feed it.

## Architecture note (please read)

The existing flow is **one mailbox per organization**, not one per clinician.
This is the correct HIPAA pattern: a Business Associate Agreement is signed
between your practice and Google Workspace (or Microsoft 365), and patient
email goes to a shared `intake@practice.com` / `front-desk@practice.com`
mailbox that is then routed inside the EHR. Personal Gmail / Outlook accounts
cannot legally receive PHI even with consent.

If you genuinely need per-clinician mailboxes, that is a bigger refactor —
you'd add a `user_id` column to `integration_connections` and run the OAuth
flow per-user. Tell me if you want that and I'll do it as a follow-up.

## What you must do for Gmail to work end-to-end

1. **Google Cloud Console** → create (or reuse) a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → app type **Internal** (Google Workspace) or
   **External** + add yourself as a test user. Scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.send`
   - `openid`, `email`, `profile`
4. **Credentials → OAuth client ID → Web application** → add this authorized
   redirect URI exactly:
   `https://<your-supabase-project-ref>.supabase.co/functions/v1/gmail-oauth-callback`
5. **Sign a Business Associate Agreement (BAA) with Google Workspace.**
   This is mandatory for HIPAA. Personal Gmail accounts are not covered.
6. **Supabase → Project Settings → Edge Functions → Secrets**, set:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `APP_BASE_URL` (e.g. `https://your-replit-app.replit.app`)
   - `SUPABASE_URL` (auto-set on Supabase)
   - `SERVICE_ROLE_KEY` (your Supabase service-role JWT)
7. **Deploy the Edge Functions:**
   ```bash
   supabase functions deploy gmail-oauth-start
   supabase functions deploy gmail-oauth-callback
   supabase functions deploy gmail-poll-inbox
   supabase functions deploy analyze-gmail-workqueue
   ```
8. **Schedule the poller** (Supabase → Database → Cron, or pg_cron):
   ```sql
   select cron.schedule(
     'gmail-poll-inbox',
     '*/2 * * * *',
     $$ select net.http_post(
          url := 'https://<your-project-ref>.functions.supabase.co/gmail-poll-inbox',
          headers := jsonb_build_object('Authorization','Bearer <service-role-jwt>')
        ); $$
   );
   ```

## What you must do for Outlook to work end-to-end

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.**
   Supported account types: **Accounts in any organizational directory and
   personal Microsoft accounts** (or single-tenant if you only ever connect
   one Microsoft 365 tenant).
2. **Authentication → Add a Web platform → Redirect URI** exactly:
   `https://<your-supabase-project-ref>.supabase.co/functions/v1/outlook-oauth-callback`
3. **Certificates & secrets → New client secret.** Copy the **Value** — Azure
   only shows it once.
4. **API permissions → Add → Microsoft Graph → Delegated permissions**:
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `User.Read`
   - `offline_access`
   - `openid`, `email`, `profile`
   Click **Grant admin consent** if you control the tenant.
5. **Sign a Business Associate Agreement with Microsoft.** Microsoft 365
   Business / Enterprise plans support BAAs; personal `outlook.com` does not.
6. **Run the new migration against your Supabase database:**
   `supabase/migrations/20260521000000_outlook_oauth_tokens.sql`
7. **Supabase Edge Function secrets**, add:
   - `MICROSOFT_CLIENT_ID`
   - `MICROSOFT_CLIENT_SECRET`
   - `MICROSOFT_TENANT_ID` — use `common` to support both work and personal
     accounts, or your tenant GUID for a single-tenant lockdown.
8. **Deploy the new functions:**
   ```bash
   supabase functions deploy outlook-oauth-start
   supabase functions deploy outlook-oauth-callback
   supabase functions deploy outlook-poll-inbox
   ```
9. **Schedule the Outlook poller** (same pattern as Gmail, swap the URL).

## How to verify after setup

1. Open the EHR `/email` page.
2. Click **Connect Gmail** (or **Connect Outlook**). You'll be redirected
   through OAuth and land back on `/settings/integrations/gmail` (Gmail) or
   `/settings/integrations/outlook` (Outlook) with `?connected=1`.
3. Check `integration_connections` in Supabase — a row should appear with
   `connection_status='connected'`.
4. Send a test email **from a different account** to the connected mailbox.
5. Wait for the poller cron (≤2 min) or invoke it manually:
   ```bash
   curl -X POST 'https://<project-ref>.functions.supabase.co/gmail-poll-inbox' \
     -H 'Authorization: Bearer <service-role-jwt>'
   ```
6. The message should appear in the EHR `/email` list.

## What this does NOT do

- It does not send email from inside the EHR. Compose/reply UX is a follow-up.
  For now, "AI draft reply" is shown but must be copied into Gmail/Outlook to
  send.
- It does not attempt to send PHI over email — it only ingests inbound mail
  and routes it to the patient chart / mailroom.
- It does not implement Gmail push notifications (Pub/Sub) — polling every
  2 minutes is fine for clinical email volume but is not real-time.
- It does not replace per-user mailboxes. See the architecture note above.
