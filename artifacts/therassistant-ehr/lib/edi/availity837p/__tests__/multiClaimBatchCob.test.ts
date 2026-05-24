// Round-trips a secondary child claim through the MULTI-CLAIM 837P batch
// generator (the one driven by rebuild837PBatchFile after bulk-batch picks
// the child up via the standard "ready_for_batch" flow). Verifies the
// generator now emits the COB loops driven off the persisted
// cob_billing_role + prior_payer_* columns + prior_payer_eob_data that
// cobBilling.billSecondary stamps onto the child:
//   2000B SBR*S (destination payer is secondary)
//   2320 SBR*P + claim-level CAS + AMT*D + AMT*F2 + OI
//   2330A NM1*IL (primary subscriber) + 2330B NM1*PR (primary payer)
//   2430 SVD + line-level CAS + DTP*573 per matching ERA service line
//
// Also asserts that a sibling primary-only claim in the SAME batch does NOT
// pick up COB loops — they're scoped per-claim.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { generateAvaility837PMultiClaimBatch } from "../generate837pMultiClaimBatch";
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

function makeParties(opts: { claimId: string; secondary: boolean }): ClaimPartiesSnapshot {
  return {
    id: `p-${opts.claimId}`,
    claim_id: opts.claimId,
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
    // Parties snapshot for a secondary child is rewritten by
    // cobBilling.billSecondary to point at the secondary policy.
    subscriber_member_id: opts.secondary ? "SECMEM999" : "PRIMEM111",
    subscriber_dob: "19800101",
    subscriber_gender: "F",
    subscriber_address1: "200 Oak St",
    subscriber_city: "Austin",
    subscriber_state: "TX",
    subscriber_zip: "78701",
    patient_is_subscriber: true,
    payer_name: opts.secondary ? "Aetna" : "Anthem BCBS",
    payer_id: opts.secondary ? "AETNA01" : "ANTHEM01",
    rendering_same_as_billing: true,
    service_facility_same_as_billing: true,
  };
}

function makeServiceLine(claimId: string): ProfessionalClaimServiceLine {
  return {
    id: `sl-${claimId}`,
    claim_id: claimId,
    line_number: 1,
    service_date_from: "20260501",
    procedure_code: "90834",
    modifiers: [],
    charge_amount: 150,
    units: 1,
    diagnosis_pointers: ["1"],
    place_of_service: "11",
  };
}

function makePrimaryClaim(): ProfessionalClaim {
  return {
    id: "primary-claim-1",
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

function makeSecondaryChildClaim(): ProfessionalClaim {
  return {
    ...makePrimaryClaim(),
    id: "secondary-child-1",
    claim_number: "C0002",
    patient_account_number: "PAT-0002",
    // Set by cobBilling.billSecondary on the cloned child.
    cob_billing_role: "secondary",
    original_claim_id: "primary-claim-1",
    prior_payer_paid_amount: 100,
    prior_payer_adjustment_amount: 25,
    prior_payer_patient_responsibility_amount: 25,
    prior_payer_profile_id: "primary-payer-uuid",
    // Stashed by cobBilling.billSecondary off the ERA + the primary policy's
    // subscriber/payer lookups (see loadSecondaryPartiesContext).
    prior_payer_eob_data: {
      source: "era",
      era_payment_id: "era-1",
      payer_claim_control_number: "PCCN-001",
      primary_payer_name: "Anthem BCBS",
      primary_payer_id: "ANTHEM01",
      primary_subscriber_last_name: "Doe",
      primary_subscriber_first_name: "Jane",
      primary_subscriber_member_id: "PRIMEM111",
      posted_at: "20260510",
      cas_adjustments: [{ group_code: "CO", reason_code: "45", amount: 25 }],
      service_lines: [
        {
          service_line_id: "sl-secondary-child-1",
          procedure_code: "90834",
          paid_amount: 100,
          original_units: 1,
          cas_adjustments: [
            { group_code: "PR", reason_code: "1", amount: 25 },
            { group_code: "CO", reason_code: "45", amount: 25 },
          ],
        },
      ],
    },
  };
}

function build(secondaryChildOnly: boolean = false) {
  const claims = secondaryChildOnly
    ? [
        {
          claim: makeSecondaryChildClaim(),
          serviceLines: [makeServiceLine("secondary-child-1")],
          parties: makeParties({ claimId: "secondary-child-1", secondary: true }),
          payerProfile: {
            id: "pp-secondary",
            organization_id: "org-1",
            payer_name: "Aetna",
            availity_payer_id: "AETNA01",
          },
        },
      ]
    : [
        {
          claim: makePrimaryClaim(),
          serviceLines: [makeServiceLine("primary-claim-1")],
          parties: makeParties({ claimId: "primary-claim-1", secondary: false }),
          payerProfile: {
            id: "pp-primary",
            organization_id: "org-1",
            payer_name: "Anthem BCBS",
            availity_payer_id: "ANTHEM01",
          },
        },
        {
          claim: makeSecondaryChildClaim(),
          serviceLines: [makeServiceLine("secondary-child-1")],
          parties: makeParties({ claimId: "secondary-child-1", secondary: true }),
          payerProfile: {
            id: "pp-secondary",
            organization_id: "org-1",
            payer_name: "Aetna",
            availity_payer_id: "AETNA01",
          },
        },
      ];
  return generateAvaility837PMultiClaimBatch({
    connection: makeConnection(),
    submitterName: "Therassistant Clinic",
    claims,
  });
}

function segments(content: string): string[] {
  return content.split("~").filter(Boolean);
}

describe("Availity 837P multi-claim batch — secondary child COB loops", () => {
  it("emits 2000B SBR*S (destination payer is secondary) for the child claim", () => {
    const batch = build(true);
    const sbrs = segments(batch.fileContent).filter((s) => s.startsWith("SBR*"));
    assert.ok(sbrs.length >= 2, "expected 2000B + 2320 SBR segments");
    assert.ok(sbrs[0].startsWith("SBR*S*"), "2000B SBR must be 'S' for secondary destination");
  });

  it("includes 2320 SBR*P + AMT*D + AMT*F2 + OI driven off prior_payer_* + eob_data", () => {
    const batch = build(true);
    const segs = segments(batch.fileContent);
    const sbrP = segs.find((s) => s.startsWith("SBR*P*"));
    assert.ok(sbrP, "2320 SBR*P missing — secondary payer can't see primary adjudication");
    assert.equal(
      segs.find((s) => s.startsWith("AMT*D*")),
      "AMT*D*100.00",
      "AMT*D must carry prior_payer_paid_amount",
    );
    assert.equal(
      segs.find((s) => s.startsWith("AMT*F2*")),
      "AMT*F2*25.00",
      "AMT*F2 must carry prior_payer_patient_responsibility_amount",
    );
    assert.ok(segs.includes("OI***Y***Y"), "OI missing from 2320 loop");
    // Claim-level CAS from prior_payer_eob_data.cas_adjustments.
    assert.ok(segs.some((s) => s === "CAS*CO*45*25.00"), "claim-level CO/45 CAS missing");
  });

  it("emits 2330A NM1*IL (primary subscriber) + 2330B NM1*PR (primary payer)", () => {
    const batch = build(true);
    const segs = segments(batch.fileContent);
    const il = segs.filter((s) => s.startsWith("NM1*IL*"));
    const pr = segs.filter((s) => s.startsWith("NM1*PR*"));
    assert.equal(il.length, 2, "expected 2010BA + 2330A subscriber loops");
    assert.ok(il[1].includes("*PRIMEM111"), "2330A must carry primary subscriber member id");
    assert.equal(pr.length, 2, "expected 2010BB + 2330B payer loops");
    assert.ok(pr[0].includes("AETNA01"), "2010BB must point at secondary payer");
    assert.ok(pr[1].includes("Anthem BCBS"), "2330B must carry primary payer name");
    assert.ok(pr[1].includes("ANTHEM01"), "2330B must carry primary payer id");
  });

  it("emits per-line 2430 SVD + CAS + DTP*573 from prior_payer_eob_data.service_lines", () => {
    const batch = build(true);
    const segs = segments(batch.fileContent);
    const svd = segs.find((s) => s.startsWith("SVD*"));
    assert.ok(svd, "SVD missing from 2430 loop");
    assert.ok(svd!.startsWith("SVD*ANTHEM01*100.00*"), "SVD must carry other payer id + paid amt");
    assert.ok(segs.some((s) => s === "CAS*PR*1*25.00"), "line-level PR/1 deductible CAS missing");
    assert.ok(segs.includes("DTP*573*D8*20260510"), "DTP*573 adjudication date missing");
  });

  it("scopes COB loops per-claim — a sibling primary claim in the same batch stays unchanged", () => {
    const batch = build(false);
    const segs = segments(batch.fileContent);
    // 2 claims → 2 CLM segments. Exactly one 2320 SBR*P (only the child).
    assert.equal(
      segs.filter((s) => s.startsWith("CLM*")).length,
      2,
      "expected 2 CLM segments in the multi-claim batch",
    );
    // Total SBR segments: primary claim's 2000B (P) + child's 2000B (S) +
    // child's 2320 (P) = 3. So SBR*P count is 2 (one per claim's 2000B for
    // the primary + the child's 2320 other-payer loop), and SBR*S count is
    // exactly 1 (only the child's 2000B).
    assert.equal(
      segs.filter((s) => s.startsWith("SBR*")).length,
      3,
      "expected 3 SBR segments total (primary 2000B + child 2000B + child 2320)",
    );
    assert.equal(
      segs.filter((s) => s.startsWith("SBR*S*")).length,
      1,
      "only the secondary child should flip 2000B SBR to 'S'",
    );
    // 2320 has a unique signature: SBR*P followed immediately by AMT*D /
    // OI. AMT*D should appear exactly once — only on the child.
    assert.equal(
      segs.filter((s) => s.startsWith("AMT*D*")).length,
      1,
      "primary sibling must NOT emit a 2320 AMT*D loop",
    );
    // Both 2010BA primary-claim subscriber NM1*IL and the child claim's
    // 2010BA + 2330A — so 3 NM1*IL total (1 from primary claim, 2 from
    // child).
    assert.equal(
      segs.filter((s) => s.startsWith("NM1*IL*")).length,
      3,
      "expected 3 NM1*IL across the batch (primary claim 2010BA + child 2010BA + 2330A)",
    );
  });

  it("omits COB loops when prior_payer_eob_data lacks primary identifying fields", () => {
    // Same setup but strip the primary subscriber/payer names so
    // deriveCobFromClaim returns null and the generator skips the loops
    // (rather than emitting half-populated 2330A/2330B with empty NM103).
    const claim = makeSecondaryChildClaim();
    claim.prior_payer_eob_data = {
      source: "era",
      era_payment_id: "era-1",
      cas_adjustments: [],
      service_lines: [],
    };
    const batch = generateAvaility837PMultiClaimBatch({
      connection: makeConnection(),
      submitterName: "Therassistant Clinic",
      claims: [
        {
          claim,
          serviceLines: [makeServiceLine("secondary-child-1")],
          parties: makeParties({ claimId: "secondary-child-1", secondary: true }),
          payerProfile: {
            id: "pp-secondary",
            organization_id: "org-1",
            payer_name: "Aetna",
            availity_payer_id: "AETNA01",
          },
        },
      ],
    });
    const segs = segments(batch.fileContent);
    assert.ok(!segs.some((s) => s.startsWith("SBR*P*")), "2320 SBR*P should be skipped");
    assert.ok(!segs.some((s) => s.startsWith("AMT*D*")), "AMT*D should be skipped");
    assert.ok(!segs.some((s) => s.startsWith("SVD*")), "SVD should be skipped");
    // But the 2000B SBR still flips to 'S' because cob_billing_role drives that
    // independent of the eob_data shape.
    const sbrs = segs.filter((s) => s.startsWith("SBR*"));
    assert.ok(sbrs[0].startsWith("SBR*S*"), "2000B SBR*S still flips based on cob_billing_role");
  });
});
