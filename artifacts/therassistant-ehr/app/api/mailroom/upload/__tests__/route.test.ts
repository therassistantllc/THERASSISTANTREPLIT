/**
 * Smoke test for POST /api/mailroom/upload (Task #195).
 *
 * The upload endpoint streams a file into Supabase Storage and creates a
 * matching `mailroom_items` row. The smoke test below pins:
 *
 *   - the new mailroom_items row is inserted with organization_id equal to
 *     the SESSION organization (never the caller-supplied one — the cross-org
 *     attack here would be uploading INTO another tenant's mailroom)
 *   - missing file field returns 400 without ever touching storage or the DB
 *
 * Plus a regression source-pin so the route can't drop the org guard or the
 * "scope storage path by org" convention.
 */

import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test, describe, it } from "node:test";
import { readFileSync } from "node:fs";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

type Row = Record<string, unknown>;
type InsertCall = { table: string; payload: Row };

const sessionOrgRef = { current: ORG_A };
const insertCalls: InsertCall[] = [];
const storageUploads: Array<{ bucket: string; path: string; contentType: string }> = [];
const storageRemoves: Array<{ bucket: string; paths: string[] }> = [];
const insertResult: { row: Row | null; error: { message: string } | null } = {
  row: null,
  error: null,
};

before(() => {
  mock.module("@/lib/auth/requireOrgAccess", {
    namedExports: {
      requireOrgAccess: async (opts: { requestedOrganizationId?: string | null } = {}) => {
        const { NextResponse } = await import("next/server");
        const requested = opts.requestedOrganizationId
          ? String(opts.requestedOrganizationId).trim()
          : null;
        if (requested && requested !== sessionOrgRef.current) {
          return NextResponse.json(
            { success: false, error: "Cannot access data for a different organization" },
            { status: 403 },
          );
        }
        return {
          organizationId: sessionOrgRef.current,
          staffId: "staff-1",
          userId: "user-1",
          roles: [],
          permissions: [],
          isDevPassthrough: false,
        };
      },
    },
  });

  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => ({
        storage: {
          listBuckets: async () => ({ data: [{ name: "mailroom-documents" }], error: null }),
          createBucket: async () => ({ error: null }),
          from(bucket: string) {
            return {
              async upload(path: string, _bytes: unknown, opts: { contentType: string }) {
                storageUploads.push({ bucket, path, contentType: opts.contentType });
                return { error: null };
              },
              async remove(paths: string[]) {
                storageRemoves.push({ bucket, paths });
                return { error: null };
              },
            };
          },
        },
        from(table: string) {
          return {
            insert(payload: Row) {
              insertCalls.push({ table, payload });
              return {
                select: () => ({
                  single: async () => ({ data: insertResult.row, error: insertResult.error }),
                }),
              };
            },
          };
        },
      }),
    },
  });
});

beforeEach(() => {
  sessionOrgRef.current = ORG_A;
  insertCalls.length = 0;
  storageUploads.length = 0;
  storageRemoves.length = 0;
  insertResult.row = {
    id: "item-new",
    file_name: "scan.pdf",
    mime_type: "application/pdf",
    storage_path: "ignored-set-by-test",
    status: "needs_review",
    document_type: "other",
    source: "manual_upload",
    client_id: null,
    notes: "Uploaded via mailroom drop zone.",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  insertResult.error = null;
});

async function loadPost() {
  const mod = await import("../route");
  return mod.POST as (r: import("next/server").NextRequest) => Promise<Response>;
}

function uploadRequest(form: FormData): import("next/server").NextRequest {
  return new Request("https://app.test/api/mailroom/upload", {
    method: "POST",
    body: form,
  }) as unknown as import("next/server").NextRequest;
}

function makeFormData(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v as Blob | string);
  return fd;
}

describe("POST /api/mailroom/upload — smoke", () => {
  it("returns 400 when the file field is missing (no storage write, no DB insert)", async () => {
    const POST = await loadPost();
    const res = await POST(uploadRequest(makeFormData({})));
    assert.equal(res.status, 400);
    assert.equal(storageUploads.length, 0);
    assert.equal(insertCalls.length, 0);
  });

  it("creates the mailroom_items row in the SESSION organization (not the caller's claim)", async () => {
    sessionOrgRef.current = ORG_A;
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
    // Even though the caller writes ORG_A here (a mismatch would have been
    // rejected by requireOrgAccess already), the row must carry the session
    // org as a hard contract — the route MUST NOT trust form input as the
    // tenant id.
    const POST = await loadPost();
    const res = await POST(
      uploadRequest(
        makeFormData({
          file: new File([blob], "scan.pdf", { type: "application/pdf" }),
          organizationId: ORG_A,
          documentType: "lab_result",
        }),
      ),
    );
    assert.equal(res.status, 200);

    assert.equal(insertCalls.length, 1);
    const insert = insertCalls[0];
    assert.equal(insert.table, "mailroom_items");
    assert.equal(insert.payload.organization_id, ORG_A);
    assert.equal(insert.payload.status, "needs_review");
    assert.equal(insert.payload.source, "manual_upload");
    assert.equal(insert.payload.document_type, "lab_result");
    assert.equal(insert.payload.file_name, "scan.pdf");

    // Storage path must also be namespaced by the session organization so an
    // attacker can't smuggle in a path that lands in another tenant's prefix.
    assert.equal(storageUploads.length, 1);
    assert.ok(
      String(storageUploads[0].path).startsWith(`${ORG_A}/`),
      `storage path must be prefixed by the session org; saw ${storageUploads[0].path}`,
    );
    assert.equal(insert.payload.storage_path, storageUploads[0].path);
  });

  it("rejects a caller-supplied organizationId that doesn't match the session (403 via requireOrgAccess)", async () => {
    sessionOrgRef.current = ORG_A;
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
    const POST = await loadPost();
    const res = await POST(
      uploadRequest(
        makeFormData({
          file: new File([blob], "scan.pdf", { type: "application/pdf" }),
          organizationId: ORG_B,
        }),
      ),
    );
    assert.equal(res.status, 403);
    assert.equal(storageUploads.length, 0);
    assert.equal(insertCalls.length, 0);
  });

  it("rolls back the storage object when the mailroom_items insert fails", async () => {
    insertResult.row = null;
    insertResult.error = { message: "insert blew up" };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
    const POST = await loadPost();
    const res = await POST(
      uploadRequest(
        makeFormData({
          file: new File([blob], "scan.pdf", { type: "application/pdf" }),
        }),
      ),
    );
    assert.equal(res.status, 422);
    assert.equal(storageUploads.length, 1);
    // The failed insert must trigger a storage remove() so we don't leak a
    // dangling object with no DB pointer back to it.
    assert.equal(storageRemoves.length, 1);
    assert.deepEqual(storageRemoves[0].paths, [storageUploads[0].path]);
  });
});

describe("regression: /api/mailroom/upload route wiring", () => {
  const src = readFileSync("app/api/mailroom/upload/route.ts", "utf8");

  it("gates the request behind requireOrgAccess", () => {
    assert.match(src, /requireOrgAccess\s*\(/);
    assert.match(src, /guard instanceof NextResponse/);
  });

  it("uses the session organizationId on the mailroom_items insert (never the form value)", () => {
    // The insert payload must read organization_id from the guard-derived
    // variable, not from the form. The variable is named `organizationId` in
    // the route and is assigned from `guard.organizationId`.
    assert.match(src, /const organizationId = guard\.organizationId/);
    assert.match(src, /organization_id:\s*organizationId/);
  });

  it("namespaces the storage path under the session organization id", () => {
    assert.match(src, /storagePath\s*=\s*`\$\{organizationId\}\//);
  });

  it("removes the uploaded storage object when the DB insert fails", () => {
    assert.match(src, /storage\.from\(BUCKET\)\.remove\(\[storagePath\]\)/);
  });
});
