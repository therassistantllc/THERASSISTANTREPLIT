// Tests for the per-claim slicing of the 277CA parser. The parser must
// walk the 2000D/2200D loop structure so each claim (TRN) carries its
// own STC entries instead of the whole batch sharing one rejection
// reason.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { __private277CAParserForTests } from "@/lib/claims/edi277caAcknowledgementService";

const { parse277CA } = __private277CAParserForTests;

// Mixed-rejection 277CA: two claims, two different reject reasons.
//   - PAT-MEM has STC A7:562:IL  (subscriber id problem  → invalid member)
//   - PAT-PRV has STC A7:562:85  (billing provider problem → invalid provider)
const MIXED_REJECT_277CA = [
  "ISA*00*          *00*          *ZZ*030240928      *ZZ*SBH2024        *260524*1234*^*00501*000099999*0*P*:",
  "GS*HN*030240928*SBH2024*20260524*1234*999*X*005010X214",
  "ST*277*0001*005010X214",
  "BHT*0085*08*BATCH-001*20260524*1234*TH",
  // Information Source (payer)
  "HL*1**20*1",
  "NM1*PR*2*AETNA*****PI*60054",
  // Information Receiver (submitter)
  "HL*2*1*21*1",
  "NM1*41*2*SBH*****46*SBH2024",
  // Billing Provider (2000C)
  "HL*3*2*19*1",
  "NM1*85*2*PRACTICE*****XX*1234567890",
  // Client / Claim 1 (2000D)
  "HL*4*3*23",
  "NM1*QC*1*SMITH*JOHN",
  "TRN*2*PAT-MEM",
  "STC*A7:562:IL*20260524*U*100.00*******Subscriber not found",
  // Client / Claim 2 (2000D)
  "HL*5*3*23",
  "NM1*QC*1*JONES*JANE",
  "TRN*2*PAT-PRV",
  "STC*A7:562:85*20260524*U*200.00*******Billing provider NPI invalid",
  "SE*16*0001",
  "GE*1*999",
  "IEA*1*000099999",
].join("~") + "~";

describe("parse277CA per-claim slicing", () => {
  it("groups STC entries under each 2200D TRN", () => {
    const parsed = parse277CA(MIXED_REJECT_277CA);

    assert.equal(parsed.outcome, "rejected");
    assert.equal(parsed.claimRefs.length, 2);

    const memberClaim = parsed.claimRefs.find((c) => c.trn === "PAT-MEM");
    const providerClaim = parsed.claimRefs.find((c) => c.trn === "PAT-PRV");

    assert.ok(memberClaim, "expected PAT-MEM claim ref");
    assert.ok(providerClaim, "expected PAT-PRV claim ref");

    assert.equal(memberClaim!.stcStatuses.length, 1);
    assert.equal(memberClaim!.stcStatuses[0].entity, "IL");
    assert.equal(memberClaim!.message, "Subscriber not found");

    assert.equal(providerClaim!.stcStatuses.length, 1);
    assert.equal(providerClaim!.stcStatuses[0].entity, "85");
    assert.equal(providerClaim!.message, "Billing provider NPI invalid");
  });

  it("still emits a flat top-level stcStatuses for legacy consumers", () => {
    const parsed = parse277CA(MIXED_REJECT_277CA);
    assert.equal(parsed.stcStatuses.length, 2);
    const entities = parsed.stcStatuses.map((s) => s.entity).sort();
    assert.deepEqual(entities, ["85", "IL"]);
  });

  it("does not attribute non-claim STCs to a claim", () => {
    // A 277CA with a transaction-level STC and no claim loops should
    // produce zero claimRefs and still surface outcome correctly.
    const noClaims = [
      "ST*277*0001*005010X214",
      "BHT*0085*08*BATCH-001*20260524*1234*TH",
      "HL*1**20*1",
      "NM1*PR*2*AETNA*****PI*60054",
      "STC*A1:20:PR",
      "SE*5*0001",
    ].join("~") + "~";

    const parsed = parse277CA(noClaims);
    assert.equal(parsed.claimRefs.length, 0);
    assert.equal(parsed.stcStatuses.length, 1);
    assert.equal(parsed.outcome, "accepted");
  });

  it("does not group TRN segments that live outside an HL*…*…*23 loop", () => {
    // TRN segments under non-23 HL levels (eg. info source) must NOT
    // open a claim loop. Only the 2200D-level TRN should.
    const trnInWrongLoop = [
      "ST*277*0001",
      "HL*1**20*1",
      "TRN*1*BATCH-LEVEL-TRN",
      "STC*A1:20:PR",
      "HL*2*1*23",
      "TRN*2*REAL-CLAIM",
      "STC*A7:562:IL",
      "SE*7*0001",
    ].join("~") + "~";

    const parsed = parse277CA(trnInWrongLoop);
    assert.equal(parsed.claimRefs.length, 1);
    assert.equal(parsed.claimRefs[0].trn, "REAL-CLAIM");
  });
});
