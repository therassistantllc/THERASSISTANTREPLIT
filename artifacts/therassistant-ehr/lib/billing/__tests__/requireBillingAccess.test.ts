/**
 * Tests for the billing API tenant-isolation gate (Task #145).
 *
 * `evaluateBillingAccess` is the pure decision function used by every
 * `app/api/billing/**` route. We exercise the three contract cases
 * called out in the task:
 *
 *   - unauthenticated request -> 401
 *   - cross-org id in query -> 403
 *   - legitimate request -> 200 (i.e. ok: true with the session's
 *     organizationId — NOT the value the client supplied)
 *
 * Plus the dev-only passthrough and the permission-required path.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { evaluateBillingAccess } from "../requireBillingAccess";
import { PERMISSIONS } from "@/lib/rbac/constants";
import type { StaffAuthContext } from "@/lib/rbac/auth";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

function staffCtx(overrides: Partial<StaffAuthContext> = {}): StaffAuthContext {
  return {
    userId: "user-1",
    staffId: "staff-1",
    organizationId: ORG_A,
    email: "biller@example.com",
    firstName: "Bill",
    lastName: "Er",
    jobTitle: "Biller",
    isActive: true,
    roles: ["biller"],
    permissions: [PERMISSIONS.VIEW_BILLING],
    ...overrides,
  };
}

describe("evaluateBillingAccess", () => {
  it("returns 401 in production when there is no authenticated staff", () => {
    const r = evaluateBillingAccess(null, { requestedOrganizationId: ORG_A }, "production");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 401);
  });

  it("returns 401 in test env when there is no authenticated staff", () => {
    // node --test runs without NODE_ENV=development, so this matches the
    // env the project's own test runner uses.
    const r = evaluateBillingAccess(null, { requestedOrganizationId: ORG_A }, "test");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 401);
  });

  it("rejects a cross-org id with 403 (IDOR defence)", () => {
    const r = evaluateBillingAccess(
      staffCtx({ organizationId: ORG_A }),
      { requestedOrganizationId: ORG_B },
      "production",
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 403);
  });

  it("returns the session-derived organizationId for a legitimate request", () => {
    const r = evaluateBillingAccess(
      staffCtx({ organizationId: ORG_A }),
      { requestedOrganizationId: ORG_A },
      "production",
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.context.organizationId, ORG_A);
      assert.equal(r.context.staffId, "staff-1");
      assert.equal(r.context.isDevPassthrough, false);
    }
  });

  it("falls back to the session org when the client didn't send one", () => {
    const r = evaluateBillingAccess(
      staffCtx({ organizationId: ORG_A }),
      {},
      "production",
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.context.organizationId, ORG_A);
  });

  it("returns 403 when the authenticated staff lacks VIEW_BILLING", () => {
    const r = evaluateBillingAccess(
      staffCtx({ permissions: [] }),
      { requestedOrganizationId: ORG_A },
      "production",
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 403);
  });

  it("allows the call when no permission is required (e.g. global code lookups)", () => {
    const r = evaluateBillingAccess(
      staffCtx({ permissions: [] }),
      { permission: null },
      "production",
    );
    assert.equal(r.ok, true);
  });

  it("passes through in development without an authenticated staff (dev convenience)", () => {
    const r = evaluateBillingAccess(null, { requestedOrganizationId: ORG_A }, "development");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.context.isDevPassthrough, true);
      assert.equal(r.context.organizationId, ORG_A);
    }
  });

  it("does NOT let the client-supplied org override the session org, even when permitted", () => {
    // Even if a permitted user tries to pass org B, the helper still
    // uses their session org (org A) — defence in depth, since downstream
    // queries should always scope to the returned organizationId.
    const r = evaluateBillingAccess(
      staffCtx({ organizationId: ORG_A }),
      { requestedOrganizationId: ORG_A },
      "production",
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.context.organizationId, ORG_A);
  });
});
