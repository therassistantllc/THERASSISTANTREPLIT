/**
 * Tests for the 277CA auto-routing classifier introduced in Task #444.
 *
 * Verifies that we pull an actionable hand-off decision out of the
 * parsed STC entries on a 277CA acknowledgement so the workqueue
 * service can defer obvious member / provider rejects on intake
 * without waiting for a biller to triage them.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  classifyRejection277CaFromStcEntries,
  pickAutoRouteForRejection277Ca,
  loadRejection277CaAutoRouteSettings,
  REJECTION_277CA_AUTOROUTE_DEFAULTS,
  REJECTION_277CA_AUTOROUTE_SETTING_KEY,
} from "../rejections277ca";

describe("classifyRejection277CaFromStcEntries", () => {
  it("routes subscriber-entity STC entries to invalid_member", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A7", status: "562", entity: "IL" },
    ]);
    assert.equal(tab, "invalid_member");
  });

  it("routes client-entity (QC) STC entries to invalid_member", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A7", status: "21", entity: "QC" },
    ]);
    assert.equal(tab, "invalid_member");
  });

  it("routes rendering-provider STC entries to invalid_provider", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A7", status: "562", entity: "82" },
    ]);
    assert.equal(tab, "invalid_provider");
  });

  it("routes billing-provider STC entries to invalid_provider", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A8", status: "496", entity: "85" },
    ]);
    assert.equal(tab, "invalid_provider");
  });

  it("routes receiver/trading-partner STC entries to invalid_payer_id", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A8", status: "116", entity: "40" },
    ]);
    assert.equal(tab, "invalid_payer_id");
  });

  it("prefers member over provider when both signals are present", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A7", status: "562", entity: "82" },
      { category: "A7", status: "562", entity: "IL" },
    ]);
    assert.equal(tab, "invalid_member");
  });

  it("ignores accepted STC entries (A1/A2/A5) and only acts on rejects", () => {
    const tab = classifyRejection277CaFromStcEntries([
      { category: "A2", status: "20", entity: "IL" },
    ]);
    assert.equal(tab, null);
  });

  it("returns null when there are no actionable STC entries", () => {
    assert.equal(classifyRejection277CaFromStcEntries([]), null);
    assert.equal(classifyRejection277CaFromStcEntries(null), null);
    assert.equal(
      classifyRejection277CaFromStcEntries([{ category: "A7", status: "21", entity: "PR" }]),
      null,
    );
  });
});

describe("pickAutoRouteForRejection277Ca", () => {
  it("returns routed_to_eligibility for a member-entity reject", () => {
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries: [{ category: "A7", status: "562", entity: "IL" }],
    });
    assert.deepEqual(decision, { tab: "invalid_member", reason: "routed_to_eligibility" });
  });

  it("returns routed_to_credentialing for a provider-entity reject", () => {
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries: [{ category: "A8", status: "496", entity: "85" }],
    });
    assert.deepEqual(decision, { tab: "invalid_provider", reason: "routed_to_credentialing" });
  });

  it("falls back to the message-keyword classifier when STC has no actionable entity", () => {
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries: [{ category: "A7", status: "562", entity: "PR" }],
      message: "Subscriber not found in eligibility file",
    });
    assert.deepEqual(decision, { tab: "invalid_member", reason: "routed_to_eligibility" });
  });

  it("returns null when the only signal is payer-id (no downstream queue today)", () => {
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries: [{ category: "A8", status: "116", entity: "40" }],
    });
    assert.equal(decision, null);
  });

  it("returns null when nothing is auto-routable", () => {
    const decision = pickAutoRouteForRejection277Ca({
      stcEntries: [{ category: "A7", status: "562", entity: "PR" }],
      message: "Charge amount does not match service line totals",
    });
    assert.equal(decision, null);
  });
});

describe("loadRejection277CaAutoRouteSettings", () => {
  function makeFake(row: { setting_value: unknown } | null, errored = false) {
    return {
      from(table: string) {
        assert.equal(table, "system_settings");
        return {
          select() {
            return this;
          },
          eq(_col: string, _val: unknown) {
            return this;
          },
          async maybeSingle() {
            if (errored) return { data: null, error: { message: "boom" } };
            return { data: row, error: null };
          },
        };
      },
    };
  }

  it("defaults to enabled when no row exists", async () => {
    const settings = await loadRejection277CaAutoRouteSettings(makeFake(null), "org-1");
    assert.deepEqual(settings, REJECTION_277CA_AUTOROUTE_DEFAULTS);
  });

  it("respects an explicit disabled flag", async () => {
    const settings = await loadRejection277CaAutoRouteSettings(
      makeFake({ setting_value: { enabled: false } }),
      "org-1",
    );
    assert.equal(settings.enabled, false);
    assert.equal(settings.routeInvalidMember, true);
    assert.equal(settings.routeInvalidProvider, true);
  });

  it("allows per-tab opt-out", async () => {
    const settings = await loadRejection277CaAutoRouteSettings(
      makeFake({
        setting_value: {
          enabled: true,
          route_invalid_member: false,
          route_invalid_provider: true,
        },
      }),
      "org-1",
    );
    assert.deepEqual(settings, {
      enabled: true,
      routeInvalidMember: false,
      routeInvalidProvider: true,
    });
  });

  it("falls back to defaults on a query error rather than blocking intake", async () => {
    const settings = await loadRejection277CaAutoRouteSettings(makeFake(null, true), "org-1");
    assert.deepEqual(settings, REJECTION_277CA_AUTOROUTE_DEFAULTS);
  });

  it("exposes the setting key used by the settings page", () => {
    assert.equal(REJECTION_277CA_AUTOROUTE_SETTING_KEY, "billing.rejections_277ca_autoroute");
  });
});
