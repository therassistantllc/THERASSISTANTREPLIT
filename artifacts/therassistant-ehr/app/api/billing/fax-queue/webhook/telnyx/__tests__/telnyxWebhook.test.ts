/**
 * Tests for the Telnyx fax webhook receiver (Task #823).
 *
 * Covers:
 *   1. Signature verification — real Ed25519 key pair round-trip; rejects
 *      tampered body, stale timestamp, missing key, wrong key.
 *   2. Event routing — fax.delivered flips 'sending' → 'delivered';
 *      fax.failed flips with the provider's failure_reason as the error.
 *   3. Non-terminal events (fax.queued / fax.sending) leave the row alone.
 *   4. Idempotency — re-delivering a terminal event does not re-touch the
 *      row, and an out-of-order webhook on an already-terminal row is
 *      reported but not applied.
 *   5. Cross-org lookup — the webhook has no organization id, so the
 *      provider_message_id alone must locate the row.
 *   6. Unknown fax id surfaces matched=false but still 200 (so Telnyx
 *      stops retrying).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";

import { verifyTelnyxSignature } from "@/lib/fax/provider";
import {
  processTelnyxFaxWebhook,
  type TelnyxWebhookDeps,
  type WebhookSupabase,
} from "../route";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Generate an Ed25519 keypair and the base64-encoded raw 32-byte public key. */
function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Export raw 32-byte key by stripping the 12-byte SPKI prefix.
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const publicKeyB64 = raw.toString("base64");
  return { privateKey, publicKey, publicKeyB64 };
}

function signBody(
  privateKey: Parameters<typeof edSign>[2],
  body: string,
  ts: number = Math.floor(Date.now() / 1000),
) {
  const signature = edSign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey);
  return { signatureB64: signature.toString("base64"), ts: String(ts) };
}

interface Tx {
  id: string;
  organization_id: string;
  channel: string;
  provider_message_id: string;
  status: string;
  error: string | null;
}

function makeFakeSupabase(txs: Tx[]): WebhookSupabase {
  function from(table: string) {
    if (table !== "claim_documentation_transmissions") {
      throw new Error(`unexpected table ${table}`);
    }
    const ctx: {
      channel?: string;
      providerId?: string;
      org?: string;
      id?: string;
      limitN?: number;
      update?: Record<string, unknown>;
    } = {};

    function matchSelect() {
      let rows = txs.filter((t) =>
        ctx.channel ? t.channel === ctx.channel : true,
      );
      if (ctx.providerId) rows = rows.filter((t) => t.provider_message_id === ctx.providerId);
      if (typeof ctx.limitN === "number") rows = rows.slice(0, ctx.limitN);
      return { data: rows, error: null };
    }
    function resolveUpdate() {
      if (ctx.id) {
        const row = txs.find((t) => t.id === ctx.id && (!ctx.org || t.organization_id === ctx.org));
        if (row) Object.assign(row, ctx.update ?? {});
      }
      return { data: null, error: null };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: () => builder,
      update: (v: unknown) => {
        ctx.update = v as Record<string, unknown>;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        if (col === "channel") ctx.channel = String(val);
        else if (col === "provider_message_id") ctx.providerId = String(val);
        else if (col === "organization_id") ctx.org = String(val);
        else if (col === "id") ctx.id = String(val);
        return builder;
      },
      in: () => builder,
      limit: (n: number) => {
        ctx.limitN = n;
        // limit() is the terminal call on the select path; return a thenable
        // so `await sb.from(...).select(...).eq(...).eq(...).limit(2)` resolves.
        return Promise.resolve(matchSelect());
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (ctx.update) return resolve(resolveUpdate());
        return resolve(matchSelect());
      },
    };
    return builder;
  }
  return { from };
}

function depsFor(supabase: WebhookSupabase, publicKey: string | null = "ignored"): TelnyxWebhookDeps {
  return {
    supabaseFactory: () => supabase,
    publicKeyResolver: async () => publicKey,
  };
}

function eventBody(eventType: string, faxId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      id: "evt-" + Math.random().toString(16).slice(2),
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      payload: { fax_id: faxId, ...extra },
    },
  });
}

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";

/* -------------------------------------------------------------------------- */
/* 1. Signature verification                                                  */
/* -------------------------------------------------------------------------- */

describe("verifyTelnyxSignature", () => {
  it("accepts a real Ed25519 signature over `${ts}|${body}`", () => {
    const { privateKey, publicKeyB64 } = makeKeyPair();
    const body = '{"data":{"event_type":"fax.delivered"}}';
    const { signatureB64, ts } = signBody(privateKey, body);
    assert.equal(verifyTelnyxSignature(body, signatureB64, ts, publicKeyB64), true);
  });

  it("rejects a tampered body", () => {
    const { privateKey, publicKeyB64 } = makeKeyPair();
    const body = '{"data":{"event_type":"fax.delivered"}}';
    const { signatureB64, ts } = signBody(privateKey, body);
    const tampered = body.replace("delivered", "failed");
    assert.equal(verifyTelnyxSignature(tampered, signatureB64, ts, publicKeyB64), false);
  });

  it("rejects a signature made by a different key", () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    const body = "{}";
    const { signatureB64, ts } = signBody(a.privateKey, body);
    assert.equal(verifyTelnyxSignature(body, signatureB64, ts, b.publicKeyB64), false);
  });

  it("rejects timestamps outside the replay window", () => {
    const { privateKey, publicKeyB64 } = makeKeyPair();
    const body = "{}";
    const stale = Math.floor(Date.now() / 1000) - 60 * 10;
    const { signatureB64, ts } = signBody(privateKey, body, stale);
    assert.equal(verifyTelnyxSignature(body, signatureB64, ts, publicKeyB64), false);
  });

  it("rejects missing signature / key / timestamp", () => {
    const { privateKey, publicKeyB64 } = makeKeyPair();
    const body = "{}";
    const { signatureB64, ts } = signBody(privateKey, body);
    assert.equal(verifyTelnyxSignature(body, null, ts, publicKeyB64), false);
    assert.equal(verifyTelnyxSignature(body, signatureB64, null, publicKeyB64), false);
    assert.equal(verifyTelnyxSignature(body, signatureB64, ts, null), false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Event routing                                                           */
/* -------------------------------------------------------------------------- */

describe("processTelnyxFaxWebhook", () => {
  it("flips a 'sending' transmission to 'delivered' on fax.delivered", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-1",
        status: "sending",
        error: null,
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.delivered", "telnyx-fax-1", { status: "delivered" }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.flipped, true);
    assert.equal(res.body.matched, true);
    assert.equal(txs[0].status, "delivered");
    assert.equal(txs[0].error, null);
  });

  it("flips to 'failed' and surfaces failure_reason on fax.failed", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-2",
        status: "sending",
        error: null,
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.failed", "telnyx-fax-2", {
        status: "failed",
        failure_reason: "line_busy",
      }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.flipped, true);
    assert.equal(txs[0].status, "failed");
    assert.match(String(txs[0].error), /line_busy/);
  });

  it("leaves the row alone on intermediate events (fax.sending / fax.queued)", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-3",
        status: "sending",
        error: null,
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.sending", "telnyx-fax-3", { status: "sending" }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.flipped, false);
    assert.equal(res.body.matched, true);
    assert.equal(txs[0].status, "sending");
  });

  it("is idempotent — re-delivery of a terminal event does not re-touch the row", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-4",
        status: "delivered",
        error: null,
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.delivered", "telnyx-fax-4", { status: "delivered" }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.flipped, false);
    assert.equal(res.body.alreadyTerminal, true);
    assert.equal(txs[0].status, "delivered");
  });

  it("does not overwrite a 'failed' row with a late 'delivered' event", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-5",
        status: "failed",
        error: "line_busy",
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.delivered", "telnyx-fax-5", { status: "delivered" }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.body.alreadyTerminal, true);
    assert.equal(txs[0].status, "failed");
    assert.equal(txs[0].error, "line_busy");
  });

  it("looks up the row cross-org (webhook has no organization id)", async () => {
    const txs: Tx[] = [
      {
        id: "tx-other",
        organization_id: OTHER_ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-6",
        status: "sending",
        error: null,
      },
    ];
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.delivered", "telnyx-fax-6", { status: "delivered" }),
      depsFor(makeFakeSupabase(txs)),
    );
    assert.equal(res.body.flipped, true);
    assert.equal(txs[0].status, "delivered");
  });

  it("returns 200 matched=false for an unknown fax id (so Telnyx stops retrying)", async () => {
    const res = await processTelnyxFaxWebhook(
      eventBody("fax.delivered", "telnyx-never-seen", { status: "delivered" }),
      depsFor(makeFakeSupabase([])),
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.matched, false);
    assert.equal(res.body.flipped, false);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await processTelnyxFaxWebhook("not json", depsFor(makeFakeSupabase([])));
    assert.equal(res.status, 400);
  });

  it("400s when the payload has no fax id", async () => {
    const body = JSON.stringify({ data: { event_type: "fax.delivered", payload: {} } });
    const res = await processTelnyxFaxWebhook(body, depsFor(makeFakeSupabase([])));
    assert.equal(res.status, 400);
  });

  it("ignores non-fax event families with 200", async () => {
    const body = JSON.stringify({ data: { event_type: "message.received", payload: {} } });
    const res = await processTelnyxFaxWebhook(body, depsFor(makeFakeSupabase([])));
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, true);
  });

  it("falls back to `payload.id` when `payload.fax_id` is absent", async () => {
    const txs: Tx[] = [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "telnyx-fax-7",
        status: "sending",
        error: null,
      },
    ];
    const body = JSON.stringify({
      data: {
        event_type: "fax.delivered",
        payload: { id: "telnyx-fax-7", status: "delivered" },
      },
    });
    const res = await processTelnyxFaxWebhook(body, depsFor(makeFakeSupabase(txs)));
    assert.equal(res.body.flipped, true);
    assert.equal(txs[0].status, "delivered");
  });
});
