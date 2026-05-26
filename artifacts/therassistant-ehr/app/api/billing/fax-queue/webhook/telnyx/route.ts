/**
 * POST /api/billing/fax-queue/webhook/telnyx
 *
 * Live Telnyx Programmable Fax webhook receiver (Task #823).
 *
 * Telnyx fans out lifecycle events (`fax.queued`, `fax.media.processed`,
 * `fax.sending`, `fax.delivered`, `fax.failed`) within seconds of the
 * downstream fax state changing. This route consumes them and flips the
 * matching `claim_documentation_transmissions` row to its terminal
 * status — eliminating the 5-minute lag the polling reconciler had to
 * accept. The poller (`/cron/reconcile-status`) stays in place as a
 * safety net for missed deliveries.
 *
 * Security:
 *   - Telnyx signs every webhook with Ed25519 over `${ts}|${rawBody}`.
 *   - Signature lives in `telnyx-signature-ed25519` (base64); timestamp
 *     in `telnyx-timestamp` (unix seconds).
 *   - Public key is resolved from `TELNYX_PUBLIC_KEY` env or the Replit
 *     `telnyx` connector. Missing key → 503; bad signature → 401.
 *   - 5-minute replay window enforced inside `verifyTelnyxSignature`.
 *
 * Matching:
 *   - Lookup is by `provider_message_id` (the Telnyx fax id the
 *     dispatcher stored on the transmission) + `channel='fax'`. Webhooks
 *     are cross-org by nature — the provider id is globally unique, so
 *     no org filter is required (and impossible to derive from the
 *     payload anyway).
 *   - Already-terminal rows are left alone (idempotent re-deliveries).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  normalizeTelnyxFaxStatus,
  resolveTelnyxWebhookPublicKey,
  verifyTelnyxSignature,
  type NormalizedFaxStatus,
} from "@/lib/fax/provider";

export const runtime = "nodejs";

// Minimal supabase shape; the production admin client satisfies it. Keeps
// the route testable with a hand-rolled fake.
type DbRow = Record<string, unknown>;
type QueryBuilder = {
  select: (cols: string) => QueryBuilder;
  update: (v: unknown) => QueryBuilder;
  eq: (col: string, val: unknown) => QueryBuilder;
  in: (col: string, vals: unknown[]) => QueryBuilder;
  limit: (n: number) => QueryBuilder;
  maybeSingle?: () => Promise<{ data: DbRow | null; error: { message?: string } | null }>;
  then?: (...args: unknown[]) => unknown;
};
export type WebhookSupabase = { from(table: string): QueryBuilder };

export interface TelnyxWebhookDeps {
  supabaseFactory: () => WebhookSupabase | null;
  publicKeyResolver: () => Promise<string | null>;
  /** Inject for replay-window tests. */
  now?: () => number;
}

export const defaultTelnyxWebhookDeps: TelnyxWebhookDeps = {
  supabaseFactory: () =>
    createServerSupabaseAdminClient() as unknown as WebhookSupabase | null,
  publicKeyResolver: resolveTelnyxWebhookPublicKey,
};

interface TelnyxEvent {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: {
      id?: string;
      fax_id?: string;
      status?: string;
      failure_reason?: string | null;
    } & Record<string, unknown>;
  };
}

/**
 * Pull the Telnyx fax id off the payload. Telnyx has historically used
 * both `payload.fax_id` and `payload.id` for the fax identifier on
 * fax.* events depending on which docs page you read; accept either.
 */
function extractFaxId(event: TelnyxEvent): string | null {
  const p = event.data?.payload;
  if (!p) return null;
  const id = typeof p.fax_id === "string" && p.fax_id ? p.fax_id : typeof p.id === "string" ? p.id : "";
  return id ? id : null;
}

/**
 * Collapse a Telnyx event onto the normalized lifecycle. Prefer
 * `payload.status` (the source of truth for the underlying fax), fall
 * back to deriving from `event_type` for events that omit it.
 */
function normalizeEvent(event: TelnyxEvent): NormalizedFaxStatus {
  const status = event.data?.payload?.status;
  if (typeof status === "string" && status.trim()) {
    return normalizeTelnyxFaxStatus(status);
  }
  const t = (event.data?.event_type ?? "").toLowerCase();
  if (t === "fax.delivered") return "delivered";
  if (t === "fax.failed") return "failed";
  if (t === "fax.queued" || t === "fax.sending" || t === "fax.media.processed") return "sending";
  return "unknown";
}

interface FlipOutcome {
  matched: boolean;
  flipped: boolean;
  alreadyTerminal: boolean;
  status: string | null;
  error?: string;
}

async function applyEventToTransmission(
  supabase: WebhookSupabase,
  faxId: string,
  normalized: NormalizedFaxStatus,
  failureReason: string | null,
): Promise<FlipOutcome> {
  // Look up the transmission(s) matching this provider id. We don't have
  // an org id from the webhook, so the provider id (a globally-unique
  // Telnyx fax uuid the dispatcher persisted on the row) is the key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const selectRes = (await sb
    .from("claim_documentation_transmissions")
    .select("id, organization_id, status")
    .eq("channel", "fax")
    .eq("provider_message_id", faxId)
    .limit(2)) as { data: DbRow[] | null; error: { message?: string } | null };

  if (selectRes.error) {
    return {
      matched: false,
      flipped: false,
      alreadyTerminal: false,
      status: null,
      error: selectRes.error.message ?? "transmission lookup failed",
    };
  }
  const rows = selectRes.data ?? [];
  if (rows.length === 0) {
    return { matched: false, flipped: false, alreadyTerminal: false, status: null };
  }
  const row = rows[0] as { id: string; organization_id: string; status: string };

  // Idempotent: terminal rows stay terminal regardless of re-deliveries.
  const currentStatus = String(row.status ?? "");
  if (currentStatus === "delivered" || currentStatus === "failed") {
    return {
      matched: true,
      flipped: false,
      alreadyTerminal: true,
      status: currentStatus,
    };
  }
  // 'sending'/'unknown' webhooks for a non-terminal row don't move us
  // forward — the poller will close it out if a terminal event is lost.
  if (normalized !== "delivered" && normalized !== "failed") {
    return { matched: true, flipped: false, alreadyTerminal: false, status: currentStatus };
  }

  const patch: Record<string, unknown> =
    normalized === "delivered"
      ? { status: "delivered", error: null }
      : {
          status: "failed",
          error: failureReason || "Telnyx reported failed",
        };

  const updRes = (await sb
    .from("claim_documentation_transmissions")
    .update(patch)
    .eq("organization_id", row.organization_id)
    .eq("id", row.id)) as { error: { message?: string } | null };
  if (updRes.error) {
    return {
      matched: true,
      flipped: false,
      alreadyTerminal: false,
      status: currentStatus,
      error: updRes.error.message ?? "transmission update failed",
    };
  }
  return {
    matched: true,
    flipped: true,
    alreadyTerminal: false,
    status: normalized,
  };
}

export interface ProcessResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Process a verified Telnyx webhook body. Exposed so tests can exercise
 * the routing/idempotency logic without standing up a Next request.
 */
export async function processTelnyxFaxWebhook(
  rawBody: string,
  deps: TelnyxWebhookDeps,
): Promise<ProcessResult> {
  let event: TelnyxEvent;
  try {
    event = JSON.parse(rawBody) as TelnyxEvent;
  } catch {
    return { status: 400, body: { ok: false, error: "Invalid JSON" } };
  }
  const eventType = String(event.data?.event_type ?? "");
  if (!eventType.startsWith("fax.")) {
    // Other event families (e.g. messaging) shouldn't reach this endpoint;
    // 200 so Telnyx stops retrying.
    return { status: 200, body: { ok: true, ignored: true, type: eventType || "unknown" } };
  }
  const faxId = extractFaxId(event);
  if (!faxId) {
    return { status: 400, body: { ok: false, error: "payload missing fax id" } };
  }

  const supabase = deps.supabaseFactory();
  if (!supabase) {
    return { status: 503, body: { ok: false, error: "Database unavailable" } };
  }

  const normalized = normalizeEvent(event);
  const failureReason =
    (typeof event.data?.payload?.failure_reason === "string" && event.data.payload.failure_reason) ||
    null;

  const outcome = await applyEventToTransmission(supabase, faxId, normalized, failureReason);
  if (outcome.error) {
    return {
      status: 503,
      body: { ok: false, error: outcome.error, type: eventType, faxId },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      type: eventType,
      faxId,
      normalized,
      matched: outcome.matched,
      flipped: outcome.flipped,
      alreadyTerminal: outcome.alreadyTerminal,
      status: outcome.status,
    },
  };
}

export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read body" }, { status: 400 });
  }

  const publicKey = await defaultTelnyxWebhookDeps.publicKeyResolver();
  if (!publicKey) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Telnyx webhook public key is not configured. Set TELNYX_PUBLIC_KEY or add public_key to the Telnyx Replit Connector.",
      },
      { status: 503 },
    );
  }

  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");
  if (!verifyTelnyxSignature(rawBody, signature, timestamp, publicKey)) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  const result = await processTelnyxFaxWebhook(rawBody, defaultTelnyxWebhookDeps);
  return NextResponse.json(result.body, { status: result.status });
}
