// Unit tests for the portal session HMAC sign/verify roundtrip.
// Set the secret BEFORE importing so the module captures it via process.env.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.PORTAL_SESSION_SECRET = "test-secret-portal-1234567890abcdef";

import { signSession, verifySessionToken } from "../session";

describe("portal session HMAC", () => {
  it("roundtrips a valid session", () => {
    const session = {
      clientId: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      inviteId: "33333333-3333-3333-3333-333333333333",
      issuedAt: Date.now(),
    };
    const token = signSession(session);
    assert.ok(token, "expected signed token");
    assert.deepEqual(verifySessionToken(token), session);
  });

  it("rejects a tampered payload", () => {
    const token = signSession({
      clientId: "c",
      organizationId: "o",
      inviteId: "i",
      issuedAt: Date.now(),
    });
    assert.ok(token);
    const [, sig] = token!.split(".");
    const evilPayload = Buffer.from(
      JSON.stringify({ clientId: "evil", organizationId: "o", inviteId: "i", issuedAt: Date.now() }),
      "utf8",
    )
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    assert.equal(verifySessionToken(`${evilPayload}.${sig}`), null);
  });

  it("rejects garbage and missing tokens", () => {
    assert.equal(verifySessionToken(undefined), null);
    assert.equal(verifySessionToken(""), null);
    assert.equal(verifySessionToken("not-a-token"), null);
    assert.equal(verifySessionToken("only.onepart.three"), null);
  });

  it("rejects an expired session", () => {
    const old = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days old
    const token = signSession({
      clientId: "c",
      organizationId: "o",
      inviteId: "i",
      issuedAt: old,
    });
    assert.ok(token);
    assert.equal(verifySessionToken(token), null);
  });
});
