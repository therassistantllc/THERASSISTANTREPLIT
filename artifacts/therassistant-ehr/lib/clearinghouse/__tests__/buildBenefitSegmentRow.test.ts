// Regression test for CAQH CORE vEB.1.0 attribution integrity: when
// resolveAttributionRouting picks a dependent client_id, both the
// eligibility_checks parent row AND every eligibility_benefit_segments
// child row must persist under the SAME routed client_id, never under
// the originally requested subscriber id.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAttributionRouting } from "../attributionRouting";
import { buildBenefitSegmentRow } from "../buildBenefitSegmentRow";
import type { AttributionDecision } from "../../edi/availity270/attribution";

describe("benefit segment routing integrity", () => {
  it("uses the dependent's routed client_id for every child segment row when routing reroutes", async () => {
    const decision: AttributionDecision = {
      target: "dependent",
      matchesRequestedClient: false,
      mismatchReasons: ["name_mismatch", "dob_mismatch"],
      attributedName: "Sam Doe",
    };

    const routing = await resolveAttributionRouting({
      requestedClientId: "subscriber-1",
      organizationId: "org-1",
      decision,
      parsedDependent: { firstName: "Sam", lastName: "Doe", dob: "2015-06-01" },
      lookup: async () => ["dependent-42"],
    });

    assert.equal(routing.routedClientId, "dependent-42");
    assert.equal(routing.routedToRequestedClient, false);

    const segments = [
      { eligibilityCode: "1", segmentIndex: 0, category: "active" },
      { eligibilityCode: "B", segmentIndex: 1, category: "copay", monetaryAmount: 30 },
      { eligibilityCode: "C", segmentIndex: 2, category: "deductible", monetaryAmount: 1500 },
    ];

    const rows = segments.map((s) =>
      buildBenefitSegmentRow({
        eligibilityCheckId: "check-1",
        organizationId: "org-1",
        routedClientId: routing.routedClientId,
        payerId: "PAYER",
        payerName: "Test Payer",
        segment: s,
      }),
    );

    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.client_id, "dependent-42",
        "every benefit segment must inherit the routed dependent client_id");
      assert.notEqual(row.client_id, "subscriber-1");
      assert.equal(row.eligibility_check_id, "check-1");
      assert.equal(row.organization_id, "org-1");
    }
  });

  it("keeps subscriber routing on both parent and children when attribution is subscriber-target", async () => {
    const decision: AttributionDecision = {
      target: "subscriber",
      matchesRequestedClient: true,
      mismatchReasons: [],
      attributedName: "Jane Doe",
    };

    const routing = await resolveAttributionRouting({
      requestedClientId: "subscriber-1",
      organizationId: "org-1",
      decision,
      parsedDependent: null,
      lookup: async () => {
        throw new Error("lookup should not be invoked");
      },
    });

    const row = buildBenefitSegmentRow({
      eligibilityCheckId: "check-1",
      organizationId: "org-1",
      routedClientId: routing.routedClientId,
      payerId: null,
      payerName: null,
      segment: { eligibilityCode: "1", segmentIndex: 0, category: "active" },
    });

    assert.equal(routing.routedClientId, "subscriber-1");
    assert.equal(row.client_id, "subscriber-1");
  });

  it("keeps subscriber routing for the parent AND children when dependent rerouting is unresolved (ambiguous match)", async () => {
    const decision: AttributionDecision = {
      target: "dependent",
      matchesRequestedClient: false,
      mismatchReasons: ["name_mismatch"],
      attributedName: "Sam Doe",
    };

    const routing = await resolveAttributionRouting({
      requestedClientId: "subscriber-1",
      organizationId: "org-1",
      decision,
      parsedDependent: { firstName: "Sam", lastName: "Doe", dob: "2015-06-01" },
      lookup: async () => ["dep-a", "dep-b"],
    });

    assert.equal(routing.routedClientId, "subscriber-1");
    assert.equal(routing.unresolved, true);
    assert.equal(routing.unresolvedReason, "ambiguous_dependent_match");

    const row = buildBenefitSegmentRow({
      eligibilityCheckId: "check-1",
      organizationId: "org-1",
      routedClientId: routing.routedClientId,
      segment: { eligibilityCode: "1", segmentIndex: 0, category: "active" },
    });
    assert.equal(row.client_id, "subscriber-1",
      "ambiguous-match must keep parent + children together on the requested client, flagged unresolved");
  });
});
