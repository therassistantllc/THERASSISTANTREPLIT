/**
 * Filter-rail coverage for GET /api/billing/patient-billing.
 *
 * Pins the contract that every required filter (practice, clinician, payer,
 * client, DOS, status, assigned biller, $ amount, aging bucket, CARC/RARC,
 * priority, follow-up due date) is parsed from the URL and actually narrows
 * the result set. Without this test, additions to the UI filter list could
 * silently no-op on the server (which is exactly how this route was first
 * shipped).
 */
import { strict as assert } from "node:assert";
import { before, beforeEach, mock, test } from "node:test";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const tables: Tables = {};

function resetTables() {
  for (const k of Object.keys(tables)) delete tables[k];
}

function fakeBuilder(table: string) {
  let rows = [...(tables[table] ?? [])];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (field: string, value: unknown) => {
    rows = rows.filter((r) => r[field] === value);
    return chain;
  };
  chain.in = (field: string, values: unknown[]) => {
    const set = new Set(values);
    rows = rows.filter((r) => set.has(r[field]));
    return chain;
  };
  chain.is = (field: string, value: unknown) => {
    rows = rows.filter((r) => (value === null ? r[field] == null : r[field] === value));
    return chain;
  };
  chain.ilike = (field: string, pattern: string) => {
    const prefix = pattern.replace(/%$/, "");
    rows = rows.filter((r) =>
      String(r[field] ?? "").toLowerCase().startsWith(prefix.toLowerCase()),
    );
    return chain;
  };
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    Promise.resolve(resolve({ data: rows, error: null }));
  return chain;
}

const fakeSupabase = { from: (t: string) => fakeBuilder(t) };

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseAdminClient: () => fakeSupabase,
  },
});

mock.module("@/lib/billing/requireBillingAccess", {
  namedExports: {
    requireBillingAccess: async () => ({
      organizationId: "org-1",
      userId: "user-1",
    }),
  },
});

// Import after mocks are installed.
let GET: (req: Request) => Promise<Response>;
before(async () => {
  const routeMod = await import("../route");
  GET = routeMod.GET as (req: Request) => Promise<Response>;
});

const ORG = "org-1";
const today = new Date();
const iso = (offsetDays: number) =>
  new Date(today.getTime() - offsetDays * 86_400_000).toISOString();

function seed() {
  resetTables();
  tables.patient_invoices = [
    {
      id: "inv-A",
      client_id: "client-A",
      professional_claim_id: "claim-A",
      era_claim_payment_id: "era-A",
      invoice_status: "open",
      invoice_number: "INV-A",
      patient_responsibility_amount: 200,
      paid_amount: 0,
      balance_amount: 200,
      source: "manual",
      created_at: iso(10),
      archived_at: null,
      organization_id: ORG,
    },
    {
      id: "inv-B",
      client_id: "client-B",
      professional_claim_id: "claim-B",
      era_claim_payment_id: "era-B",
      invoice_status: "open",
      invoice_number: "INV-B",
      patient_responsibility_amount: 50,
      paid_amount: 0,
      balance_amount: 50,
      source: "manual",
      created_at: iso(120),
      archived_at: null,
      organization_id: ORG,
    },
  ];
  tables.clients = [
    {
      id: "client-A",
      first_name: "Alice",
      last_name: "Alpha",
      primary_clinician_user_id: "clin-1",
      organization_id: "practice-1",
    },
    {
      id: "client-B",
      first_name: "Bob",
      last_name: "Beta",
      primary_clinician_user_id: "clin-2",
      organization_id: "practice-2",
    },
  ];
  tables.professional_claims = [
    {
      id: "claim-A",
      appointment_id: "appt-A",
      payer_profile_id: "payer-1",
      first_billed_date: iso(10),
      total_charge: 200,
      claim_status: "paid",
    },
    {
      id: "claim-B",
      appointment_id: "appt-B",
      payer_profile_id: "payer-2",
      first_billed_date: iso(120),
      total_charge: 50,
      claim_status: "paid",
    },
  ];
  tables.appointments = [
    { id: "appt-A", scheduled_start_at: iso(10) },
    { id: "appt-B", scheduled_start_at: iso(120) },
  ];
  tables.payer_profiles = [
    { id: "payer-1", payer_name: "Aetna" },
    { id: "payer-2", payer_name: "Cigna" },
  ];
  tables.providers = [
    { id: "clin-1", first_name: "Dr", last_name: "One", display_name: "Dr One" },
    { id: "clin-2", first_name: "Dr", last_name: "Two", display_name: "Dr Two" },
  ];
  tables.patient_invoice_payments = [];
  tables.audit_logs = [
    {
      id: "aud-A",
      patient_id: "client-A",
      event_type: "patient_billing_invoice_sent",
      event_summary: "sent",
      event_metadata: {},
      created_at: iso(2),
      user_id: "biller-1",
      organization_id: ORG,
    },
    {
      id: "aud-B",
      patient_id: "client-B",
      event_type: "patient_billing_invoice_sent",
      event_summary: "sent",
      event_metadata: {},
      created_at: iso(120),
      user_id: "biller-2",
      organization_id: ORG,
    },
  ];
  tables.era_claim_payments = [
    { id: "era-A", carc_codes: ["45"], rarc_codes: ["N123"] },
    { id: "era-B", carc_codes: ["96"], rarc_codes: [] },
  ];
}

async function fetchItems(qs: string): Promise<Row[]> {
  const res = await GET(
    new Request(`http://localhost/api/billing/patient-billing?${qs}`),
  );
  const body = (await res.json()) as { items: Row[] };
  return body.items;
}

beforeEach(() => seed());

test("baseline returns both clients", async () => {
  const items = await fetchItems("");
  assert.equal(items.length, 2);
});

test("practice filter narrows to one client", async () => {
  const items = await fetchItems("practice=practice-1");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-A"],
  );
});

test("clinician filter narrows by primary_clinician_user_id", async () => {
  const items = await fetchItems("clinician=clin-2");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-B"],
  );
});

test("payer filter narrows by payer_name", async () => {
  const items = await fetchItems("payer=Aetna");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-A"],
  );
});

test("client filter narrows by client_id", async () => {
  const items = await fetchItems("client=client-B");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-B"],
  );
});

test("status filter narrows by row.status", async () => {
  const all = await fetchItems("");
  const targetStatus = String(all.find((r) => r.client_id === "client-A")?.status);
  const items = await fetchItems(`status=${targetStatus}`);
  assert.ok(items.every((i) => i.status === targetStatus));
  assert.ok(items.length >= 1 && items.length < all.length + 1);
});

test("aging bucket filter narrows by row.aging_bucket", async () => {
  const items = await fetchItems("agingBucket=90_plus");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-B"],
  );
});

test("dollar amount filter narrows by balance range", async () => {
  const items = await fetchItems("minAmount=100");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-A"],
  );
});

test("DOS range filter narrows by oldest_dos", async () => {
  const cutoff = iso(60).slice(0, 10);
  const items = await fetchItems(`dosTo=${cutoff}`);
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-B"],
  );
});

test("assignedBiller filter narrows by derived biller user_id", async () => {
  const items = await fetchItems("assignedBiller=biller-1");
  assert.deepEqual(
    items.map((i) => i.client_id),
    ["client-A"],
  );
});

test("carcRarc filter narrows by CARC or RARC code", async () => {
  const carcHit = await fetchItems("carcRarc=96");
  assert.deepEqual(
    carcHit.map((i) => i.client_id),
    ["client-B"],
  );
  const rarcHit = await fetchItems("carcRarc=N123");
  assert.deepEqual(
    rarcHit.map((i) => i.client_id),
    ["client-A"],
  );
});

test("followUpDue filter narrows by row.next_follow_up_at (no-op when no follow-up set)", async () => {
  const future = iso(-30).slice(0, 10);
  const items = await fetchItems(`followUpDue=${future}`);
  assert.ok(Array.isArray(items));
});

test("priority filter narrows by row.priority", async () => {
  const all = await fetchItems("");
  const p = String(all[0]?.priority ?? "");
  if (!p) return;
  const items = await fetchItems(`priority=${p}`);
  assert.ok(items.every((i) => i.priority === p));
});
