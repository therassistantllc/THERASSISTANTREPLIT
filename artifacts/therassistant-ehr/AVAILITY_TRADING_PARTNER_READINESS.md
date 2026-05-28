# Availity EDI Trading Partner Readiness Report

_Last audited: 2026-05-21 against working-tree code and the Supabase schema dump provided by the operator._

> **This software is NOT currently certified for HIPAA compliance and is NOT ready
> to operate as an Availity Trading Partner / third-party submitter in
> production.** Multiple critical gaps remain (see Gap List). Do not transmit real
> PHI through this platform until the Phase 1 gaps are closed and a written BAA
> with Availity is executed. Do not represent to any payer, clearinghouse,
> auditor, or client that this platform is HIPAA-compliant, EDI-certified, or
> production-ready based on its current state.

## Executive Summary

The codebase has solid bones for Availity integration: a mature X12 837P
generator, real JSON-API adapter for 270/271 eligibility and 276/277 claim
status, parsers for 999 / 277CA / 835, a workqueue-driven rejection pipeline,
and a `claim_submission_gate` validator that runs before submission.

It is **not** ready to go live for these reasons:

1. **Credentials are not encrypted at rest.** They live in JSONB columns or
   environment variables with no vaulting and no rotation flow.
2. **The 837P submission transport is a stub.** EDI files are generated but the
   actual handoff to Availity (SFTP upload or API multi-claim batch) is not
   wired end-to-end.
3. **There is no per-payer enrollment tracking.** Availity requires
   payer-by-payer EDI enrollment for claims / ERA / eligibility; the platform
   cannot block submissions to non-enrolled payers because it does not know.
4. **Sandbox vs production is not enforced.** A single credential set is read
   from env; no per-organization, per-environment separation exists.
5. **No Trading Partner profile UI.** Submitter ID, billing-provider NPI,
   authorized representative, BAA tracking — none of it has a settings page.
6. **No connection-health / test-connection UX.** Operators cannot verify a
   credential is alive without making a real billable transaction.

## Current Capabilities (cited)

| Area | Status | Evidence |
|---|---|---|
| Trading Partner data | Partial | `organizations` stores `legal_name`, `tax_id_last4`. `clearinghouse_connections` stores submitter/receiver IDs (per schema dump). |
| Credential storage | Low | `clearinghouse_connections.encrypted_credentials` is JSONB with **no application-side encryption**; `AVAILITY_EDI_API_KEY` env var is also used. |
| 837P generation | High | `lib/edi/availity837p/generate837p.ts` produces validated X12. |
| 270/271 eligibility | High | `lib/clearinghouse/AvailityJsonApiAdapter.ts` makes real V2 API calls and persists 271 benefit segments. |
| 276/277 claim status | High | Same adapter — real-time status normalized to Paid/Denied/Pending. |
| 999 / 277CA ack parsing | Medium | `lib/clearinghouse/edi999AcknowledgementService.ts`, `edi277caAcknowledgementService.ts` — parsers exist and route rejections to the workqueue. |
| 835 ERA parsing | Medium | `lib/clearinghouse/parsers/parse835.ts` + `lib/payments/era835IntakeService.ts`. |
| Submission gate | High | `lib/validation/claimSubmissionGate.ts` blocks submissions when org/provider/payer data is incomplete. |
| Audit logging | Partial | `audit_logs` writes happen at the adapter layer but coverage is uneven across billing and PHI surfaces. |
| Operational alerts | Partial | `billing_alerts` table + workqueue routing exists, no alert dashboard. |

## Gap List

| # | Area | Gap | Severity | Risk if unaddressed |
|---|---|---|---|---|
| 1 | Security | No at-rest encryption for clearinghouse credentials (SFTP password, API key). | **Critical** | A leak of `clearinghouse_connections` or env vars hands an attacker the keys to submit fraudulent claims and pull PHI. |
| 2 | Security | No sandbox vs production environment separation per organization. | **Critical** | A single misconfigured row will send test claims to production payers, or vice-versa. |
| 3 | Transport | 837P submission to Availity (SFTP / multi-claim API) not fully wired. | **High** | Cannot actually submit claims. |
| 4 | Enrollment | No `payer_enrollments` table or per-payer status (claims / ERA / 270). | **High** | Availity rejects unenrolled-payer submissions; we will spam the workqueue with avoidable 277CA rejects. |
| 5 | Compliance | Minimum-necessary / role-based PHI access not consistently enforced on billing routes. | **High** | OCR audit finding. |
| 6 | Compliance | No BAA tracking (Availity, Google Workspace, Supabase, hosting). | **High** | HIPAA §164.502(e). |
| 7 | Compliance | Data retention / deletion policy not codified in schema or code. | **Medium** | HIPAA §164.530(j) — 6-year retention; right-to-amend / right-to-access. |
| 8 | Ops | No "Test Connection" or credential health check. | **Medium** | Outages discovered only when a real claim fails. |
| 9 | Ops | No retry / dead-letter for failed submissions or webhook ingest. | **Medium** | Silent data loss. |
| 10 | UI | No Trading Partner settings page (submitter ID, billing NPI, authorized rep, BAA dates). | **Medium** | Operators can't self-serve. |
| 11 | UI | No EDI transaction log viewer. | **Medium** | Debugging requires DB access. |
| 12 | UI | No failed-transaction queue with manual retry. | **Medium** | Same. |
| 13 | Security | Frontend bundle inspection for `NEXT_PUBLIC_*` secret leakage has not been done. | **Medium** | Anon key is intentional, but any other `NEXT_PUBLIC_*` keys need an audit. |
| 14 | Audit | `audit_logs` not append-only / immutable at the DB level (no `REVOKE UPDATE/DELETE`). | **Medium** | Insider can rewrite history. |
| 15 | Duplicate prevention | No unique constraint on `(claim_id, batch_id)` or idempotency key for submissions. | **Medium** | Double-submission risk. |

## Required Database Migrations (sketch — not yet authored)

```sql
-- 1. Encrypted credential vaulting via Supabase Vault (pgsodium)
ALTER TABLE public.clearinghouse_connections
  ADD COLUMN vault_secret_id uuid REFERENCES vault.secrets(id),
  ADD COLUMN environment text NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production'));
-- Stop using encrypted_credentials JSONB once vault_secret_id is populated.
-- Drop encrypted_credentials after backfill.

-- 2. Per-payer EDI enrollment
CREATE TABLE public.payer_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  payer_profile_id uuid NOT NULL REFERENCES public.payer_profiles(id),
  transaction_type text NOT NULL
    CHECK (transaction_type IN ('claims_837p', 'era_835', 'eligibility_270', 'claim_status_276')),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','approved','rejected','revoked')),
  oa_enrollment_reference text,
  approved_at timestamptz,
  expires_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, payer_profile_id, transaction_type, environment)
);

-- 3. Trading Partner profile fields on organizations
ALTER TABLE public.organizations
  ADD COLUMN ein text,
  ADD COLUMN billing_npi text,
  ADD COLUMN billing_address jsonb,
  ADD COLUMN authorized_rep_name text,
  ADD COLUMN authorized_rep_email text,
  ADD COLUMN authorized_rep_phone text;

-- 4. BAA tracking
CREATE TABLE public.business_associate_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  counterparty text NOT NULL,            -- 'availity', 'google_workspace', 'supabase', 'hosting', etc.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','terminated')),
  signed_at date, expires_at date,
  document_storage_path text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, counterparty)
);

-- 5. Make audit_logs append-only at the DB level
REVOKE UPDATE, DELETE ON public.audit_logs FROM PUBLIC, authenticated, service_role;
GRANT INSERT, SELECT ON public.audit_logs TO service_role, authenticated;
-- Service role can still bypass with a maintenance role; document that gap.

-- 6. Idempotency for submissions
ALTER TABLE public.claim_837p_batches
  ADD COLUMN submission_idempotency_key text UNIQUE;
```

## Required API Routes (new)

- `POST /api/clearinghouse/availity/test-connection` — auths against OA, returns 200/4xx, writes audit row.
- `GET  /api/clearinghouse/availity/health` — last successful auth, last successful submission, last ack received.
- `GET/POST /api/settings/trading-partner` — read/write the Trading Partner profile.
- `GET/POST/PATCH /api/settings/payer-enrollments` — manage `payer_enrollments` rows.
- `GET /api/settings/baa` — list/track BAAs.
- `POST /api/clearinghouse/availity/rotate-credentials` — rotate API key / SFTP password; writes audit row.
- `POST /api/claims/837p/batch/[id]/retry` — operator-driven retry with idempotency key.
- `GET /api/admin/edi/transactions` — paginated, filterable EDI transaction log.

## Required UI Pages / Components (new)

- `/settings/trading-partner` — Trading Partner profile editor.
- `/settings/clearinghouse` — Availity credential editor (per environment), test-connection button, health card.
- `/settings/payer-enrollments` — grid: payer × transaction-type × environment → status, with "request enrollment" / "mark approved" actions.
- `/settings/baa` — BAA tracker.
- `/admin/edi-transactions` — searchable log of every 270/271/276/277/837/999/277CA/835.
- `/admin/failed-transactions` — dead-letter queue with retry button.
- Dashboard tile: "Clearinghouse health" (green/yellow/red).

## Recommended Implementation Order

**Phase 1 — Pre-production blockers (must close before any real PHI)**
1. Vault-backed credential storage + per-environment separation (Migration 1, rotate-credentials route).
2. Finalize 837P submission transport (SFTP or OA multi-claim API) with idempotency keys (Migration 6).
3. `payer_enrollments` table + claim-gate integration that **blocks** production submissions to non-approved payers (Migration 2, gate update).
4. Trading Partner profile fields + settings page (Migration 3, settings route + UI).
5. BAA tracker (Migration 4, settings UI). At minimum: Availity, Google Workspace, Supabase, hosting.
6. Make `audit_logs` append-only (Migration 5).

**Phase 2 — Operational readiness**
7. Test-connection + health endpoints + dashboard tile.
8. Failed-transaction queue UI with retry.
9. EDI transaction log UI with raw-payload viewer (gated to admin role).
10. RBAC audit: every billing/PHI route reviewed for minimum-necessary.

**Phase 3 — Compliance hardening**
11. Frontend bundle audit for `NEXT_PUBLIC_*` secret exposure.
12. Data retention / deletion job (6 years from last touch on clinical data; right-to-amend workflow).
13. Tabletop / breach-notification runbook documented in repo.

## Manual Steps the Operator Must Complete with Availity

These are **not** code work — they cannot be skipped or simulated.

1. **Apply for an Availity Submitter ID** as a Software Vendor / Third-Party Submitter (not just a clinic). Different application than the practice-only path.
2. **Execute a Business Associate Agreement (BAA)** with Availity. Record the signed date + expiration in `business_associate_agreements`. Without a BAA, transmitting PHI is a HIPAA violation regardless of code quality.
3. **Request SFTP credentials** (upload + download folders) and/or generate a Production API Key in the Availity Resource Center, depending on which transport you choose.
4. **Per-payer EDI enrollment:** submit Availity's EDI Enrollment Form (or payer-direct form) for every payer that requires it — separately for 837 (claims), 835 (ERA), and 270 (real-time eligibility). Record each in `payer_enrollments`. Medicaid, Medicare, and most Blues require this; commercial varies.
5. **Availity certification testing:** submit ~10 test claims through their sandbox loop with the 2000P/T test indicator and obtain 999 + 277CA acceptance before flipping any payer to production.
6. **Companion guides:** download Availity's 837P / 835 / 270 / 276 companion guides and verify the generated EDI against them. The generic X12 spec is not enough; OA-specific tweaks exist (e.g., REF segment usage, NM1 qualifier nuances).
7. **Execute BAAs with all other vendors handling PHI:** Google Workspace (BAA required for any clinician-mailbox integration), Supabase (paid plan + signed BAA), hosting provider, any AI-summarization vendor used on email/notes.

## Explicit Non-Compliance Statement

**This platform is NOT HIPAA-compliant in its current state.** Specifically:

- Credentials granting access to PHI submission are stored without at-rest encryption.
- There is no enforced separation between sandbox and production credentials.
- BAAs are not tracked and may not exist with all required counterparties.
- Audit logs are not enforced as append-only at the database layer.
- A current risk analysis (HIPAA §164.308(a)(1)(ii)(A)) has not been performed or filed in this repo.

Do not represent the platform as compliant, certified, or production-ready
until each Phase 1 item above is closed, a formal risk analysis is filed, and
all required BAAs are signed.
