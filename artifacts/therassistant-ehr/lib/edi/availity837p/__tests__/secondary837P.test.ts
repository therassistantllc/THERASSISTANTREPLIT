// Verifies the secondary 837P emitter wires COB loops the way 5010X222A1
// requires:
//   2000B SBR*S (destination payer is secondary)
//   2320 SBR*P + claim-level CAS + AMT*D + AMT*F2 + OI
//   2330A NM1*IL (primary subscriber)
//   2330B NM1*PR (primary payer)
//   2400 SVD + line-level CAS + DTP*573 keyed off the matching service line
// Without these loops the secondary payer either rejects the claim or pays
// as primary (incorrectly). See Task #483.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { generateAvaility837PSecondaryBatch } from "../generate837pSecondary";
import type {
  AvailityConnection,
  ClaimPartiesSnapshot,
  ProfessionalClaim,
  ProfessionalClaimServiceLine,
} from "../types";

function makeConnection(): AvailityConnection {
  return {
    organization_id: "org-1",
    mode: "test",
    submitter_id: "SUB001",
    sender_qualifier: "ZZ",
    receiver_qualifier: "30",
    receiver_id: "030240928",
    receiver_name: "Availity",
    gs_receiver_code: "030240928",
    x12_version: "005010X222A1",
    isa_usage_indicator: "T",
    submitter_contact_phone: "5551234567",
    submitter_contact_email: "edi@example.com",
    is_active: true,
  };
}

// Parties snapshot rewritten for the SECONDARY submission — subscriber and
// payer point at the secondary policy. The builder owns the swap; the emitter
// just consumes it.
function makeSecondaryParties(): ClaimPartiesSnapshot {
  return {
    id: "p-1",
    claim_id: "c-1",
    billing_provider_entity_type: "2",
    billing_provider_name: "Therassistant Clinic",
    billing_provider_npi: "1234567893",
    billing_provider_tax_id: "123456789",
    billing_provider_tax_id_type: "EI",
    billing_provider_address1: "100 Main St",
    billing_provider_city: "Austin",
    billing_provider_state: "TX",
    billing_provider_zip: "78701",
    subscriber_last_name: "Doe",
    subscriber_first_name: "Jane",
    subscriber_member_id: "SECMEM999", // secondary policy member id
    subscriber_dob: "19800101",
    subscriber_gender: "F",
    subscriber_address1: "200 Oak St",
    subscriber_city: "Austin",
    subscriber_state: "TX",
    subscriber_zip: "78701",
    patient_is_subscriber: true,
    payer_name: "Aetna", // secondary payer
    payer_id: "AETNA01",
    rendering_same_as_billing: true,
    service_facility_same_as_billing: true,
  };
}

function makeServiceLines(): ProfessionalClaimServiceLine[] {
  return [
    {
      id: "sl-1",
      claim_id: "c-1",
      line_number: 1,
      service_date_from: "20260501",
      procedure_code: "90834",
      modifiers: [],
      charge_amount: 150,
      units: 1,
      diagnosis_pointers: ["1"],
      place_of_service: "11",
    },
  ];
}

function makeClaim(): ProfessionalClaim {
  return {
    id: "c-1",
    organization_id: "org-1",
    claim_number: "C0001",
    patient_account_number: "PAT-0001",
    claim_status: "ready_for_batch",
    total_charge: 150,
    place_of_service: "11",
    diagnosis_codes: ["F32.9"],
    accept_assignment: true,
    benefits_assignment: true,
    release_of_information: true,
    signature_on_file: true,
  };
}

function build(overrides: { withEra?: boolean } = {}) {
  const eraLines = overrides.withEra
    ? [
        {
          service_line_id: "sl-1",
          procedure_code: "90834",
          paid_amount: 100,
          original_units: 1,
          cas_adjustments: [
            { group_code: "PR", reason_code: "1", amount: 25 }, // deductible
            { group_code: "CO", reason_code: "45", amount: 25 }, // contractual
          ],
        },
      ]
    : [];
  return generateAvaility837PSecondaryBatch({
    connection: makeConnection(),
    submitterName: "Therassistant Clinic",
    claim: makeClaim(),
    serviceLines: makeServiceLines(),
    parties: makeSecondaryParties(),
    payerProfile: {
      id: "pp-2",
      organization_id: "org-1",
      payer_name: "Aetna",
      availity_payer_id: "AETNA01",
    },
    primary: {
      payer_name: "Anthem BCBS",
      payer_id: "ANTHEM01",
      subscriber_last_name: "Doe",
      subscriber_first_name: "Jane",
      subscriber_member_id: "PRIMEM111",
      adjudication_date: "20260510",
      payer_paid_amount: 100,
      patient_responsibility_amount: 25,
      cas_adjustments: [
        { group_code: "CO", reason_code: "45", amount: 25 },
      ],
      service_lines: eraLines,
    },
  });
}

function segments(content: string): string[] {
  return content.split("~").filter(Boolean);
}

describe("Availity 837P — secondary COB", () => {
  it("emits 2000B SBR*S (destination payer is secondary)", () => {
    const batch = build({ withEra: true });
    const sbrs = segments(batch.fileContent).filter((s) => s.startsWith("SBR*"));
    assert.ok(sbrs.length >= 2, "expected at least two SBR segments (2000B + 2320)");
    assert.ok(sbrs[0].startsWith("SBR*S*"), "2000B SBR must use responsibility code 'S'");
  });

  it("includes the 2320 SBR*P / CAS / AMT*D / AMT*F2 / OI block", () => {
    const batch = build({ withEra: true });
    const segs = segments(batch.fileContent);
    const sbrP = segs.find((s) => s.startsWith("SBR*P*"));
    assert.ok(sbrP, "2320 SBR*P missing — secondary payer can't see primary adjudication");
    const amtD = segs.find((s) => s.startsWith("AMT*D*"));
    const amtF2 = segs.find((s) => s.startsWith("AMT*F2*"));
    const oi = segs.find((s) => s === "OI***Y***Y");
    assert.equal(amtD, "AMT*D*100.00", "AMT*D must carry primary payer paid amount");
    assert.equal(amtF2, "AMT*F2*25.00", "AMT*F2 must carry patient responsibility");
    assert.ok(oi, "OI segment missing from 2320 loop");
  });

  it("emits 2330A NM1*IL (primary subscriber) and 2330B NM1*PR (primary payer)", () => {
    const batch = build({ withEra: true });
    const segs = segments(batch.fileContent);
    const il = segs.filter((s) => s.startsWith("NM1*IL*"));
    const pr = segs.filter((s) => s.startsWith("NM1*PR*"));
    // 2010BA (secondary subscriber) + 2330A (primary subscriber)
    assert.equal(il.length, 2, "expected 2010BA + 2330A subscriber loops");
    assert.ok(il[1].includes("*PRIMEM111"), "2330A must carry primary subscriber member id");
    // 2010BB (secondary payer) + 2330B (primary payer)
    assert.equal(pr.length, 2, "expected 2010BB + 2330B payer loops");
    assert.ok(pr[0].includes("AETNA01"), "2010BB must point at secondary payer");
    assert.ok(pr[1].includes("Anthem BCBS"), "2330B must carry primary payer name");
    assert.ok(pr[1].includes("ANTHEM01"), "2330B must carry primary payer id");
  });

  it("emits per-line SVD + CAS + DTP*573 when ERA service lines are provided", () => {
    const batch = build({ withEra: true });
    const segs = segments(batch.fileContent);
    const svd = segs.find((s) => s.startsWith("SVD*"));
    assert.ok(svd, "SVD missing — secondary payer cannot tie COB summary to the service line");
    assert.ok(svd!.startsWith("SVD*ANTHEM01*100.00*"), "SVD must carry other payer id + paid amt");
    // Line-level CAS adjustments come right after SVD.
    const dtp573 = segs.find((s) => s === "DTP*573*D8*20260510");
    assert.ok(dtp573, "DTP*573 (adjudication date) missing from 2400 loop");
    // Verify a line-level CAS adjustment landed in the SVD block.
    assert.ok(
      segs.some((s) => s === "CAS*PR*1*25.00"),
      "line-level PR/1 deductible CAS missing",
    );
  });

  it("omits per-line SVD/CAS/DTP*573 when no ERA service lines are available", () => {
    // Manual EOB fallback — claim-level AMT still goes out, but per-line
    // adjudication is unknown so SVD must NOT be emitted.
    const batch = build({ withEra: false });
    const segs = segments(batch.fileContent);
    assert.ok(!segs.some((s) => s.startsWith("SVD*")), "SVD should be absent without ERA lines");
    assert.ok(!segs.some((s) => s.startsWith("DTP*573*")), "DTP*573 should be absent without ERA");
    // Claim-level AMTs still required.
    assert.ok(segs.some((s) => s.startsWith("AMT*D*")));
    assert.ok(segs.some((s) => s.startsWith("AMT*F2*")));
  });

  it("uses the secondary payer in 2010BB and the secondary member id in 2010BA", () => {
    const batch = build({ withEra: true });
    const segs = segments(batch.fileContent);
    const subscriberIl = segs.find((s) => s.startsWith("NM1*IL*"));
    assert.ok(subscriberIl);
    assert.ok(subscriberIl!.includes("SECMEM999"), "2010BA must carry secondary policy member id");
  });
});
