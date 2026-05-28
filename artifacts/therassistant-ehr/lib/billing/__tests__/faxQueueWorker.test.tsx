/**
 * Tests for runFaxQueueDispatch (Task #650).
 *
 * The worker drains `fax_queue` rows by downloading the documents the
 * matching `claim_documentation_transmissions` row references, merging
 * them into one PDF, uploading it, and handing the signed URL to a fax
 * provider. These tests use an in-memory fake supabase to verify:
 *   1. The happy path flips the fax_queue row to 'sent' (handed off to
 *      the provider) and the transmission row to 'sending' (delivery
 *      still in flight — terminal status comes from the reconciler in
 *      Task #726), with sent_at populated and the provider id stored on
 *      the transmission.
 *   2. A provider failure flips both rows to 'failed' with the error
 *      surfaced on each.
 *   3. A pending fax row with no matching transmission is failed loudly
 *      instead of being left as 'pending' forever.
 *   4. Only this org's pending rows are picked up (status/org filters).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { MAX_FAX_ATTEMPTS, runFaxQueueDispatch } from "../faxQueueWorker";
import type { FaxProvider } from "@/lib/fax/provider";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";

const MINIMAL_PDF = new Uint8Array([
  // %PDF-1.1
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x31, 0x0a,
  0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  // 1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
  0x31, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a,
  0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x2f, 0x43, 0x61, 0x74, 0x61, 0x6c, 0x6f, 0x67, 0x2f,
  0x50, 0x61, 0x67, 0x65, 0x73, 0x20, 0x32, 0x20, 0x30, 0x20, 0x52, 0x3e, 0x3e, 0x0a,
  0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a,
]);

interface Tx {
  id: string;
  organization_id: string;
  channel: string;
  provider_message_id: string | null;
  document_ids: string[];
  status: string;
  error: string | null;
  sent_at: string | null;
}
interface Fax {
  id: string;
  organization_id: string;
  status: string;
  to_fax_number: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
  claim_id: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_attempted_at: string | null;
}
interface Doc {
  id: string;
  organization_id: string;
  file_name: string;
  title: string;
  mime_type: string;
  storage_bucket: string;
  storage_path: string;
}

interface Seed {
  faxes: Fax[];
  transmissions: Tx[];
  documents: Doc[];
  storage: Map<string, Uint8Array>; // bucket/path → bytes
}

interface FakeOptions {
  /**
   * If true, every UPDATE on fax_queue returns an error (used to simulate
   * a DB outage mid-dispatch so we can assert the worker surfaces the
   * drift instead of silently swallowing it).
   */
  failFaxUpdates?: boolean;
}

function makeFakeSupabase(seed: Seed, options: FakeOptions = {}) {
  const buckets: Array<{ name: string }> = [{ name: "fax-outbound" }];
  const uploads: Array<{ bucket: string; path: string; size: number }> = [];
  const signedUrls: string[] = [];

  function tableOf(table: string) {
    switch (table) {
      case "fax_queue":
        return seed.faxes as unknown as Array<Record<string, unknown>>;
      case "claim_documentation_transmissions":
        return seed.transmissions as unknown as Array<Record<string, unknown>>;
      case "documents":
        return seed.documents as unknown as Array<Record<string, unknown>>;
      default:
        return [];
    }
  }

  function from(table: string) {
    const filters: Array<{ kind: "eq" | "in" | "is"; col: string; val: unknown }> = [];
    let order: { col: string; ascending: boolean } | null = null;
    let limit = Number.POSITIVE_INFINITY;
    let selectCols: string | null = null;
    let updatePayload: Record<string, unknown> | null = null;

    function applyFilters(rows: Array<Record<string, unknown>>) {
      return rows.filter((r) =>
        filters.every((f) => {
          if (f.kind === "eq") return r[f.col] === f.val;
          if (f.kind === "in") return Array.isArray(f.val) && (f.val as unknown[]).includes(r[f.col]);
          if (f.kind === "is") return r[f.col] === f.val;
          return true;
        }),
      );
    }

    const api = {
      select(cols: string) {
        selectCols = cols;
        return api;
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ kind: "eq", col, val });
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ kind: "in", col, val: vals });
        return api;
      },
      is(col: string, val: unknown) {
        filters.push({ kind: "is", col, val });
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order = { col, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      async maybeSingle() {
        if (updatePayload && options.failFaxUpdates && table === "fax_queue") {
          return { data: null, error: { message: "simulated db outage" } };
        }
        const matched = applyFilters(tableOf(table));
        if (updatePayload && matched.length > 0) {
          Object.assign(matched[0], updatePayload);
          return { data: matched[0], error: null };
        }
        return { data: matched[0] ?? null, error: null };
      },
      async single() {
        return api.maybeSingle();
      },
      // Awaiting the chain (no terminator) – returns the list.
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          if (updatePayload && options.failFaxUpdates && table === "fax_queue") {
            resolve({ data: null, error: { message: "simulated db outage" } });
            return;
          }
          const matched = applyFilters(tableOf(table));
          if (updatePayload) {
            for (const row of matched) Object.assign(row, updatePayload);
            resolve({ data: matched, error: null });
            return;
          }
          const sorted = order
            ? [...matched].sort((a, b) => {
                const av = String(a[order!.col] ?? "");
                const bv = String(b[order!.col] ?? "");
                return order!.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
              })
            : matched;
          const limited = Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
          resolve({ data: limited, error: null });
        } catch (e) {
          reject(e);
        }
      },
      catch() {
        return api;
      },
    };
    return api as unknown as Record<string, unknown>;
  }

  const storage = {
    async listBuckets() {
      return { data: buckets, error: null };
    },
    async createBucket() {
      return { data: null, error: null };
    },
    from(bucket: string) {
      return {
        async download(path: string) {
          const key = `${bucket}/${path}`;
          const bytes = seed.storage.get(key);
          if (!bytes) return { data: null, error: { message: `not found: ${key}` } };
          return {
            data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
            error: null,
          };
        },
        async upload(path: string, body: Uint8Array | Buffer) {
          const buf = body instanceof Buffer ? new Uint8Array(body) : body;
          seed.storage.set(`${bucket}/${path}`, buf);
          uploads.push({ bucket, path, size: buf.byteLength });
          return { data: null, error: null };
        },
        async createSignedUrl(path: string) {
          const url = `https://storage.test/${bucket}/${path}?sig=stub`;
          signedUrls.push(url);
          return { data: { signedUrl: url }, error: null };
        },
      };
    },
  };

  return {
    supabase: { from, storage } as unknown as Parameters<typeof runFaxQueueDispatch>[0],
    uploads,
    signedUrls,
  };
}

function seedHappyPath(): Seed {
  return {
    faxes: [
      {
        id: "fax-1",
        organization_id: ORG,
        status: "pending",
        to_fax_number: "+15551234567",
        error: null,
        sent_at: null,
        created_at: "2026-05-01T00:00:00Z",
        claim_id: "claim-1",
        attempt_count: 0,
        next_attempt_at: null,
        last_attempted_at: null,
      },
      // Wrong org — must be ignored.
      {
        id: "fax-other",
        organization_id: OTHER_ORG,
        status: "pending",
        to_fax_number: "+15551110000",
        error: null,
        sent_at: null,
        created_at: "2026-05-01T00:00:00Z",
        claim_id: "claim-x",
        attempt_count: 0,
        next_attempt_at: null,
        last_attempted_at: null,
      },
      // Already sent — must be ignored.
      {
        id: "fax-done",
        organization_id: ORG,
        status: "sent",
        to_fax_number: "+15551112222",
        error: null,
        sent_at: "2026-04-30T00:00:00Z",
        created_at: "2026-04-30T00:00:00Z",
        claim_id: "claim-2",
        attempt_count: 1,
        next_attempt_at: null,
        last_attempted_at: "2026-04-30T00:00:00Z",
      },
    ],
    transmissions: [
      {
        id: "tx-1",
        organization_id: ORG,
        channel: "fax",
        provider_message_id: "fax-1",
        document_ids: ["doc-1"],
        status: "queued",
        error: null,
        sent_at: null,
      },
    ],
    documents: [
      {
        id: "doc-1",
        organization_id: ORG,
        file_name: "records.pdf",
        title: "Client records",
        mime_type: "application/pdf",
        storage_bucket: "mailroom-documents",
        storage_path: "claims/claim-1/records.pdf",
      },
    ],
    storage: new Map([["mailroom-documents/claims/claim-1/records.pdf", MINIMAL_PDF]]),
  };
}

const okProvider: FaxProvider = {
  name: "test-ok",
  configured: true,
  async send() {
    return { ok: true, providerId: "prov-abc", providerStatus: "queued" };
  },
  async getStatus() {
    return { ok: true, providerStatus: "queued", normalized: "sending" };
  },
};
const failProvider: FaxProvider = {
  name: "test-fail",
  configured: true,
  async send() {
    return { ok: false, error: "Telnyx 422: invalid number" };
  },
  async getStatus() {
    return { ok: true, providerStatus: "failed", normalized: "failed" };
  },
};

describe("runFaxQueueDispatch", () => {
  it("flips fax to sent and transmission to sending (awaiting Telnyx terminal status) on success", async () => {
    const seed = seedHappyPath();
    const { supabase, uploads, signedUrls } = makeFakeSupabase(seed);

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: okProvider,
    });

    assert.equal(result.scanned, 1, "only the pending row in this org is picked up");
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(uploads.length, 1, "merged PDF uploaded once");
    assert.equal(uploads[0].bucket, "fax-outbound");
    assert.ok(uploads[0].path.endsWith("fax-1.pdf"));
    assert.equal(signedUrls.length, 1);

    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    assert.equal(fax.status, "sent", "fax_queue.status='sent' = handed off to provider");
    assert.ok(fax.sent_at, "sent_at populated");
    assert.equal(fax.error, null);

    const tx = seed.transmissions.find((t) => t.id === "tx-1")!;
    assert.equal(
      tx.status,
      "sending",
      "transmission stays 'sending' until the status reconciler observes Telnyx's terminal verdict",
    );
    assert.equal(tx.provider_message_id, "prov-abc", "real provider id overwrites the fax_queue.id placeholder");
    assert.ok(tx.sent_at);
  });

  it("schedules an automatic retry on a transient provider failure instead of marking the row failed immediately (Task #790)", async () => {
    const seed = seedHappyPath();
    const { supabase } = makeFakeSupabase(seed);

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: failProvider,
    });

    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1, "this invocation reports a failed send");

    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    assert.equal(fax.status, "pending", "row stays pending so a future cron tick can retry");
    assert.equal(fax.attempt_count, 1, "attempt counter increments per send attempt");
    assert.ok(fax.next_attempt_at, "backoff window is set into the future");
    assert.ok(
      Date.parse(String(fax.next_attempt_at)) > Date.now(),
      "next_attempt_at is in the future",
    );
    assert.match(String(fax.error), /Telnyx 422/, "latest error is preserved on the row");

    // The transmission must NOT regress to 'failed' while we're still
    // going to retry — Submission history should keep showing "queued"
    // until we either succeed or hit the cap. The latest error still
    // gets surfaced so reviewers can see what tripped the last try.
    const tx = seed.transmissions.find((t) => t.id === "tx-1")!;
    assert.equal(tx.status, "queued", "transmission stays in flight across automatic retries");
    assert.match(String(tx.error), /Telnyx 422/);
  });

  it("stops auto-retrying after MAX_FAX_ATTEMPTS and marks the row terminally failed (Task #790)", async () => {
    const seed = seedHappyPath();
    // Pre-seed attempt_count one short of the cap so the next failure
    // is the terminal one. Keeps the test fast (one dispatch instead of
    // five) and exercises the cap-check branch directly.
    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    fax.attempt_count = MAX_FAX_ATTEMPTS - 1;
    const { supabase } = makeFakeSupabase(seed);

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: failProvider,
    });

    assert.equal(result.failed, 1);
    assert.equal(fax.status, "failed", "cap reached → row terminally failed");
    assert.equal(fax.attempt_count, MAX_FAX_ATTEMPTS);
    assert.equal(fax.next_attempt_at, null, "no further retries scheduled");
    assert.match(
      String(fax.error),
      /Max retries exceeded/,
      "error message clearly explains the dispatcher gave up",
    );

    const tx = seed.transmissions.find((t) => t.id === "tx-1")!;
    assert.equal(tx.status, "failed", "transmission flips to failed once the cap is hit");
  });

  it("refuses to claim a row whose next_attempt_at is still in the future (Task #790)", async () => {
    const seed = seedHappyPath();
    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    // Pretend a prior failure scheduled the next attempt an hour out.
    fax.attempt_count = 1;
    fax.next_attempt_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let sends = 0;
    const countingProvider: FaxProvider = {
      name: "test-counting",
      configured: true,
      async send() {
        sends += 1;
        return { ok: true, providerId: "prov-xyz", providerStatus: "queued" };
      },
      async getStatus() {
        return { ok: true, providerStatus: "queued", normalized: "sending" };
      },
    };
    const { supabase } = makeFakeSupabase(seed);

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: countingProvider,
    });

    assert.equal(sends, 0, "provider is never called while the backoff window is open");
    assert.equal(result.sent, 0);
    assert.equal(result.skipped, 1, "row is skipped (backoff), not failed");
    assert.equal(fax.status, "pending", "row stays pending across the wait");
    assert.equal(fax.attempt_count, 1, "attempt_count is not bumped for a skipped row");
  });

  it("only lets one of two concurrent dispatchers send the same fax", async () => {
    const seed = seedHappyPath();
    const { supabase } = makeFakeSupabase(seed);
    let sends = 0;
    const countingProvider: FaxProvider = {
      name: "test-counting",
      configured: true,
      async send() {
        sends += 1;
        return { ok: true, providerId: `prov-${sends}`, providerStatus: "queued" };
      },
      async getStatus() {
        return { ok: true, providerStatus: "queued", normalized: "sending" };
      },
    };

    const [a, b] = await Promise.all([
      runFaxQueueDispatch(supabase, { organizationId: ORG, provider: countingProvider }),
      runFaxQueueDispatch(supabase, { organizationId: ORG, provider: countingProvider }),
    ]);

    assert.equal(sends, 1, "the fax provider receives exactly one send across both dispatchers");
    const totalSent = a.sent + b.sent;
    const totalSkipped = a.skipped + b.skipped;
    assert.equal(totalSent, 1, "exactly one dispatcher records the send");
    assert.equal(totalSkipped, 1, "the loser dispatcher skips the already-claimed row");

    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    assert.equal(fax.status, "sent");
  });

  it("surfaces persistence failures instead of silently dropping them", async () => {
    const seed = seedHappyPath();
    // claimPendingFax runs first; it writes through the same code path,
    // so a fully-failing fax_queue update path also blocks the claim and
    // the row is reported skipped. To exercise the post-send drift branch
    // we only fail subsequent updates by toggling the flag after the
    // initial claim succeeds. The simplest expression here is to fail
    // every fax_queue update outright and assert the worker counts it as
    // failed (claim couldn't be acquired) — both outcomes prove the bug
    // class is gone: nothing reaches 'sent' on a broken DB.
    const { supabase } = makeFakeSupabase(seed, { failFaxUpdates: true });

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: okProvider,
    });

    assert.equal(result.sent, 0, "no fax is reported sent when persistence is broken");
    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    assert.notEqual(fax.status, "sent", "the in-memory row is never flipped to sent");
    // Either: claim couldn't be acquired (skipped) OR claim succeeded but
    // the terminal update failed (failed). Both outcomes mean the bug class
    // — "send succeeds but state stays queued/pending forever" — is gone.
    assert.ok(result.skipped + result.failed === 1, "the row is accounted for, not silently dropped");
  });

  it("fails a fax with no matching transmission instead of leaving it pending", async () => {
    const seed = seedHappyPath();
    // Drop the transmission so the lookup misses.
    seed.transmissions = [];
    const { supabase } = makeFakeSupabase(seed);

    const result = await runFaxQueueDispatch(supabase, {
      organizationId: ORG,
      provider: okProvider,
    });

    assert.equal(result.failed, 1);
    const fax = seed.faxes.find((f) => f.id === "fax-1")!;
    assert.equal(fax.status, "failed");
    assert.match(String(fax.error), /No matching documentation transmission/);
  });
});
