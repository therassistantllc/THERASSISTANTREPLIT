/**
 * Outbound fax provider abstraction.
 *
 * The medical-review "Send documentation" action writes a `fax_queue` row
 * whenever the payer's records contact is a fax number. A scheduled worker
 * (`runFaxQueueDispatch`) drains that queue by calling `sendOutboundFax`
 * for each pending row.
 *
 * Today the only supported provider is Telnyx Programmable Fax. Credentials
 * resolve in this order:
 *   1. Replit Connectors (`telnyx`) — `api_key`, `from_number`, optional
 *      `connection_id`.
 *   2. Environment variables — `TELNYX_API_KEY` (required), `TELNYX_FROM_NUMBER`
 *      (required), `TELNYX_CONNECTION_ID` (optional).
 *
 * When no credentials are configured `resolveFaxProvider()` returns a sentinel
 * `not_configured` provider that fails every send with a clear error. That
 * lets the worker still update queue rows to `failed` with a human-readable
 * message instead of leaving them stuck on `pending` forever.
 */

const REPLIT_CONNECTORS_HOSTNAME = process.env.REPLIT_CONNECTORS_HOSTNAME;
const X_REPLIT_TOKEN =
  process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

export interface SendOutboundFaxInput {
  /** E.164 destination number. */
  to: string;
  /** Publicly fetchable URL of the PDF (e.g. Supabase signed URL). */
  mediaUrl: string;
}

export type SendOutboundFaxResult =
  | { ok: true; providerId: string; providerStatus: string | null }
  | { ok: false; error: string };

/**
 * Normalized terminal/lifecycle status the worker reasons about. Provider
 * vocabularies (Telnyx: queued / media.processed / sending / delivered /
 * failed) collapse into these buckets.
 */
export type NormalizedFaxStatus = "sending" | "delivered" | "failed" | "unknown";

export type GetFaxStatusResult =
  | {
      ok: true;
      providerStatus: string | null;
      normalized: NormalizedFaxStatus;
      failureReason?: string | null;
    }
  | { ok: false; error: string };

export interface FaxProvider {
  readonly name: string;
  readonly configured: boolean;
  send(input: SendOutboundFaxInput): Promise<SendOutboundFaxResult>;
  /**
   * Poll the provider for the latest status of a previously-sent fax.
   * Implementations should map the provider's vocabulary onto the
   * `NormalizedFaxStatus` union so callers don't need provider-specific
   * knowledge. Returning `{ ok: false }` is reserved for transport
   * failures (network, auth) — a successful HTTP response whose body
   * says the fax is still mid-flight returns `{ ok: true, normalized:
   * "sending" }`.
   */
  getStatus(providerId: string): Promise<GetFaxStatusResult>;
}

type TelnyxCredentials = {
  apiKey: string;
  fromNumber: string;
  connectionId?: string;
  /**
   * Base64-encoded raw 32-byte Ed25519 public key Telnyx uses to sign
   * outgoing webhooks. Optional because `send`/`getStatus` don't need it;
   * only the webhook receiver does.
   */
  publicKey?: string;
};

/**
 * Verify a Telnyx webhook signature.
 *
 * Telnyx signs each webhook with Ed25519 over the bytes
 * `${telnyx-timestamp}|${rawBody}`. The signature is delivered base64-
 * encoded in `telnyx-signature-ed25519`; the timestamp (unix seconds) is
 * in `telnyx-timestamp`. The matching public key lives in the Telnyx
 * portal as a raw 32-byte Ed25519 key, base64-encoded.
 *
 * Returns false (fail-closed) for any missing/malformed input, stale
 * timestamps outside the replay window, or signatures that don't verify.
 */
export function verifyTelnyxSignature(
  rawBody: string,
  signatureB64: string | null | undefined,
  timestamp: string | null | undefined,
  publicKeyB64: string | null | undefined,
  opts?: { now?: number; replayWindowSeconds?: number },
): boolean {
  if (!signatureB64 || !timestamp || !publicKeyB64) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const window = opts?.replayWindowSeconds ?? 300;
  if (Math.abs(now - ts) > window) return false;

  let sig: Buffer;
  let rawKey: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
    rawKey = Buffer.from(publicKeyB64, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64 || rawKey.length !== 32) return false;

  // Wrap the raw Ed25519 key as a SPKI DER so node's crypto can import it.
  // 302a300506032b6570032100 is the standard SPKI prefix for Ed25519.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([spkiPrefix, rawKey]);

  // Local require so the module stays edge-runtime-friendly at parse time;
  // verification only runs in the Node route handler.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey, verify } = require("node:crypto") as typeof import("node:crypto");
  let key;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return false;
  }
  const message = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  try {
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/**
 * Same vocabulary mapper used by the poller, exported so the webhook
 * handler can collapse Telnyx's `data.event_type` (or `payload.status`)
 * onto the normalized lifecycle without redefining the table.
 */
export function normalizeTelnyxFaxStatus(raw: string | null | undefined): NormalizedFaxStatus {
  return normalizeTelnyxStatus(raw);
}

async function fetchTelnyxCredentialsFromConnector(): Promise<TelnyxCredentials | null> {
  if (!REPLIT_CONNECTORS_HOSTNAME || !X_REPLIT_TOKEN) return null;
  try {
    const response = await fetch(
      `https://${REPLIT_CONNECTORS_HOSTNAME}/api/v2/connection?include_secrets=true&connector_names=telnyx`,
      { headers: { Accept: "application/json", X_REPLIT_TOKEN } },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { items?: Array<Record<string, unknown>> };
    const item = json.items?.[0];
    if (!item) return null;
    const settings = (item.settings ?? {}) as Record<string, unknown>;
    const apiKey =
      (typeof settings.api_key === "string" && settings.api_key) ||
      (typeof (settings as { apiKey?: unknown }).apiKey === "string" &&
        (settings as { apiKey: string }).apiKey) ||
      "";
    const fromNumber =
      (typeof settings.from_number === "string" && settings.from_number) ||
      (typeof (settings as { fromNumber?: unknown }).fromNumber === "string" &&
        (settings as { fromNumber: string }).fromNumber) ||
      "";
    const connectionId =
      (typeof settings.connection_id === "string" && settings.connection_id) ||
      (typeof (settings as { connectionId?: unknown }).connectionId === "string" &&
        (settings as { connectionId: string }).connectionId) ||
      undefined;
    const publicKey =
      (typeof settings.public_key === "string" && settings.public_key) ||
      (typeof (settings as { publicKey?: unknown }).publicKey === "string" &&
        (settings as { publicKey: string }).publicKey) ||
      undefined;
    if (!apiKey || !fromNumber) return null;
    return { apiKey, fromNumber, connectionId, publicKey };
  } catch {
    return null;
  }
}

async function resolveTelnyxCredentials(): Promise<TelnyxCredentials | null> {
  const envKey = process.env.TELNYX_API_KEY?.trim();
  const envFrom = process.env.TELNYX_FROM_NUMBER?.trim();
  if (envKey && envFrom) {
    return {
      apiKey: envKey,
      fromNumber: envFrom,
      connectionId: process.env.TELNYX_CONNECTION_ID?.trim() || undefined,
      publicKey: process.env.TELNYX_PUBLIC_KEY?.trim() || undefined,
    };
  }
  return fetchTelnyxCredentialsFromConnector();
}

/**
 * Resolve just the Ed25519 public key Telnyx uses for webhook signatures.
 * Checks `TELNYX_PUBLIC_KEY` first, then the `telnyx` connector. Returns
 * null when neither source is configured so the webhook route can
 * fail-closed with a clear 503.
 */
export async function resolveTelnyxWebhookPublicKey(): Promise<string | null> {
  const env = process.env.TELNYX_PUBLIC_KEY?.trim();
  if (env) return env;
  const creds = await fetchTelnyxCredentialsFromConnector();
  return creds?.publicKey ?? null;
}

function notConfiguredProvider(): FaxProvider {
  const error =
    "Fax provider is not configured. Connect Telnyx in Integrations (or set TELNYX_API_KEY and TELNYX_FROM_NUMBER) so the outbound fax worker can deliver queued documentation.";
  return {
    name: "not_configured",
    configured: false,
    async send() {
      return { ok: false, error };
    },
    async getStatus() {
      return { ok: false, error };
    },
  };
}

/**
 * Telnyx fax lifecycle (per their docs): queued → media.processed →
 * sending → delivered | failed. Anything else (or missing) is treated
 * as still-in-flight so we keep polling.
 */
function normalizeTelnyxStatus(raw: string | null | undefined): NormalizedFaxStatus {
  const s = String(raw ?? "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "failed") return "failed";
  if (s === "sending" || s === "queued" || s === "media.processed" || s === "initiated") {
    return "sending";
  }
  return "unknown";
}

function telnyxProvider(creds: TelnyxCredentials): FaxProvider {
  return {
    name: "telnyx",
    configured: true,
    async send(input) {
      try {
        const body: Record<string, unknown> = {
          to: input.to,
          from: creds.fromNumber,
          media_url: input.mediaUrl,
          quality: "high",
          store_media: false,
        };
        if (creds.connectionId) body.connection_id = creds.connectionId;

        const resp = await fetch("https://api.telnyx.com/v2/faxes", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        if (!resp.ok) {
          const errs = (parsed?.errors as Array<Record<string, unknown>> | undefined) ?? [];
          const msg =
            errs.length && typeof errs[0]?.detail === "string"
              ? String(errs[0].detail)
              : text || `Telnyx returned HTTP ${resp.status}`;
          return { ok: false, error: msg };
        }
        const data = (parsed?.data ?? {}) as Record<string, unknown>;
        const providerId = typeof data.id === "string" ? data.id : "";
        const providerStatus = typeof data.status === "string" ? (data.status as string) : null;
        if (!providerId) {
          return { ok: false, error: "Telnyx accepted the fax but returned no id" };
        }
        return { ok: true, providerId, providerStatus };
      } catch (e) {
        return {
          ok: false,
          error: `Telnyx request failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
    async getStatus(providerId) {
      try {
        const resp = await fetch(
          `https://api.telnyx.com/v2/faxes/${encodeURIComponent(providerId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${creds.apiKey}`,
              Accept: "application/json",
            },
          },
        );
        const text = await resp.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        if (!resp.ok) {
          // 404: provider has aged the record out — we can't reconcile.
          // Surface as transport error so the caller leaves the row alone.
          const errs = (parsed?.errors as Array<Record<string, unknown>> | undefined) ?? [];
          const msg =
            errs.length && typeof errs[0]?.detail === "string"
              ? String(errs[0].detail)
              : text || `Telnyx GET returned HTTP ${resp.status}`;
          return { ok: false, error: msg };
        }
        const data = (parsed?.data ?? {}) as Record<string, unknown>;
        const providerStatus = typeof data.status === "string" ? (data.status as string) : null;
        const normalized = normalizeTelnyxStatus(providerStatus);
        const failureReason =
          normalized === "failed"
            ? (typeof data.failure_reason === "string" && (data.failure_reason as string)) ||
              (typeof (data as { failover_status?: unknown }).failover_status === "string" &&
                ((data as { failover_status: string }).failover_status as string)) ||
              null
            : null;
        return { ok: true, providerStatus, normalized, failureReason };
      } catch (e) {
        return {
          ok: false,
          error: `Telnyx status request failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

export async function resolveFaxProvider(): Promise<FaxProvider> {
  const creds = await resolveTelnyxCredentials();
  if (creds) return telnyxProvider(creds);
  return notConfiguredProvider();
}
