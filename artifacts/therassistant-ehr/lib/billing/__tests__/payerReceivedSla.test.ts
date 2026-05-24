/**
 * Verifies that loadPayerReceivedClaims drives the "Expected adjudication date"
 * off the per-payer payer_profiles.adjudication_sla_days column rather than a
 * hard-coded 30-day default. This is the core behavior for Task #447.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { loadPayerReceivedClaims } from "../payerReceivedService";

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>): {
  from: (t: string) => unknown;
} {
  function build(table: string) {
    let rows: Row[] = [...(tables[table] ?? [])];
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return self;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals);
        rows = rows.filter((r) => set.has(r[col] as unknown));
        return self;
      },
      is: (col: string, val: unknown) => {
        rows = rows.filter((r) => (r[col] ?? null) === val);
        return self;
      },
      order: () => self,
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }
  return { from: (t: string) => build(t) };
}

const ORG = "org-1";
const RECEIVED_AT = "2026-05-01T00:00:00.000Z";

function baseFixture(slaDays: number | null) {
  return {
    professional_claims: [
      {
        id: "claim-1",
        organization_id: ORG,
        patient_id: "client-1",
        appointment_id: "appt-1",
        payer_profile_id: "payer-1",
        claim_number: "C-1",
        claim_status: "accepted_payer",
        total_charge: 100,
        submitted_at: RECEIVED_AT,
        billing_notes: null,
        created_at: RECEIVED_AT,
        updated_at: RECEIVED_AT,
      },
    ],
    clients: [{ id: "client-1", first_name: "Ada", last_name: "Lovelace" }],
    appointments: [
      {
        id: "appt-1",
        scheduled_start_at: RECEIVED_AT,
        provider_id: null,
        provider_location_id: null,
      },
    ],
    payer_profiles: [
      {
        id: "payer-1",
        payer_name: "Test Payer",
        availity_payer_id: "TEST",
        adjudication_sla_days: slaDays,
      },
    ],
    claim_status_events: [],
    claim_status_inquiries: [],
    claim_submissions: [],
    audit_logs: [],
  } as Record<string, Row[]>;
}

async function expectedFor(sla: number | null): Promise<string | null> {
  const sb = fakeSupabase(baseFixture(sla)) as unknown as Parameters<
    typeof loadPayerReceivedClaims
  >[0]["supabase"];
  const rows = await loadPayerReceivedClaims({ supabase: sb, organizationId: ORG });
  assert.equal(rows.length, 1);
  return rows[0].expectedAdjudicationAt;
}

describe("loadPayerReceivedClaims uses per-payer SLA for expected adjudication", () => {
  it("adds the payer's adjudication_sla_days to payerReceivedAt (Medicare ~14)", async () => {
    const iso = await expectedFor(14);
    assert.equal(iso, "2026-05-15T00:00:00.000Z");
  });

  it("respects a long Medicaid-style SLA (60 days)", async () => {
    const iso = await expectedFor(60);
    assert.equal(iso, "2026-06-30T00:00:00.000Z");
  });

  it("falls back to 30 days when the payer's SLA is null", async () => {
    const iso = await expectedFor(null);
    assert.equal(iso, "2026-05-31T00:00:00.000Z");
  });
});

async function rowsFor(sla: number | null, receivedAt: string) {
  const fixture = baseFixture(sla);
  const claim = fixture.professional_claims[0];
  claim.submitted_at = receivedAt;
  claim.created_at = receivedAt;
  claim.updated_at = receivedAt;
  fixture.appointments[0].scheduled_start_at = receivedAt;
  const sb = fakeSupabase(fixture) as unknown as Parameters<
    typeof loadPayerReceivedClaims
  >[0]["supabase"];
  return loadPayerReceivedClaims({ supabase: sb, organizationId: ORG });
}

describe("loadPayerReceivedClaims flags SLA-breached claims as overdue", () => {
  it("flags a claim whose expected adjudication date is in the past", async () => {
    // 14-day SLA, received 60 days ago → expected ~46 days past
    const receivedAt = new Date(Date.now() - 60 * 86400_000).toISOString();
    const rows = await rowsFor(14, receivedAt);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].overdue, true);
    assert.ok(rows[0].daysOverdue >= 40, `daysOverdue=${rows[0].daysOverdue}`);
  });

  it("does NOT flag a fresh claim still inside its SLA window", async () => {
    // 30-day SLA, received 5 days ago → still well inside SLA
    const receivedAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    const rows = await rowsFor(30, receivedAt);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].overdue, false);
    assert.equal(rows[0].daysOverdue, 0);
  });

  it("classifies an approaching-SLA claim into the approaching_follow_up tab", async () => {
    // 14-day SLA, received 12 days ago → 2 days until expected, well inside
    // the ceil(14*0.25)=4 day approaching window.
    const receivedAt = new Date(Date.now() - 12 * 86400_000).toISOString();
    const rows = await rowsFor(14, receivedAt);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].overdue, false);
    assert.equal(rows[0].tab, "approaching_follow_up");
  });

  it("does NOT treat a 60-day-SLA claim as approaching when 7 days from now", async () => {
    // Old logic (flat 7-day) would mark this as approaching; SLA-derived
    // window for 60-day SLA is ~15 days, so a claim received 53 days ago
    // (7 days from expected) IS still approaching. Use 40 days ago instead:
    // 20 days from expected → outside approaching window for 60-day SLA.
    const receivedAt = new Date(Date.now() - 40 * 86400_000).toISOString();
    const rows = await rowsFor(60, receivedAt);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].overdue, false);
    assert.notEqual(rows[0].tab, "approaching_follow_up");
  });
});

describe("loadPayerReceivedClaims default sort + overdue filter", () => {
  it("sorts overdue rows ahead of non-overdue rows", async () => {
    const oldReceived = new Date(Date.now() - 90 * 86400_000).toISOString();
    const newReceived = new Date(Date.now() - 2 * 86400_000).toISOString();
    const fixture = baseFixture(30);
    fixture.professional_claims = [
      {
        ...fixture.professional_claims[0],
        id: "claim-fresh",
        claim_number: "C-FRESH",
        submitted_at: newReceived,
        created_at: newReceived,
        updated_at: newReceived,
      },
      {
        ...fixture.professional_claims[0],
        id: "claim-overdue",
        claim_number: "C-OVERDUE",
        submitted_at: oldReceived,
        created_at: oldReceived,
        updated_at: oldReceived,
      },
    ];
    const sb = fakeSupabase(fixture) as unknown as Parameters<
      typeof loadPayerReceivedClaims
    >[0]["supabase"];
    const rows = await loadPayerReceivedClaims({ supabase: sb, organizationId: ORG });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "claim-overdue");
    assert.equal(rows[0].overdue, true);
    assert.equal(rows[1].id, "claim-fresh");
    assert.equal(rows[1].overdue, false);
  });

  it("`overdue=true` filter drops non-overdue rows", async () => {
    const oldReceived = new Date(Date.now() - 90 * 86400_000).toISOString();
    const newReceived = new Date(Date.now() - 2 * 86400_000).toISOString();
    const fixture = baseFixture(30);
    fixture.professional_claims = [
      {
        ...fixture.professional_claims[0],
        id: "claim-fresh",
        claim_number: "C-FRESH",
        submitted_at: newReceived,
        created_at: newReceived,
        updated_at: newReceived,
      },
      {
        ...fixture.professional_claims[0],
        id: "claim-overdue",
        claim_number: "C-OVERDUE",
        submitted_at: oldReceived,
        created_at: oldReceived,
        updated_at: oldReceived,
      },
    ];
    const sb = fakeSupabase(fixture) as unknown as Parameters<
      typeof loadPayerReceivedClaims
    >[0]["supabase"];
    const rows = await loadPayerReceivedClaims({
      supabase: sb,
      organizationId: ORG,
      filters: { overdue: "true" },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "claim-overdue");
  });
});
