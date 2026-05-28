/**
 * Tests for lib/edi/availity837p/map837p.ts
 *
 * Coverage:
 *   - Complete valid claim produces a well-formed X12 file
 *   - All 25+ required segments present in correct order
 *   - Conditional segments emitted / omitted correctly:
 *       PRV billing-provider taxonomy (2000A)
 *       PER billing-provider contact (2010AA)
 *       Payer N3/N4 (2010BB)
 *       Loop 2000C/2010CA patient (when patient ≠ subscriber)
 *       Loop 2310A referring provider
 *       Loop 2310B rendering provider + PRV
 *       Loop 2310D service facility
 *       DTP*431/454/304/453/439 clinical dates
 *       REF*D9 / REF*F8 corrected-claim control numbers
 *       REF*G1 prior authorisation
 *       PWK attachment
 *       NTE claim note and line note
 *       REF*6R line control number
 *       Loop 2420A line rendering provider
 *   - validate837pInput() returns proper errors for each missing required field
 *   - PHI is not present in validation error messages
 *   - SE segment count matches actual segment count in body
 *   - ISA*15 usage indicator matches envelope.usage_indicator
 *   - ISA/GS control numbers appear in SE/GE/IEA trailers
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  map837p,
  validate837pInput,
  type Map837PInput,
  type Map837PEnvelope,
  type Map837PBillingProvider,
  type Map837PPayer,
  type Map837PSubscriber,
  type Map837PClaim,
  type Map837PServiceLine,
} from "../map837p";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<Map837PEnvelope> = {}): Map837PEnvelope {
  return {
    submitter_id: "SUB001",
    sender_qualifier: "ZZ",
    receiver_id: "030240928",
    receiver_qualifier: "30",
    usage_indicator: "T",
    submitter_name: "TherAssistant Clinic",
    submitter_contact_name: "EDI Support",
    submitter_contact_phone: "5551234567",
    receiver_name: "Availity",
    ...overrides,
  };
}

function makeBillingProvider(overrides: Partial<Map837PBillingProvider> = {}): Map837PBillingProvider {
  return {
    entity_type: "2",
    last_name_or_org: "TherAssistant Clinic",
    npi: "1234567893",
    tax_id: "123456789",
    tax_id_type: "EI",
    address1: "100 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    ...overrides,
  };
}

function makePayer(overrides: Partial<Map837PPayer> = {}): Map837PPayer {
  return {
    name: "Anthem BCBS",
    payer_id: "ANTHEM01",
    ...overrides,
  };
}

function makeSubscriber(overrides: Partial<Map837PSubscriber> = {}): Map837PSubscriber {
  return {
    last_name: "Doe",
    first_name: "Jane",
    member_id: "MEM123456",
    dob: "19800115",
    sex: "F",
    address1: "200 Oak Ave",
    city: "Austin",
    state: "TX",
    zip: "78702",
    is_patient: true,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<Map837PClaim> = {}): Map837PClaim {
  return {
    claim_identifier: "PAT-0001",
    total_charge: 300,
    place_of_service: "11",
    claim_frequency_code: "1",
    diagnosis_codes: ["F329", "Z7989"],
    ...overrides,
  };
}

function makeServiceLines(overrides: Partial<Map837PServiceLine> = {}): Map837PServiceLine[] {
  return [
    {
      line_number: 1,
      procedure_code: "90834",
      modifiers: ["GT"],
      charge_amount: 150,
      units: 1,
      diagnosis_pointers: ["1"],
      date_of_service: "20260501",
      ...overrides,
    },
    {
      line_number: 2,
      procedure_code: "90837",
      charge_amount: 150,
      units: 1,
      diagnosis_pointers: ["1", "2"],
      date_of_service: "20260501",
    },
  ];
}

function baseInput(overrides: Partial<Map837PInput> = {}): Map837PInput {
  return {
    envelope: makeEnvelope(),
    billing_provider: makeBillingProvider(),
    payer: makePayer(),
    subscriber: makeSubscriber(),
    claim: makeClaim(),
    service_lines: makeServiceLines(),
    now: new Date("2026-05-28T10:00:00Z"),
    ...overrides,
  };
}

/** Parse ISA-delimited X12 content into an array of segment strings. */
function parseSegments(content: string): string[] {
  return content
    .split("~")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Return the first segment whose ID matches. */
function findSeg(segs: string[], id: string): string | undefined {
  return segs.find((s) => s.startsWith(id + "*") || s === id);
}

/** Return all segments whose ID matches. */
function findAllSegs(segs: string[], id: string): string[] {
  return segs.filter((s) => s.startsWith(id + "*") || s === id);
}

/** Return element at 1-based position within a parsed segment. */
function el(seg: string, pos: number): string {
  return seg.split("*")[pos] ?? "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("map837p — complete valid claim", () => {
  it("returns ok=true and non-empty file_content", () => {
    const result = map837p(baseInput());
    assert.equal(result.ok, true);
    assert.ok(result.file_content.length > 0, "file_content should not be empty");
    assert.ok(result.file_name.endsWith(".837"), "file_name should have .837 extension");
    assert.equal(result.validation_errors.length, 0);
  });

  it("produces a valid X12 envelope (ISA / GS / ST / BHT)", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const isa = findSeg(segs, "ISA");
    assert.ok(isa, "ISA segment should be present");
    assert.equal(el(isa!, 15), "T", "ISA*15 should be T for test mode");
    assert.equal(el(isa!, 13), result.isa_control_number, "ISA*13 matches isa_control_number");

    const gs = findSeg(segs, "GS");
    assert.ok(gs, "GS segment should be present");
    assert.equal(el(gs!, 1), "HC", "GS*01 = HC (healthcare claim)");
    assert.equal(el(gs!, 8), "005010X222A1", "GS*08 = 005010X222A1");

    const st = findSeg(segs, "ST");
    assert.ok(st, "ST segment should be present");
    assert.equal(el(st!, 1), "837", "ST*01 = 837");
    assert.equal(el(st!, 3), "005010X222A1", "ST*03 = 005010X222A1");

    const bht = findSeg(segs, "BHT");
    assert.ok(bht, "BHT segment should be present");
    assert.equal(el(bht!, 1), "0019", "BHT*01 = 0019 (professional claim)");
    assert.equal(el(bht!, 6), "CH", "BHT*06 = CH (chargeable)");
  });

  it("emits Loop 1000A submitter NM1*41 and PER", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const nm141 = segs.find((s) => s.startsWith("NM1*41"));
    assert.ok(nm141, "NM1*41 submitter segment should be present");
    assert.equal(el(nm141!, 8), "46", "NM1*41 qualifier = 46 (electronic ID)");
    assert.equal(el(nm141!, 9), "SUB001", "NM1*41 submitter ID from envelope");

    const per = segs.find((s) => s.startsWith("PER*IC"));
    assert.ok(per, "PER*IC submitter contact should be present");
    assert.ok(per!.includes("TE"), "PER should include TE qualifier for phone");
  });

  it("emits Loop 1000B receiver NM1*40", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const nm140 = segs.find((s) => s.startsWith("NM1*40"));
    assert.ok(nm140, "NM1*40 receiver segment should be present");
    assert.equal(el(nm140!, 3), "Availity", "NM1*40 receiver name");
    assert.equal(el(nm140!, 9), "030240928", "NM1*40 receiver ID");
  });

  it("emits Loop 2000A billing provider HL and Loop 2010AA segments", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const hl1 = segs.find((s) => s.startsWith("HL*1*"));
    assert.ok(hl1, "HL*1 billing provider should be present");
    assert.equal(el(hl1!, 3), "20", "HL billing provider level = 20");

    const nm185 = segs.find((s) => s.startsWith("NM1*85"));
    assert.ok(nm185, "NM1*85 billing provider segment should be present");
    assert.equal(el(nm185!, 8), "XX", "NM1*85 NM108 qualifier = XX (NPI)");
    assert.equal(el(nm185!, 9), "1234567893", "NM1*85 NM109 NPI matches");

    const refEi = segs.find((s) => s.startsWith("REF*EI"));
    assert.ok(refEi, "REF*EI billing provider TIN should be present");
    assert.equal(el(refEi!, 2), "123456789", "REF*EI TIN matches");
  });

  it("emits Loop 2000B subscriber HL, SBR, NM1*IL, DMG", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const hl2 = segs.find((s) => s.startsWith("HL*2*"));
    assert.ok(hl2, "HL*2 subscriber should be present");
    assert.equal(el(hl2!, 3), "22", "HL subscriber level = 22");
    assert.equal(el(hl2!, 4), "0", "HL*2 child code = 0 when patient is subscriber");

    const sbr = findSeg(segs, "SBR");
    assert.ok(sbr, "SBR segment should be present");
    assert.equal(el(sbr!, 1), "P", "SBR*01 = P (primary)");

    const nm1il = segs.find((s) => s.startsWith("NM1*IL"));
    assert.ok(nm1il, "NM1*IL subscriber segment should be present");
    assert.equal(el(nm1il!, 8), "MI", "NM1*IL qualifier = MI (member ID)");

    const dmg = segs.find((s) => s.startsWith("DMG*D8"));
    assert.ok(dmg, "DMG*D8 subscriber DOB should be present");
  });

  it("emits Loop 2010BB payer NM1*PR", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const nm1pr = segs.find((s) => s.startsWith("NM1*PR"));
    assert.ok(nm1pr, "NM1*PR payer segment should be present");
    assert.equal(el(nm1pr!, 8), "PI", "NM1*PR qualifier = PI (payer ID)");
    assert.equal(el(nm1pr!, 9), "ANTHEM01", "NM1*PR payer ID matches");
  });

  it("emits Loop 2300 CLM with correct composite CLM05", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const clm = findSeg(segs, "CLM");
    assert.ok(clm, "CLM segment should be present");
    assert.equal(el(clm!, 1), "PAT-0001", "CLM01 claim identifier");
    assert.equal(el(clm!, 2), "300.00", "CLM02 total charge");
    const clm05 = el(clm!, 5);
    assert.ok(clm05.startsWith("11:"), "CLM05-1 place of service = 11");
    assert.ok(clm05.endsWith(":1"), "CLM05-3 frequency = 1");
  });

  it("emits HI diagnosis codes in a single segment", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const hi = findSeg(segs, "HI");
    assert.ok(hi, "HI segment should be present");
    assert.ok(hi!.includes("ABK:F329"), "HI should include principal ABK:F329");
    assert.ok(hi!.includes("ABF:Z7989"), "HI should include additional ABF:Z7989");
  });

  it("emits correct LX/SV1/DTP*472 for each service line", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const lxSegs = findAllSegs(segs, "LX");
    assert.equal(lxSegs.length, 2, "Two LX segments for two service lines");

    const sv1Segs = findAllSegs(segs, "SV1");
    assert.equal(sv1Segs.length, 2, "Two SV1 segments");
    assert.ok(el(sv1Segs[0]!, 1).startsWith("HC:90834"), "SV1 line 1 procedure = 90834");
    assert.ok(el(sv1Segs[0]!, 1).includes(":GT"), "SV1 line 1 modifier GT present");

    const dtpSegs = findAllSegs(segs, "DTP*472");
    assert.equal(dtpSegs.length, 2, "Two DTP*472 service date segments");
    assert.equal(el(dtpSegs[0]!, 3), "20260501", "DTP*472 date = 20260501");
  });

  it("emits correct SE/GE/IEA trailers with matching control numbers", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);

    const se = findSeg(segs, "SE");
    assert.ok(se, "SE segment should be present");
    assert.equal(el(se!, 1), String(result.segment_count), "SE*01 matches segment_count");
    assert.equal(el(se!, 2), result.st_control_number, "SE*02 matches st_control_number");

    const ge = findSeg(segs, "GE");
    assert.ok(ge, "GE segment should be present");
    assert.equal(el(ge!, 2), result.gs_control_number, "GE*02 matches gs_control_number");

    const iea = findSeg(segs, "IEA");
    assert.ok(iea, "IEA segment should be present");
    assert.equal(el(iea!, 2), result.isa_control_number, "IEA*02 matches isa_control_number");
  });

  it("SE segment count equals actual segment count from ST to SE inclusive", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    const stIdx = segs.findIndex((s) => s.startsWith("ST*"));
    const seIdx = segs.findIndex((s) => s.startsWith("SE*"));
    const actualCount = seIdx - stIdx + 1;
    assert.equal(actualCount, result.segment_count, "SE count must equal segments from ST to SE inclusive");
  });
});

// ─── Conditional segments ────────────────────────────────────────────────────

describe("map837p — billing provider taxonomy PRV (Loop 2000A)", () => {
  it("emits PRV*BI when billing_provider.taxonomy is present", () => {
    const result = map837p(
      baseInput({ billing_provider: makeBillingProvider({ taxonomy: "207R00000X" }) }),
    );
    const segs = parseSegments(result.file_content);
    const prv = segs.find((s) => s.startsWith("PRV*BI"));
    assert.ok(prv, "PRV*BI should be present when taxonomy supplied");
    assert.equal(el(prv!, 2), "PXC", "PRV*02 = PXC");
    assert.equal(el(prv!, 3), "207R00000X", "PRV*03 = taxonomy code");
  });

  it("omits PRV*BI when billing_provider.taxonomy is absent", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    const prv = segs.find((s) => s.startsWith("PRV*BI"));
    assert.equal(prv, undefined, "PRV*BI should NOT be present when no taxonomy");
  });
});

describe("map837p — billing provider contact PER (Loop 2010AA)", () => {
  it("emits 2010AA PER when contact_name and contact_phone are provided", () => {
    const result = map837p(
      baseInput({
        billing_provider: makeBillingProvider({
          contact_name: "Jane Biller",
          contact_phone: "5557654321",
        }),
      }),
    );
    const segs = parseSegments(result.file_content);
    // There will be two PER*IC segments: one for submitter (1000A), one for billing provider (2010AA).
    const perSegs = segs.filter((s) => s.startsWith("PER*IC"));
    assert.ok(perSegs.length >= 2, "There should be at least 2 PER*IC segments (submitter + billing provider)");
  });

  it("omits 2010AA PER when contact is not provided", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    // Only the Loop 1000A PER should be present
    const perSegs = segs.filter((s) => s.startsWith("PER*IC"));
    assert.equal(perSegs.length, 1, "Only the submitter PER*IC should be emitted when no billing provider contact");
  });
});

describe("map837p — payer N3/N4 (Loop 2010BB)", () => {
  it("emits payer N3/N4 when address is provided", () => {
    const result = map837p(
      baseInput({
        payer: makePayer({
          address1: "PO Box 1000",
          city: "Richmond",
          state: "VA",
          zip: "23230",
        }),
      }),
    );
    const segs = parseSegments(result.file_content);
    // N3 and N4 also appear in 2010AA; find the ones after NM1*PR
    const nm1prIdx = segs.findIndex((s) => s.startsWith("NM1*PR"));
    const afterPayer = segs.slice(nm1prIdx + 1);
    const n3 = afterPayer.find((s) => s.startsWith("N3*"));
    assert.ok(n3, "N3 should be present after NM1*PR");
  });

  it("omits payer N3/N4 when no payer address", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    const nm1prIdx = segs.findIndex((s) => s.startsWith("NM1*PR"));
    const nextSeg = segs[nm1prIdx + 1];
    assert.ok(
      !nextSeg?.startsWith("N3*") || nextSeg?.startsWith("HL*"),
      "N3 should not immediately follow NM1*PR when no payer address",
    );
  });
});

describe("map837p — patient loop (Loop 2000C / 2010CA)", () => {
  const patientInput = (): Map837PInput =>
    baseInput({
      subscriber: makeSubscriber({ is_patient: false }),
      patient: {
        last_name: "Smith",
        first_name: "Tom",
        dob: "20100601",
        sex: "M",
        address1: "300 Pine St",
        city: "Austin",
        state: "TX",
        zip: "78703",
        relationship_code: "19",
      },
    });

  it("emits HL*3 patient HL with level 23", () => {
    const result = map837p(patientInput());
    const segs = parseSegments(result.file_content);
    const hl3 = segs.find((s) => s.startsWith("HL*3*"));
    assert.ok(hl3, "HL*3 patient HL should be present");
    assert.equal(el(hl3!, 3), "23", "Patient HL level = 23");
    assert.equal(el(hl3!, 4), "0", "Patient HL child code = 0");
  });

  it("emits PAT with relationship code", () => {
    const result = map837p(patientInput());
    const segs = parseSegments(result.file_content);
    const pat = findSeg(segs, "PAT");
    assert.ok(pat, "PAT segment should be present");
    assert.equal(el(pat!, 1), "19", "PAT*01 = 19 (child)");
  });

  it("emits NM1*QC patient name", () => {
    const result = map837p(patientInput());
    const segs = parseSegments(result.file_content);
    const nm1qc = segs.find((s) => s.startsWith("NM1*QC"));
    assert.ok(nm1qc, "NM1*QC patient name should be present");
  });

  it("HL*2 has child code = 1 when patient ≠ subscriber", () => {
    const result = map837p(patientInput());
    const segs = parseSegments(result.file_content);
    const hl2 = segs.find((s) => s.startsWith("HL*2*"));
    assert.equal(el(hl2!, 4), "1", "HL*2 child code = 1 when subscriber has a dependent patient");
  });

  it("omits Loop 2000C/2010CA when subscriber.is_patient = true", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    assert.equal(
      segs.find((s) => s.startsWith("NM1*QC")),
      undefined,
      "NM1*QC should not be present when subscriber is patient",
    );
    assert.equal(
      segs.find((s) => s.startsWith("PAT*")),
      undefined,
      "PAT should not be present when subscriber is patient",
    );
  });
});

describe("map837p — referring provider (Loop 2310A)", () => {
  it("emits NM1*DN when referring_provider is supplied", () => {
    const result = map837p(
      baseInput({
        referring_provider: {
          last_name: "Williams",
          first_name: "Robert",
          npi: "9876543210",
        },
      }),
    );
    const segs = parseSegments(result.file_content);
    const nm1dn = segs.find((s) => s.startsWith("NM1*DN"));
    assert.ok(nm1dn, "NM1*DN referring provider should be present");
    assert.equal(el(nm1dn!, 8), "XX", "NM1*DN NPI qualifier = XX");
    assert.equal(el(nm1dn!, 9), "9876543210", "NM1*DN NPI matches");
  });

  it("omits NM1*DN when no referring provider", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    assert.equal(
      segs.find((s) => s.startsWith("NM1*DN")),
      undefined,
      "NM1*DN should be absent without referring provider",
    );
  });
});

describe("map837p — rendering provider (Loop 2310B)", () => {
  it("emits NM1*82 + PRV*PE when rendering_provider with taxonomy is supplied", () => {
    const result = map837p(
      baseInput({
        rendering_provider: {
          entity_type: "1",
          last_name_or_org: "Johnson",
          first_name: "Amy",
          npi: "1111111111",
          taxonomy: "101YA0400X",
        },
      }),
    );
    const segs = parseSegments(result.file_content);
    const nm182 = segs.find((s) => s.startsWith("NM1*82"));
    assert.ok(nm182, "NM1*82 rendering provider should be present");
    assert.equal(el(nm182!, 8), "XX", "NM1*82 NM108 qualifier = XX");
    assert.equal(el(nm182!, 9), "1111111111", "NM1*82 NM109 NPI matches");

    const prv = segs.find((s) => s.startsWith("PRV*PE"));
    assert.ok(prv, "PRV*PE should be present for rendering provider taxonomy");
    assert.equal(el(prv!, 2), "PXC", "PRV*PE 02 = PXC");
    assert.equal(el(prv!, 3), "101YA0400X", "PRV*PE 03 = taxonomy code");
  });

  it("emits NM1*82 without PRV when taxonomy is absent", () => {
    const result = map837p(
      baseInput({
        rendering_provider: {
          last_name_or_org: "Johnson",
          first_name: "Amy",
          npi: "1111111111",
        },
      }),
    );
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("NM1*82")), "NM1*82 should be present");
    assert.equal(
      segs.find((s) => s.startsWith("PRV*PE")),
      undefined,
      "PRV*PE should be absent when no rendering provider taxonomy",
    );
  });
});

describe("map837p — service facility (Loop 2310D)", () => {
  it("emits NM1*77 / N3 / N4 when service_facility is supplied", () => {
    const result = map837p(
      baseInput({
        service_facility: {
          name: "Austin Therapy Center",
          npi: "2222222222",
          address1: "500 Lamar Blvd",
          city: "Austin",
          state: "TX",
          zip: "78704",
        },
      }),
    );
    const segs = parseSegments(result.file_content);
    const nm177 = segs.find((s) => s.startsWith("NM1*77"));
    assert.ok(nm177, "NM1*77 service facility should be present");
    assert.equal(el(nm177!, 8), "XX", "NM1*77 NM108 NPI qualifier = XX");

    const nm177idx = segs.findIndex((s) => s.startsWith("NM1*77"));
    assert.ok(segs[nm177idx + 1]?.startsWith("N3*"), "N3 should follow NM1*77");
    assert.ok(segs[nm177idx + 2]?.startsWith("N4*"), "N4 should follow N3");
  });

  it("omits NM1*77 when no service_facility", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    assert.equal(
      segs.find((s) => s.startsWith("NM1*77")),
      undefined,
      "NM1*77 should be absent without service facility",
    );
  });
});

describe("map837p — clinical date DTP segments", () => {
  it("emits DTP*431 onset date when present", () => {
    const result = map837p(baseInput({ claim: makeClaim({ onset_date: "2026-01-15" }) }));
    const segs = parseSegments(result.file_content);
    const dtp = segs.find((s) => s.startsWith("DTP*431"));
    assert.ok(dtp, "DTP*431 onset date should be present");
    assert.equal(el(dtp!, 3), "20260115", "DTP*431 date formatted as YYYYMMDD");
  });

  it("emits DTP*454 initial treatment date when present", () => {
    const result = map837p(baseInput({ claim: makeClaim({ initial_treatment_date: "2026-02-01" }) }));
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("DTP*454")), "DTP*454 should be present");
  });

  it("emits DTP*304 latest visit date when present", () => {
    const result = map837p(baseInput({ claim: makeClaim({ latest_visit_date: "2026-04-30" }) }));
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("DTP*304")), "DTP*304 should be present");
  });

  it("emits DTP*453 acute manifestation date when present", () => {
    const result = map837p(baseInput({ claim: makeClaim({ acute_manifestation_date: "2025-12-01" }) }));
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("DTP*453")), "DTP*453 should be present");
  });

  it("emits DTP*439 accident date when present", () => {
    const result = map837p(baseInput({ claim: makeClaim({ accident_date: "2026-03-10" }) }));
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("DTP*439")), "DTP*439 should be present");
  });

  it("omits all clinical DTPs when no dates are set", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    for (const qualifier of ["431", "454", "304", "453", "439"]) {
      assert.equal(
        segs.find((s) => s.startsWith(`DTP*${qualifier}`)),
        undefined,
        `DTP*${qualifier} should be absent when no date provided`,
      );
    }
  });
});

describe("map837p — REF segments (corrected claims, prior auth)", () => {
  it("emits REF*D9 when payer_claim_control_number present AND frequency is 7", () => {
    const result = map837p(
      baseInput({
        claim: makeClaim({
          claim_frequency_code: "7",
          payer_claim_control_number: "ICN9876543210",
          original_reference_number: "ORIG-REF-001",
        }),
      }),
    );
    const segs = parseSegments(result.file_content);
    const refD9 = segs.find((s) => s.startsWith("REF*D9"));
    assert.ok(refD9, "REF*D9 should be emitted for frequency 7");
    assert.equal(el(refD9!, 2), "ICN9876543210", "REF*D9 value matches payer_claim_control_number");
  });

  it("emits REF*D9 for frequency 8 (void)", () => {
    const result = map837p(
      baseInput({
        claim: makeClaim({
          claim_frequency_code: "8",
          payer_claim_control_number: "ICN111",
        }),
      }),
    );
    const segs = parseSegments(result.file_content);
    assert.ok(segs.find((s) => s.startsWith("REF*D9")), "REF*D9 should be present for void (frequency 8)");
  });

  it("omits REF*D9 for original claim (frequency 1)", () => {
    const result = map837p(
      baseInput({ claim: makeClaim({ payer_claim_control_number: "ICN9876543210" }) }),
    );
    const segs = parseSegments(result.file_content);
    assert.equal(
      segs.find((s) => s.startsWith("REF*D9")),
      undefined,
      "REF*D9 should NOT be emitted for original claims",
    );
  });

  it("emits REF*F8 when original_reference_number is present", () => {
    const result = map837p(
      baseInput({ claim: makeClaim({ original_reference_number: "ORIG-001" }) }),
    );
    const segs = parseSegments(result.file_content);
    const refF8 = segs.find((s) => s.startsWith("REF*F8"));
    assert.ok(refF8, "REF*F8 should be present when original_reference_number is set");
    assert.equal(el(refF8!, 2), "ORIG-001", "REF*F8 value matches original_reference_number");
  });

  it("emits REF*G1 when prior_authorization_number is present", () => {
    const result = map837p(
      baseInput({ claim: makeClaim({ prior_authorization_number: "AUTH12345" }) }),
    );
    const segs = parseSegments(result.file_content);
    const refG1 = segs.find((s) => s.startsWith("REF*G1"));
    assert.ok(refG1, "REF*G1 should be present for prior auth");
    assert.equal(el(refG1!, 2), "AUTH12345", "REF*G1 value matches prior_authorization_number");
  });
});

describe("map837p — PWK attachment and NTE claim note", () => {
  it("emits PWK when attachment_indicator and attachment_control_number are present", () => {
    const result = map837p(
      baseInput({
        claim: makeClaim({
          attachment_indicator: "OZ",
          attachment_control_number: "ATT-001",
        }),
      }),
    );
    const segs = parseSegments(result.file_content);
    const pwk = findSeg(segs, "PWK");
    assert.ok(pwk, "PWK attachment segment should be present");
    assert.equal(el(pwk!, 1), "OZ", "PWK*01 = attachment type code OZ");
    assert.equal(el(pwk!, 5), "AC", "PWK*05 = AC (attachment control number qualifier)");
    assert.equal(el(pwk!, 6), "ATT-001", "PWK*06 = attachment control number");
  });

  it("omits PWK when attachment fields are absent", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    assert.equal(segs.find((s) => s.startsWith("PWK*")), undefined, "PWK should be absent");
  });

  it("emits NTE*ADD claim note when present", () => {
    const result = map837p(
      baseInput({ claim: makeClaim({ note: "Additional clinical info" }) }),
    );
    const segs = parseSegments(result.file_content);
    const nte = findSeg(segs, "NTE");
    assert.ok(nte, "NTE segment should be present");
    assert.equal(el(nte!, 1), "ADD", "NTE*01 = ADD");
  });

  it("omits NTE when no note", () => {
    const result = map837p(baseInput());
    const segs = parseSegments(result.file_content);
    assert.equal(segs.find((s) => s.startsWith("NTE*")), undefined, "NTE should be absent");
  });
});

describe("map837p — REF*6R line control number and line NTE", () => {
  it("emits REF*6R when line_control_number is present", () => {
    const lines = makeServiceLines({ line_control_number: "LINE-001" });
    const result = map837p(baseInput({ service_lines: lines }));
    const segs = parseSegments(result.file_content);
    const ref6r = segs.find((s) => s.startsWith("REF*6R"));
    assert.ok(ref6r, "REF*6R line control number should be present");
    assert.equal(el(ref6r!, 2), "LINE-001", "REF*6R value matches line_control_number");
  });

  it("emits NTE for line note when present", () => {
    const lines = makeServiceLines({ note: "Line-level note" });
    const result = map837p(baseInput({ service_lines: lines }));
    const segs = parseSegments(result.file_content);
    const nte = findAllSegs(segs, "NTE");
    assert.ok(nte.length > 0, "NTE should be present for line note");
    assert.ok(
      nte.some((s) => el(s, 2) === "Line-level note"),
      "Line note text should appear in NTE",
    );
  });
});

describe("map837p — Loop 2420A line-level rendering provider", () => {
  it("emits NM1*82 + PRV at line level when line rendering provider NPI differs from claim-level", () => {
    const lines: Map837PServiceLine[] = [
      {
        line_number: 1,
        procedure_code: "90834",
        charge_amount: 150,
        units: 1,
        diagnosis_pointers: ["1"],
        date_of_service: "20260501",
        rendering_provider: {
          last_name_or_org: "Brown",
          first_name: "Alice",
          npi: "3333333333",
          taxonomy: "101YM0800X",
        },
      },
    ];
    const result = map837p(
      baseInput({
        rendering_provider: {
          last_name_or_org: "Johnson",
          first_name: "Amy",
          npi: "1111111111",
        },
        service_lines: lines,
      }),
    );
    const segs = parseSegments(result.file_content);
    const nm182Segs = findAllSegs(segs, "NM1*82");
    // One at 2310B (claim-level) + one at 2420A (line-level)
    assert.equal(nm182Segs.length, 2, "Two NM1*82 segments: claim-level and line-level");
    // The second NM1*82 should be the line-level one
    const lineNm182 = nm182Segs[1];
    assert.equal(el(lineNm182!, 9), "3333333333", "Line-level NM1*82 NM109 NPI = 3333333333");
  });

  it("omits Loop 2420A when line rendering provider NPI matches claim-level", () => {
    const lines: Map837PServiceLine[] = [
      {
        line_number: 1,
        procedure_code: "90834",
        charge_amount: 150,
        units: 1,
        diagnosis_pointers: ["1"],
        date_of_service: "20260501",
        rendering_provider: {
          last_name_or_org: "Johnson",
          first_name: "Amy",
          npi: "1111111111", // same as claim-level
        },
      },
    ];
    const result = map837p(
      baseInput({
        rendering_provider: { last_name_or_org: "Johnson", first_name: "Amy", npi: "1111111111" },
        service_lines: lines,
      }),
    );
    const segs = parseSegments(result.file_content);
    const nm182Segs = findAllSegs(segs, "NM1*82");
    assert.equal(nm182Segs.length, 1, "Only one NM1*82 when line-level NPI matches claim-level");
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("validate837pInput — required field errors", () => {
  it("returns empty array for a valid input", () => {
    const errors = validate837pInput(baseInput());
    assert.equal(errors.length, 0, "Valid input should produce no validation errors");
  });

  it("errors when submitter_id is missing", () => {
    const errors = validate837pInput(baseInput({ envelope: makeEnvelope({ submitter_id: "" }) }));
    assert.ok(
      errors.some((e) => e.field === "envelope.submitter_id"),
      "Should error on missing submitter_id",
    );
  });

  it("errors when no contact phone or email (Loop 1000A PER requirement)", () => {
    const errors = validate837pInput(
      baseInput({
        envelope: makeEnvelope({
          submitter_contact_phone: undefined,
          submitter_contact_email: undefined,
        }),
      }),
    );
    assert.ok(
      errors.some((e) => e.field === "envelope.submitter_contact_phone"),
      "Should error when neither phone nor email provided",
    );
  });

  it("errors when billing provider NPI is not 10 digits", () => {
    const errors = validate837pInput(
      baseInput({ billing_provider: makeBillingProvider({ npi: "123" }) }),
    );
    assert.ok(
      errors.some((e) => e.field === "billing_provider.npi"),
      "Should error on invalid NPI",
    );
  });

  it("errors when billing provider address is a PO Box", () => {
    const errors = validate837pInput(
      baseInput({ billing_provider: makeBillingProvider({ address1: "PO Box 123" }) }),
    );
    assert.ok(
      errors.some((e) => e.field === "billing_provider.address1"),
      "Should error when billing address is a PO Box",
    );
  });

  it("errors when subscriber member_id is missing", () => {
    const errors = validate837pInput(
      baseInput({ subscriber: makeSubscriber({ member_id: "" }) }),
    );
    assert.ok(
      errors.some((e) => e.field === "subscriber.member_id"),
      "Should error on missing member_id",
    );
  });

  it("errors when patient is required but not provided (is_patient=false)", () => {
    const errors = validate837pInput(
      baseInput({ subscriber: makeSubscriber({ is_patient: false }), patient: undefined }),
    );
    assert.ok(
      errors.some((e) => e.field === "patient"),
      "Should error when patient object is missing and subscriber.is_patient = false",
    );
  });

  it("errors when diagnosis_codes is empty", () => {
    const errors = validate837pInput(
      baseInput({ claim: makeClaim({ diagnosis_codes: [] }) }),
    );
    assert.ok(
      errors.some((e) => e.field === "claim.diagnosis_codes"),
      "Should error on empty diagnosis codes",
    );
  });

  it("errors when service_lines is empty", () => {
    const errors = validate837pInput(baseInput({ service_lines: [] }));
    assert.ok(
      errors.some((e) => e.field === "service_lines"),
      "Should error on empty service lines",
    );
  });

  it("errors when a service line is missing procedure_code", () => {
    const lines = makeServiceLines({ procedure_code: "" });
    const errors = validate837pInput(baseInput({ service_lines: lines }));
    assert.ok(
      errors.some((e) => e.field.includes("procedure_code")),
      "Should error on missing procedure_code",
    );
  });

  it("errors when referring_provider NPI is invalid", () => {
    const errors = validate837pInput(
      baseInput({
        referring_provider: { last_name: "Smith", npi: "BAD" },
      }),
    );
    assert.ok(
      errors.some((e) => e.field === "referring_provider.npi"),
      "Should error on invalid referring provider NPI",
    );
  });

  it("does not include PHI values in error message text", () => {
    const errors = validate837pInput(baseInput({ subscriber: makeSubscriber({ member_id: "" }) }));
    for (const e of errors) {
      // Error messages should describe the field/rule, not echo a PHI value
      assert.ok(
        !e.message.includes("MEM"),
        `Error message must not include PHI values: "${e.message}"`,
      );
    }
  });

  it("errors when map837p returns ok=false from an invalid input", () => {
    const result = map837p(baseInput({ claim: makeClaim({ diagnosis_codes: [] }) }));
    assert.equal(result.ok, false);
    assert.ok(result.validation_errors.length > 0, "validation_errors should be populated");
    assert.equal(result.file_content, "", "file_content should be empty when ok=false");
  });
});

describe("map837p — ISA usage indicator", () => {
  it("sets ISA*15 = P for production mode", () => {
    const result = map837p(baseInput({ envelope: makeEnvelope({ usage_indicator: "P" }) }));
    const segs = parseSegments(result.file_content);
    const isa = findSeg(segs, "ISA");
    assert.equal(el(isa!, 15), "P", "ISA*15 should be P for production");
  });

  it("sets ISA*15 = T for test mode", () => {
    const result = map837p(baseInput({ envelope: makeEnvelope({ usage_indicator: "T" }) }));
    const segs = parseSegments(result.file_content);
    const isa = findSeg(segs, "ISA");
    assert.equal(el(isa!, 15), "T", "ISA*15 should be T for test");
  });
});
