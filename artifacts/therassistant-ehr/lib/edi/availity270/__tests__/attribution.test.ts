// Fixture-based tests for CAQH CORE Single Client Attribution
// Rule vEB.1.0 §4.2–§4.3. Run with:
//   node --experimental-strip-types --test lib/edi/availity270/__tests__/attribution.test.ts
//
// Verifies:
//   1. Subscriber-only 271 → attribution.target = "subscriber", match=true
//      when requested client matches subscriber identity.
//   2. Dependent 271 (HL*23 / NM1*03 with EB content under it) →
//      attribution.target = "dependent" using EB owner rollup (not just
//      dependent-loop presence), and identity comparison flags mismatch
//      when the requested client is the subscriber.
//   3. Identity mismatch surfaces correct mismatch reasons.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { attributeResponseToClient } from "../attribution";
import { parseAvaility271 } from "../parse271";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "..", "__fixtures__");

function loadFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf8");
}

describe("Single Client Attribution (vEB.1.0)", () => {
  it("attributes subscriber-only 271 to the subscriber and matches the requested client", () => {
    const raw = loadFixture("sample271.txt");
    const parsed = parseAvaility271(raw);

    assert.equal(parsed.attribution?.target, "subscriber");
    assert.equal(parsed.subscriber?.lastName, "SMITH");
    assert.equal(parsed.subscriber?.firstName, "JOHN");

    // EB segments all belong to the subscriber loop.
    const dependentBenefits = parsed.benefits.filter((b) => b.owner === "dependent");
    assert.equal(dependentBenefits.length, 0);

    const decision = attributeResponseToClient(parsed.attribution, {
      firstName: "JOHN",
      lastName: "SMITH",
      dob: "1985-06-15",
      memberId: "W123456789",
    });
    assert.equal(decision.target, "subscriber");
    assert.equal(decision.matchesRequestedClient, true);
    assert.deepEqual(decision.mismatchReasons, []);
  });

  it("routes 271 with dependent EB content to the dependent loop", () => {
    const raw = loadFixture("sample271-dependent.txt");
    const parsed = parseAvaility271(raw);

    // Parser must tag EB segments under HL*23 as owner=dependent.
    const dependentBenefits = parsed.benefits.filter((b) => b.owner === "dependent");
    assert.ok(dependentBenefits.length > 0, "expected EB segments under dependent loop");

    assert.equal(parsed.attribution?.target, "dependent");
    assert.equal(parsed.dependent?.firstName, "EMMA");
    assert.equal(parsed.dependent?.lastName, "SMITH");
    assert.equal(parsed.dependent?.dob, "2014-07-02");

    // Requested client = subscriber John, but response is about dependent
    // Emma. Decision must flag the mismatch so the UI can warn.
    const decision = attributeResponseToClient(parsed.attribution, {
      firstName: "JOHN",
      lastName: "SMITH",
      dob: "1985-06-15",
      memberId: "W123456789",
    });
    assert.equal(decision.target, "dependent");
    assert.equal(decision.matchesRequestedClient, false);
    assert.ok(
      decision.mismatchReasons.includes("name_mismatch") ||
        decision.mismatchReasons.includes("dob_mismatch"),
      `expected name or dob mismatch, got ${decision.mismatchReasons.join(",")}`,
    );

    // When the requested client IS the dependent, decision should match.
    const dependentDecision = attributeResponseToClient(parsed.attribution, {
      firstName: "EMMA",
      lastName: "SMITH",
      dob: "2014-07-02",
    });
    assert.equal(dependentDecision.matchesRequestedClient, true);
    assert.deepEqual(dependentDecision.mismatchReasons, []);
  });

  it("flags member-id mismatch even when name matches", () => {
    const raw = loadFixture("sample271.txt");
    const parsed = parseAvaility271(raw);

    const decision = attributeResponseToClient(parsed.attribution, {
      firstName: "JOHN",
      lastName: "SMITH",
      dob: "1985-06-15",
      memberId: "WRONGID000",
    });
    assert.equal(decision.target, "subscriber");
    assert.equal(decision.matchesRequestedClient, false);
    assert.ok(decision.mismatchReasons.includes("member_id_mismatch"));
  });

  it("returns missing_response_identity when attribution is null", () => {
    const decision = attributeResponseToClient(undefined, {
      firstName: "JANE",
      lastName: "DOE",
      dob: "1990-01-01",
    });
    assert.equal(decision.matchesRequestedClient, false);
    assert.deepEqual(decision.mismatchReasons, ["missing_response_identity"]);
  });
});
