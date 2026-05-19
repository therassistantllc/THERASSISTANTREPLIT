/**
 * Seed script: Workqueue, Mailroom, and Billing demo data
 * Run with: node artifacts/therassistant-ehr/scripts/seed-billing-data.mjs
 *
 * All UUIDs use only valid hex characters (0-9, a-f).
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_ID = '11111111-1111-1111-1111-111111111111';

// Fixed UUIDs — only hex characters (0-9, a-f)
const C1 = 'cc100001-0000-0000-0000-000000000001';
const C2 = 'cc100001-0000-0000-0000-000000000002';
const C3 = 'cc100001-0000-0000-0000-000000000003';
const C4 = 'cc100001-0000-0000-0000-000000000004';
const C5 = 'cc100001-0000-0000-0000-000000000005';
const A1 = 'aa200001-0000-0000-0000-000000000001';
const A2 = 'aa200001-0000-0000-0000-000000000002';
const A3 = 'aa200001-0000-0000-0000-000000000003';
const A4 = 'aa200001-0000-0000-0000-000000000004';
const A5 = 'aa200001-0000-0000-0000-000000000005';
const A6 = 'aa200001-0000-0000-0000-000000000006';
const A7 = 'aa200001-0000-0000-0000-000000000007';
const A8 = 'aa200001-0000-0000-0000-000000000008';
const E1 = 'ee300001-0000-0000-0000-000000000001';
const E2 = 'ee300001-0000-0000-0000-000000000002';
const E3 = 'ee300001-0000-0000-0000-000000000003';
const E4 = 'ee300001-0000-0000-0000-000000000004';
const E5 = 'ee300001-0000-0000-0000-000000000005';
const E6 = 'ee300001-0000-0000-0000-000000000006';
const E7 = 'ee300001-0000-0000-0000-000000000007';
const E8 = 'ee300001-0000-0000-0000-000000000008';
// Professional claims — ac (hex a=10, c=12)
const PC1 = 'ac400001-0000-0000-0000-000000000001';
const PC2 = 'ac400001-0000-0000-0000-000000000002';
const PC3 = 'ac400001-0000-0000-0000-000000000003';
const PC4 = 'ac400001-0000-0000-0000-000000000004';
const PC5 = 'ac400001-0000-0000-0000-000000000005';
// Batches
const B1 = 'bb500001-0000-0000-0000-000000000001';
const B2 = 'bb500001-0000-0000-0000-000000000002';
// Mailroom — ab (all hex)
const M1 = 'ab600001-0000-0000-0000-000000000001';
const M2 = 'ab600001-0000-0000-0000-000000000002';
const M3 = 'ab600001-0000-0000-0000-000000000003';
const M4 = 'ab600001-0000-0000-0000-000000000004';
const M5 = 'ab600001-0000-0000-0000-000000000005';
const M6 = 'ab600001-0000-0000-0000-000000000006';
const M7 = 'ab600001-0000-0000-0000-000000000007';
const M8 = 'ab600001-0000-0000-0000-000000000008';
// ERA import batches — eb (all hex)
const EB1 = 'eb700001-0000-0000-0000-000000000001';
const EB2 = 'eb700001-0000-0000-0000-000000000002';
const EB3 = 'eb700001-0000-0000-0000-000000000003';
const EB4 = 'eb700001-0000-0000-0000-000000000004';
const EB5 = 'eb700001-0000-0000-0000-000000000005';
// ERA claim payments — ec (all hex)
const ECP1 = 'ec800001-0000-0000-0000-000000000001';
const ECP2 = 'ec800001-0000-0000-0000-000000000002';
const ECP3 = 'ec800001-0000-0000-0000-000000000003';
const ECP4 = 'ec800001-0000-0000-0000-000000000004';
const ECP5 = 'ec800001-0000-0000-0000-000000000005';
// Patient invoices — fa (all hex)
const PI1 = 'fa900001-0000-0000-0000-000000000001';
const PI2 = 'fa900001-0000-0000-0000-000000000002';
const PI3 = 'fa900001-0000-0000-0000-000000000003';
// Patient invoice payments — fe (all hex)
const PIP1 = 'fe000001-0000-0000-0000-000000000001';
const PIP2 = 'fe000001-0000-0000-0000-000000000002';
// Real provider UUID (already exists in DB)
const PROVIDER = '22222222-2222-2222-2222-222222222222';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function dateAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function daysAhead(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
function minLater(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

async function upsert(table, rows) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    console.error(`  ERROR ${table}:`, error.message);
    return false;
  }
  console.log(`  ✓ ${table}: ${rows.length} row(s)`);
  return true;
}

async function main() {
  console.log('\n=== Therassistant EHR Billing Seed ===\n');

  const { data: org } = await supabase.from('organizations').select('id,name').eq('id', ORG_ID).single();
  if (!org) {
    console.error(`Demo org ${ORG_ID} not found. Is the database set up?`);
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${ORG_ID})\n`);

  // ─── 1. Clients ──────────────────────────────────────────────────────────────
  console.log('1. Clients');
  await upsert('clients', [
    { id: C1, organization_id: ORG_ID, first_name: 'Sarah',  last_name: 'Johnson',  date_of_birth: '1985-03-14', sex_at_birth: 'F', phone: '303-555-0101', email: 'sarah.johnson@example.com',  city: 'Denver',       state: 'CO', postal_code: '80202' },
    { id: C2, organization_id: ORG_ID, first_name: 'Marcus', last_name: 'Lee',      date_of_birth: '1979-07-22', sex_at_birth: 'M', phone: '303-555-0102', email: 'marcus.lee@example.com',     city: 'Boulder',      state: 'CO', postal_code: '80301' },
    { id: C3, organization_id: ORG_ID, first_name: 'Dana',   last_name: 'Patel',    date_of_birth: '1992-11-05', sex_at_birth: 'F', phone: '303-555-0103', email: 'dana.patel@example.com',     city: 'Aurora',       state: 'CO', postal_code: '80012' },
    { id: C4, organization_id: ORG_ID, first_name: 'James',  last_name: 'Rivera',   date_of_birth: '1968-04-30', sex_at_birth: 'M', phone: '303-555-0104', email: 'james.rivera@example.com',   city: 'Lakewood',     state: 'CO', postal_code: '80215' },
    { id: C5, organization_id: ORG_ID, first_name: 'Priya',  last_name: 'Thompson', date_of_birth: '1995-09-18', sex_at_birth: 'F', phone: '303-555-0105', email: 'priya.thompson@example.com', city: 'Fort Collins', state: 'CO', postal_code: '80521' },
  ]);

  // ─── 2. Appointments ─────────────────────────────────────────────────────────
  console.log('2. Appointments');
  const apptRows = [
    { id: A1, client_id: C1, days: 60 }, { id: A2, client_id: C2, days: 55 },
    { id: A3, client_id: C3, days: 50 }, { id: A4, client_id: C4, days: 45 },
    { id: A5, client_id: C1, days: 40 }, { id: A6, client_id: C2, days: 35 },
    { id: A7, client_id: C5, days: 30 }, { id: A8, client_id: C3, days: 20 },
  ].map(({ id, client_id, days }) => ({
    id,
    organization_id: ORG_ID,
    client_id,
    provider_id: PROVIDER,
    scheduled_start_at: daysAgo(days),
    scheduled_end_at:   minLater(daysAgo(days), 50),
    appointment_status: 'completed',
    appointment_type:   'individual_therapy',
  }));
  await upsert('appointments', apptRows);

  // ─── 3. Encounters ───────────────────────────────────────────────────────────
  console.log('3. Encounters');
  const encRows = [
    { id: E1, appt: A1, client: C1, days: 60, complete: true  },
    { id: E2, appt: A2, client: C2, days: 55, complete: true  },
    { id: E3, appt: A3, client: C3, days: 50, complete: false },
    { id: E4, appt: A4, client: C4, days: 45, complete: true  },
    { id: E5, appt: A5, client: C1, days: 40, complete: true  },
    { id: E6, appt: A6, client: C2, days: 35, complete: false },
    { id: E7, appt: A7, client: C5, days: 30, complete: true  },
    { id: E8, appt: A8, client: C3, days: 20, complete: true  },
  ].map(({ id, appt, client, days, complete }) => ({
    id,
    organization_id:               ORG_ID,
    appointment_id:                appt,
    client_id:                     client,
    provider_id:                   PROVIDER,
    encounter_status:              'completed',
    service_date:                  dateAgo(days),
    started_at:                    daysAgo(days),
    ended_at:                      minLater(daysAgo(days), 50),
    required_billing_fields_complete: complete,
  }));
  await upsert('encounters', encRows);

  // ─── 4. Charge Capture Items ─────────────────────────────────────────────────
  console.log('4. Charge capture items');
  // Use gen_random_uuid() style IDs for these since conflict key is on encounter_id
  const chargeRows = [
    { enc: E1, appt: A1, client: C1, days: 60, status: 'ready_for_claim', codes: ['F32.1','Z71.1'], lines: [{procedure_code:'90837',units:1,charge_amount:175.00,modifiers:[]},{procedure_code:'90785',units:1,charge_amount:35.00,modifiers:[]}],  total: 210.00, pos: '11', blockers: [] },
    { enc: E2, appt: A2, client: C2, days: 55, status: 'claim_created',   codes: ['F41.1'],          lines: [{procedure_code:'90834',units:1,charge_amount:145.00,modifiers:[]}],                                                                       total: 145.00, pos: '11', blockers: [] },
    { enc: E3, appt: A3, client: C3, days: 50, status: 'blocked',         codes: ['F33.0'],          lines: [{procedure_code:'90837',units:1,charge_amount:175.00,modifiers:[]}],                                                                       total: 175.00, pos: '11', blockers: [{code:'MISSING_INSURANCE_POLICY',message:'No active insurance policy found'},{code:'MISSING_AUTH',message:'Prior authorization required'}] },
    { enc: E4, appt: A4, client: C4, days: 45, status: 'claim_created',   codes: ['F32.9','Z79.899'],lines: [{procedure_code:'90837',units:1,charge_amount:175.00,modifiers:['95']}],                                                                  total: 175.00, pos: '02', blockers: [] },
    { enc: E5, appt: A5, client: C1, days: 40, status: 'ready_for_claim', codes: ['F32.1','F41.0'],  lines: [{procedure_code:'90834',units:1,charge_amount:145.00,modifiers:[]}],                                                                       total: 145.00, pos: '11', blockers: [] },
    { enc: E6, appt: A6, client: C2, days: 35, status: 'blocked',         codes: ['F41.1','F40.10'], lines: [{procedure_code:'90837',units:1,charge_amount:175.00,modifiers:[]}],                                                                       total: 175.00, pos: '11', blockers: [{code:'ELIGIBILITY_NOT_VERIFIED',message:'Eligibility not verified for this date of service'}] },
    { enc: E7, appt: A7, client: C5, days: 30, status: 'claim_created',   codes: ['F32.0'],          lines: [{procedure_code:'90834',units:1,charge_amount:145.00,modifiers:['95']}],                                                                  total: 145.00, pos: '02', blockers: [] },
    { enc: E8, appt: A8, client: C3, days: 20, status: 'ready_for_claim', codes: ['F33.1','Z71.1'],  lines: [{procedure_code:'90837',units:1,charge_amount:175.00,modifiers:[]}],                                                                       total: 175.00, pos: '11', blockers: [] },
  ];
  let chargeOk = 0, chargeErr = 0;
  for (const r of chargeRows) {
    const { error } = await supabase.from('charge_capture_items').insert({
      organization_id:    ORG_ID,
      encounter_id:       r.enc,
      client_id:          r.client,
      provider_id:        PROVIDER,
      appointment_id:     r.appt,
      source_object_type: 'encounter',
      source_object_id:   r.enc,
      charge_status:      r.status,
      service_date:       dateAgo(r.days),
      diagnosis_codes:    r.codes,
      service_lines:      r.lines,
      total_charge:       r.total,
      place_of_service:   r.pos,
      blocker_reasons:    r.blockers,
    });
    // Conflict on the unique partial index (encounter_id where not voided) is not a true error
    if (error && !error.message.includes('unique') && !error.message.includes('duplicate') && !error.message.includes('conflict')) {
      console.error(`  ERROR charge_capture_items (enc ${r.enc}):`, error.message);
      chargeErr++;
    } else {
      chargeOk++;
    }
  }
  console.log(`  ✓ charge_capture_items: ${chargeOk} inserted/skipped, ${chargeErr} errors`);

  // ─── 5. Professional Claims ───────────────────────────────────────────────────
  console.log('5. Professional claims');
  await upsert('professional_claims', [
    { id: PC1, organization_id: ORG_ID, patient_id: C2, appointment_id: A2, claim_number: 'CLM-2026-001', patient_account_number: 'ACC-20260001', claim_status: 'ready_for_batch', total_charge: 145.00, place_of_service: '11', diagnosis_codes: ['F41.1'],          first_billed_date: dateAgo(53), last_billed_date: dateAgo(53), billing_notes: 'Auto-created from charge capture. Ready for 837P batch.' },
    { id: PC2, organization_id: ORG_ID, patient_id: C4, appointment_id: A4, claim_number: 'CLM-2026-002', patient_account_number: 'ACC-20260002', claim_status: 'submitted',       total_charge: 175.00, place_of_service: '02', diagnosis_codes: ['F32.9'],           first_billed_date: dateAgo(43), last_billed_date: dateAgo(43), billing_notes: 'Submitted via 837P batch B2026-01.' },
    { id: PC3, organization_id: ORG_ID, patient_id: C5, appointment_id: A7, claim_number: 'CLM-2026-003', patient_account_number: 'ACC-20260003', claim_status: 'denied',          total_charge: 145.00, place_of_service: '02', diagnosis_codes: ['F32.0'],           first_billed_date: dateAgo(28), last_billed_date: dateAgo(28), billing_notes: 'Denied CARC 97 — service not covered.', denial_reason_code: '97', denial_reason_description: 'Service not covered by payer' },
    { id: PC4, organization_id: ORG_ID, patient_id: C1, appointment_id: A1, claim_number: 'CLM-2026-004', patient_account_number: 'ACC-20260004', claim_status: 'paid',            total_charge: 210.00, place_of_service: '11', diagnosis_codes: ['F32.1','Z71.1'],   first_billed_date: dateAgo(58), last_billed_date: dateAgo(58), billing_notes: 'Paid in full — $168 allowed, $42 write-off.' },
    { id: PC5, organization_id: ORG_ID, patient_id: C1, appointment_id: A5, claim_number: 'CLM-2026-005', patient_account_number: 'ACC-20260005', claim_status: 'ready_for_batch', total_charge: 145.00, place_of_service: '11', diagnosis_codes: ['F32.1','F41.0'],   first_billed_date: dateAgo(38), last_billed_date: dateAgo(38), billing_notes: 'Validated and ready for next 837P batch.' },
  ]);

  // ─── 6. 837P Batches ─────────────────────────────────────────────────────────
  console.log('6. 837P batches');
  await upsert('claim_837p_batches', [
    { id: B1, organization_id: ORG_ID, batch_number: 'B2026-01', batch_status: 'accepted',  claim_count: 1, total_charge_amount: 175.00, generated_file_name: '837P_B2026-01_20260415.edi', submitted_at: daysAgo(40) },
    { id: B2, organization_id: ORG_ID, batch_number: 'B2026-02', batch_status: 'submitted', claim_count: 2, total_charge_amount: 290.00, generated_file_name: '837P_B2026-02_20260507.edi', submitted_at: daysAgo(12) },
  ]);

  console.log('6b. Batch claim links');
  await upsert('claim_837p_batch_claims', [
    { id: 'bc000001-0000-0000-0000-000000000001', organization_id: ORG_ID, batch_id: B1, professional_claim_id: PC2 },
    { id: 'bc000001-0000-0000-0000-000000000002', organization_id: ORG_ID, batch_id: B2, professional_claim_id: PC1 },
    { id: 'bc000001-0000-0000-0000-000000000003', organization_id: ORG_ID, batch_id: B2, professional_claim_id: PC5 },
  ]);

  // ─── 7. Workqueue Items ───────────────────────────────────────────────────────
  console.log('7. Workqueue items');
  const wqRows = [
    { id: 'b0000001-0000-0000-0000-000000000001', src_type: 'client',        src_id: C2,  cid: C2,  eid: null, wt: 'eligibility_check', title: 'Eligibility not verified — Marcus Lee',               st: 'open',        pr: 'high',   desc: 'Patient eligibility has not been checked for the upcoming session. Verify coverage before next appointment.',       ctx: { patient_name: 'Marcus Lee',   last_checked_days_ago: 32, payer: 'BlueCross BlueShield' } },
    { id: 'b0000001-0000-0000-0000-000000000002', src_type: 'client',        src_id: C5,  cid: C5,  eid: null, wt: 'eligibility_check', title: 'Eligibility expiring — Priya Thompson',               st: 'open',        pr: 'normal', desc: 'Insurance policy expires within 30 days. Re-verify coverage and collect updated insurance card.',                    ctx: { patient_name: 'Priya Thompson', policy_expiry_date: daysAhead(25), payer: 'Aetna' } },
    { id: 'b0000001-0000-0000-0000-000000000003', src_type: 'claim',         src_id: PC3, cid: C5,  eid: E7,   wt: 'claim_denial',      title: 'Claim denied — CARC 97 — Priya Thompson',             st: 'open',        pr: 'urgent', desc: 'Claim CLM-2026-003 denied with CARC 97 (Service not covered). Determine if resubmission, appeal, or patient billing is appropriate.', ctx: { claim_number: 'CLM-2026-003', carc_code: '97', patient_name: 'Priya Thompson', denial_date: dateAgo(10), amount_denied: 145.00 } },
    { id: 'b0000001-0000-0000-0000-000000000004', src_type: 'claim',         src_id: PC2, cid: C4,  eid: E4,   wt: 'claim_denial',      title: 'Claim requires follow-up — CLM-2026-002',             st: 'in_progress', pr: 'high',   desc: 'Claim submitted 7 days ago with no response from payer. Follow up with clearinghouse for status update.',              ctx: { claim_number: 'CLM-2026-002', days_since_submission: 7, patient_name: 'James Rivera', payer: 'United Healthcare' } },
    { id: 'b0000001-0000-0000-0000-000000000005', src_type: 'encounter',     src_id: E3,  cid: C3,  eid: E3,   wt: 'missing_info',      title: 'Missing insurance policy — Dana Patel',               st: 'open',        pr: 'high',   desc: 'Encounter cannot be billed: no active insurance policy on file. Contact patient to obtain current insurance information.', ctx: { patient_name: 'Dana Patel', encounter_date: dateAgo(50), blocker: 'MISSING_INSURANCE_POLICY' } },
    { id: 'b0000001-0000-0000-0000-000000000006', src_type: 'encounter',     src_id: E3,  cid: C3,  eid: E3,   wt: 'missing_info',      title: 'Prior auth required — Dana Patel',                    st: 'open',        pr: 'high',   desc: 'Payer requires prior authorization for 90837. Obtain auth number before submitting claim.',                             ctx: { patient_name: 'Dana Patel', procedure_code: '90837', payer: 'Medicaid', blocker: 'MISSING_AUTH' } },
    { id: 'b0000001-0000-0000-0000-000000000007', src_type: 'encounter',     src_id: E6,  cid: C2,  eid: E6,   wt: 'missing_info',      title: 'Eligibility not verified for DOS — Marcus Lee',       st: 'open',        pr: 'normal', desc: 'Charge blocked: eligibility was not verified for the date of service. Run eligibility check before proceeding.',        ctx: { patient_name: 'Marcus Lee', dos: dateAgo(35), blocker: 'ELIGIBILITY_NOT_VERIFIED' } },
    { id: 'b0000001-0000-0000-0000-000000000008', src_type: 'claim',         src_id: PC1, cid: C2,  eid: E2,   wt: 'ar_follow_up',      title: 'AR follow-up — CLM-2026-001 > 30 days',              st: 'open',        pr: 'high',   desc: 'Claim is 30+ days in AR with no response. Initiate follow-up with BlueCross BlueShield.',                              ctx: { claim_number: 'CLM-2026-001', patient_name: 'Marcus Lee', days_in_ar: 35, payer: 'BlueCross BlueShield', charge_amount: 145.00 } },
    { id: 'b0000001-0000-0000-0000-000000000009', src_type: 'claim',         src_id: PC3, cid: C5,  eid: E7,   wt: 'ar_follow_up',      title: 'Appeal deadline approaching — CLM-2026-003',          st: 'open',        pr: 'urgent', desc: 'Denied claim appeal deadline is 15 days away. Draft appeal letter and gather supporting documentation.',                 ctx: { claim_number: 'CLM-2026-003', patient_name: 'Priya Thompson', appeal_deadline: daysAhead(15) } },
    { id: 'b0000001-0000-0000-0000-000000000010', src_type: 'mailroom_item', src_id: M1,  cid: C2,  eid: null, wt: 'mailroom_review',   title: 'EOB received — BlueCross BlueShield — Marcus Lee',    st: 'open',        pr: 'normal', desc: 'Paper EOB received for Marcus Lee. Post payment and reconcile with outstanding claims.',                                ctx: { patient_name: 'Marcus Lee', document_type: 'paper_eob', payer: 'BlueCross BlueShield', mailroom_item_id: M1 } },
    { id: 'b0000001-0000-0000-0000-000000000011', src_type: 'mailroom_item', src_id: M3,  cid: null, eid: null, wt: 'mailroom_review',   title: 'Payer notice — credentialing update required',        st: 'in_progress', pr: 'high',   desc: 'Payer sent credentialing update notice. Review requirements and forward to credentialing team.',                        ctx: { document_type: 'credentialing_notice', payer: 'Aetna', mailroom_item_id: M3 } },
    { id: 'b0000001-0000-0000-0000-000000000012', src_type: 'encounter',     src_id: E1,  cid: C1,  eid: E1,   wt: 'ready_to_bill',     title: 'Charge capture ready — Sarah Johnson',                st: 'open',        pr: 'normal', desc: 'Encounter coded and ready for claim submission. Create 837P claim for this session.',                                   ctx: { patient_name: 'Sarah Johnson', dos: dateAgo(60), procedure_codes: ['90837','90785'], total_charge: 210.00 } },
    { id: 'b0000001-0000-0000-0000-000000000013', src_type: 'encounter',     src_id: E5,  cid: C1,  eid: E5,   wt: 'ready_to_bill',     title: 'Charge capture ready — Sarah Johnson (2nd session)',  st: 'open',        pr: 'normal', desc: 'Second encounter ready for billing. Verify diagnosis codes match treatment plan before submitting.',                    ctx: { patient_name: 'Sarah Johnson', dos: dateAgo(40), procedure_codes: ['90834'], total_charge: 145.00 } },
    { id: 'b0000001-0000-0000-0000-000000000014', src_type: 'encounter',     src_id: E8,  cid: C3,  eid: E8,   wt: 'ready_to_bill',     title: 'Charge capture ready — Dana Patel',                   st: 'open',        pr: 'high',   desc: 'Encounter coded and ready. Confirm insurance policy has been updated before submitting.',                               ctx: { patient_name: 'Dana Patel', dos: dateAgo(20), procedure_codes: ['90837'], total_charge: 175.00 } },
    { id: 'b0000001-0000-0000-0000-000000000015', src_type: 'claim',         src_id: PC5, cid: C1,  eid: null, wt: 'batch_review',      title: '837P batch ready for submission — 2 claims',          st: 'open',        pr: 'high',   desc: 'Claims CLM-2026-001 and CLM-2026-005 are ready for batch. Generate 837P file and submit to clearinghouse.',           ctx: { claim_count: 2, total_charge_amount: 290.00, claims: ['CLM-2026-001','CLM-2026-005'] } },
  ].map(r => ({
    id:                  r.id,
    organization_id:     ORG_ID,
    source_object_type:  r.src_type,
    source_object_id:    r.src_id,
    client_id:           r.cid  || undefined,
    encounter_id:        r.eid  || undefined,
    work_type:           r.wt,
    title:               r.title,
    description:         r.desc,
    status:              r.st,
    priority:            r.pr,
    context_payload:     r.ctx,
  }));

  let wqOk = 0, wqErr = 0;
  for (const row of wqRows) {
    const { error } = await supabase.from('workqueue_items').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error(`  ERROR wq (${row.title.slice(0,45)}):`, error.message); wqErr++; }
    else wqOk++;
  }
  console.log(`  ✓ workqueue_items: ${wqOk} ok, ${wqErr} errors`);

  // ─── 8. Mailroom Items ────────────────────────────────────────────────────────
  // Actual columns (verified): id, organization_id, client_id, workqueue_item_id,
  //   document_type, source, file_name, storage_path, mime_type, notes,
  //   admin_comments, status, mail_status, filed_client_id, filed_at,
  //   created_at, updated_at, archived_at, routed_to_workqueue_id,
  //   routed_at, routed_by_user_id, ticket_id, uploaded_by_user_id, document_scope
  console.log('8. Mailroom items');
  const mailRows = [
    { id: M1, cid: C2,   type: 'paper_eob',          mail_st: 'pending_action', status: 'needs_review', source: 'fax',           fname: 'eob_bcbs_marcus_lee_20260515.pdf',              mime: 'application/pdf', path: 'mailroom/demo/eob_bcbs_marcus_lee_20260515.pdf',             notes: 'Paper EOB received for Marcus Lee. Match to CLM-2026-001 and post payment.',                                                      admin: null },
    { id: M2, cid: C5,   type: 'payer_notice',        mail_st: 'pending_action', status: 'needs_review', source: 'fax',           fname: 'denial_aetna_priya_thompson_20260511.pdf',     mime: 'application/pdf', path: 'mailroom/demo/denial_aetna_priya_thompson_20260511.pdf',      notes: 'Denial notice for CLM-2026-003. CARC 97 — not covered. Review for appeal.',                                                        admin: null },
    { id: M3, cid: null, type: 'credentialing_notice', mail_st: 'pending_action', status: 'needs_review', source: 'mail',          fname: 'credentialing_notice_aetna_20260513.pdf',      mime: 'application/pdf', path: 'mailroom/demo/credentialing_notice_aetna_20260513.pdf',       notes: 'Annual credentialing re-attestation required by June 30, 2026. Assign to credentialing team.',                                      admin: null },
    { id: M4, cid: C4,   type: 'refund_request',      mail_st: 'pending_action', status: 'needs_review', source: 'mail',          fname: 'refund_request_uhc_james_rivera_20260507.pdf', mime: 'application/pdf', path: 'mailroom/demo/refund_request_uhc_james_rivera_20260507.pdf',  notes: 'Payer requesting refund of $52.00 — alleged overpayment on CLM-2026-002. Verify and respond within 30 days.',                      admin: null },
    { id: M5, cid: C1,   type: 'paper_eob',           mail_st: 'filed',          status: 'filed',         source: 'fax',           fname: 'eob_cigna_sarah_johnson_20260424.pdf',         mime: 'application/pdf', path: 'mailroom/demo/eob_cigna_sarah_johnson_20260424.pdf',          notes: 'EOB filed. Payment of $168 posted to CLM-2026-004.',                                                                               admin: `Filed to practice records on ${dateAgo(20)}.` },
    { id: M6, cid: null, type: 'payer_notice',         mail_st: 'filed',          status: 'filed',         source: 'email',         fname: 'medicaid_bulletin_cpt_update_20260504.pdf',    mime: 'application/pdf', path: 'mailroom/demo/medicaid_bulletin_cpt_update_20260504.pdf',     notes: 'Medicaid CPT code policy update effective July 1, 2026. Filed to practice documents.',                                              admin: `Forwarded to clinical director for review. Filed on ${dateAgo(10)}.` },
    { id: M7, cid: C3,   type: 'client_document',     mail_st: 'unsorted',       status: 'needs_review', source: 'patient_portal', fname: 'insurance_card_dana_patel_20260516.jpg',        mime: 'image/jpeg',      path: 'mailroom/demo/insurance_card_dana_patel_20260516.jpg',         notes: 'Patient uploaded new insurance card. Verify policy details and update record.',                                                      admin: null },
    { id: M8, cid: null, type: 'practice_document',   mail_st: 'filed',          status: 'filed',         source: 'email',         fname: 'npi_registry_confirmation_20260429.pdf',       mime: 'application/pdf', path: 'mailroom/demo/npi_registry_confirmation_20260429.pdf',         notes: 'Annual NPI registry verification confirmed. Filed to practice documents.',                                                           admin: `Filed ${dateAgo(18)}.` },
  ].map(r => ({
    id:              r.id,
    organization_id: ORG_ID,
    client_id:       r.cid || undefined,
    document_type:   r.type,
    mail_status:     r.mail_st,
    status:          r.status,
    source:          r.source,
    file_name:       r.fname,
    mime_type:       r.mime,
    storage_path:    r.path,
    notes:           r.notes,
    admin_comments:  r.admin,
  }));

  let mailOk = 0, mailErr = 0;
  for (const row of mailRows) {
    const { error } = await supabase.from('mailroom_items').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error(`  ERROR mailroom (${row.file_name?.slice(0,40)}):`, error.message); mailErr++; }
    else mailOk++;
  }
  console.log(`  ✓ mailroom_items: ${mailOk} ok, ${mailErr} errors`);

  // ─── 9. Update claims with submitted_at for current-month reporting ──────────
  // The billing reports API filters by professional_claims.submitted_at within
  // the selected month. Without this field set, claims won't appear in the report.
  // Today is May 2026, so we set submitted_at to early May so claims appear in the
  // current-month snapshot. We also record the ERA-matched paid/denied status.
  console.log('9. Updating claim submitted_at / claim_status for ERA-linked claims');
  const claimUpdates = [
    { id: PC4, submitted_at: daysAgo(18), claim_status: 'paid',     billing_notes: 'Paid by BlueCross BlueShield via ERA 835. $168 allowed, $42 CO-45 contractual write-off, $42 patient copay billed.' },
    { id: PC2, submitted_at: daysAgo(15), claim_status: 'paid',     billing_notes: 'Paid by United Healthcare via ERA 835. $140 allowed, $35 CO-45 contractual write-off, $35 patient deductible billed.' },
    { id: PC3, submitted_at: daysAgo(17), claim_status: 'denied',   billing_notes: 'Denied by Aetna via ERA 835 — CARC 97 (service not covered). Appeal submitted.' },
    { id: PC1, submitted_at: daysAgo(10), claim_status: 'submitted', billing_notes: 'Submitted via 837P batch B2026-02. ERA received — $116 payment, $29 patient deductible. Awaiting manual posting.' },
  ];
  let cuOk = 0, cuErr = 0;
  for (const upd of claimUpdates) {
    const { error } = await supabase
      .from('professional_claims')
      .update({ submitted_at: upd.submitted_at, claim_status: upd.claim_status, billing_notes: upd.billing_notes })
      .eq('id', upd.id);
    if (error) { console.error(`  ERROR claim update (${upd.id}):`, error.message); cuErr++; }
    else cuOk++;
  }
  console.log(`  ✓ professional_claims updated: ${cuOk} ok, ${cuErr} errors`);

  // ─── 10. ERA Import Batches ───────────────────────────────────────────────────
  console.log('10. ERA import batches');
  await upsert('era_import_batches', [
    {
      id: EB1,
      organization_id: ORG_ID,
      source: 'clearinghouse',
      file_name: '835_BCBS_20260501_001.edi',
      raw_content: 'ISA*00*          *00*          *ZZ*BCBS           *ZZ*DEMO_PRACTICE   *260501*0900*^*00501*000000001*0*P*:~GS*HP*BCBS*DEMO*20260501*0900*1*X*005010X221A1~ST*835*0001~BPR*I*168.00*C*ACH*CCP*01*123456789*DA*987654321*20260501~TRN*1*ERA2026050101*1234567890~REF*EV*BCBS2026~DTM*405*20260501~N1*PR*BLUECROSS BLUESHIELD~N1*PE*DEMO PRACTICE GROUP*XX*1234567890~CLP*CLM-2026-004*1*210.00*168.00*42.00*MC*BCBS-PC4-0001~SVC*HC:90837*175.00*140.00**1~DTM*472*20260501~CAS*CO*45*35.00~SVC*HC:90785*35.00*28.00**1~DTM*472*20260501~CAS*CO*45*7.00~SE*14*0001~GE*1*1~IEA*1*000000001~',
      parsed_summary: { payer: 'BlueCross BlueShield', payer_id: 'BCBS', check_number: 'ACH-20260501-001', payment_date: dateAgo(18), claim_count: 1 },
      import_status: 'posted',
      total_claims: 1,
      total_payment_amount: 168.00,
      total_patient_responsibility: 42.00,
      imported_at: daysAgo(18),
    },
    {
      id: EB2,
      organization_id: ORG_ID,
      source: 'clearinghouse',
      file_name: '835_UHC_20260504_001.edi',
      raw_content: 'ISA*00*          *00*          *ZZ*UHC            *ZZ*DEMO_PRACTICE   *260504*1030*^*00501*000000002*0*P*:~GS*HP*UHC*DEMO*20260504*1030*2*X*005010X221A1~ST*835*0002~BPR*I*140.00*C*ACH*CCP*01*987654321*DA*123456789*20260504~TRN*1*ERA2026050402*0987654321~REF*EV*UHC2026~DTM*405*20260504~N1*PR*UNITED HEALTHCARE~N1*PE*DEMO PRACTICE GROUP*XX*1234567890~CLP*CLM-2026-002*1*175.00*140.00*35.00*MC*UHC-PC2-0001~SVC*HC:90837*175.00*140.00**1~DTM*472*20260504~CAS*CO*45*35.00~SE*12*0002~GE*1*2~IEA*1*000000002~',
      parsed_summary: { payer: 'United Healthcare', payer_id: 'UHC', check_number: 'ACH-20260504-002', payment_date: dateAgo(15), claim_count: 1 },
      import_status: 'posted',
      total_claims: 1,
      total_payment_amount: 140.00,
      total_patient_responsibility: 35.00,
      imported_at: daysAgo(15),
    },
    {
      id: EB3,
      organization_id: ORG_ID,
      source: 'clearinghouse',
      file_name: '835_AETNA_20260502_001.edi',
      raw_content: 'ISA*00*          *00*          *ZZ*AETNA          *ZZ*DEMO_PRACTICE   *260502*1400*^*00501*000000003*0*P*:~GS*HP*AETNA*DEMO*20260502*1400*3*X*005010X221A1~ST*835*0003~BPR*I*0.00*C*NON*~TRN*1*ERA2026050203*2345678901~REF*EV*AETNA2026~DTM*405*20260502~N1*PR*AETNA~N1*PE*DEMO PRACTICE GROUP*XX*1234567890~CLP*CLM-2026-003*4*145.00*0.00*0.00*MC*AETNA-PC3-0001~CAS*CO*97*145.00~SVC*HC:90834*145.00*0.00**1~DTM*472*20260430~CAS*CO*97*145.00~SE*14*0003~GE*1*3~IEA*1*000000003~',
      parsed_summary: { payer: 'Aetna', payer_id: 'AETNA', check_number: 'N/A-DENIAL', payment_date: dateAgo(17), claim_count: 1, denial_count: 1 },
      import_status: 'posted',
      total_claims: 1,
      total_payment_amount: 0.00,
      total_patient_responsibility: 0.00,
      imported_at: daysAgo(17),
    },
    {
      id: EB4,
      organization_id: ORG_ID,
      source: 'clearinghouse',
      file_name: '835_BCBS_20260509_002.edi',
      raw_content: 'ISA*00*          *00*          *ZZ*BCBS           *ZZ*DEMO_PRACTICE   *260509*0830*^*00501*000000004*0*P*:~GS*HP*BCBS*DEMO*20260509*0830*4*X*005010X221A1~ST*835*0004~BPR*I*116.00*C*ACH*CCP*01*123456789*DA*987654321*20260509~TRN*1*ERA2026050904*1234567890~REF*EV*BCBS2026B~DTM*405*20260509~N1*PR*BLUECROSS BLUESHIELD~N1*PE*DEMO PRACTICE GROUP*XX*1234567890~CLP*CLM-2026-001*1*145.00*116.00*29.00*MC*BCBS-PC1-0001~SVC*HC:90834*145.00*116.00**1~DTM*472*20260509~CAS*CO*45*29.00~SE*12*0004~GE*1*4~IEA*1*000000004~',
      parsed_summary: { payer: 'BlueCross BlueShield', payer_id: 'BCBS', check_number: 'ACH-20260509-004', payment_date: dateAgo(10), claim_count: 1 },
      import_status: 'matched',
      total_claims: 1,
      total_payment_amount: 116.00,
      total_patient_responsibility: 29.00,
      imported_at: daysAgo(10),
    },
    {
      id: EB5,
      organization_id: ORG_ID,
      source: 'manual_upload',
      file_name: '835_CIGNA_20260514_001.edi',
      raw_content: 'ISA*00*          *00*          *ZZ*CIGNA          *ZZ*DEMO_PRACTICE   *260514*1100*^*00501*000000005*0*P*:~GS*HP*CIGNA*DEMO*20260514*1100*5*X*005010X221A1~ST*835*0005~BPR*I*156.00*C*ACH*CCP*01*555666777*DA*777888999*20260514~TRN*1*ERA2026051405*5556667770~REF*EV*CIGNA2026~DTM*405*20260514~N1*PR*CIGNA BEHAVIORAL HEALTH~N1*PE*DEMO PRACTICE GROUP*XX*1234567890~CLP*CLM-2026-CIGNA-001*1*195.00*156.00*39.00*MC*CIGNA-EXT-0001~SVC*HC:90837*195.00*156.00**1~DTM*472*20260514~CAS*CO*45*39.00~SE*12*0005~GE*1*5~IEA*1*000000005~',
      parsed_summary: { payer: 'Cigna Behavioral Health', payer_id: 'CIGNA', check_number: 'ACH-20260514-005', payment_date: dateAgo(5), claim_count: 1, note: 'External claim — no matching local claim found.' },
      import_status: 'blocked',
      total_claims: 1,
      total_payment_amount: 156.00,
      total_patient_responsibility: 39.00,
      imported_at: daysAgo(5),
    },
  ]);

  // ─── 11. ERA Claim Payments ───────────────────────────────────────────────────
  console.log('11. ERA claim payments');
  await upsert('era_claim_payments', [
    {
      id: ECP1,
      organization_id: ORG_ID,
      era_import_batch_id: EB1,
      professional_claim_id: PC4,
      client_id: C1,
      clp01_claim_control_number: 'CLM-2026-004',
      clp02_claim_status_code: '1',
      clp03_total_charge: 210.00,
      clp04_payment_amount: 168.00,
      clp05_patient_responsibility: 42.00,
      payer_claim_control_number: 'BCBS-PC4-0001',
      claim_match_status: 'matched',
      posting_status: 'posted',
      cas_adjustments: [{ group_code: 'CO', reason_code: '45', amount: 42.00, description: 'Charges exceed fee schedule/maximum allowable' }],
      service_lines: [
        { procedure_code: '90837', charge: 175.00, allowed: 140.00, paid: 140.00, adjustment: 35.00, adjustment_code: 'CO-45' },
        { procedure_code: '90785', charge: 35.00, allowed: 28.00, paid: 28.00, adjustment: 7.00, adjustment_code: 'CO-45' },
      ],
      raw_segments: [],
    },
    {
      id: ECP2,
      organization_id: ORG_ID,
      era_import_batch_id: EB2,
      professional_claim_id: PC2,
      client_id: C4,
      clp01_claim_control_number: 'CLM-2026-002',
      clp02_claim_status_code: '1',
      clp03_total_charge: 175.00,
      clp04_payment_amount: 140.00,
      clp05_patient_responsibility: 35.00,
      payer_claim_control_number: 'UHC-PC2-0001',
      claim_match_status: 'matched',
      posting_status: 'posted',
      cas_adjustments: [{ group_code: 'CO', reason_code: '45', amount: 35.00, description: 'Charges exceed fee schedule/maximum allowable' }],
      service_lines: [
        { procedure_code: '90837', charge: 175.00, allowed: 140.00, paid: 140.00, adjustment: 35.00, adjustment_code: 'CO-45' },
      ],
      raw_segments: [],
    },
    {
      id: ECP3,
      organization_id: ORG_ID,
      era_import_batch_id: EB3,
      professional_claim_id: PC3,
      client_id: C5,
      clp01_claim_control_number: 'CLM-2026-003',
      clp02_claim_status_code: '4',
      clp03_total_charge: 145.00,
      clp04_payment_amount: 0.00,
      clp05_patient_responsibility: 0.00,
      payer_claim_control_number: 'AETNA-PC3-0001',
      claim_match_status: 'matched',
      posting_status: 'posted',
      cas_adjustments: [{ group_code: 'CO', reason_code: '97', amount: 145.00, description: 'Payment is included in the allowance for another service/procedure' }],
      service_lines: [
        { procedure_code: '90834', charge: 145.00, allowed: 0.00, paid: 0.00, adjustment: 145.00, adjustment_code: 'CO-97' },
      ],
      raw_segments: [],
    },
    {
      id: ECP4,
      organization_id: ORG_ID,
      era_import_batch_id: EB4,
      professional_claim_id: PC1,
      client_id: C2,
      clp01_claim_control_number: 'CLM-2026-001',
      clp02_claim_status_code: '1',
      clp03_total_charge: 145.00,
      clp04_payment_amount: 116.00,
      clp05_patient_responsibility: 29.00,
      payer_claim_control_number: 'BCBS-PC1-0001',
      claim_match_status: 'matched',
      posting_status: 'ready',
      cas_adjustments: [{ group_code: 'CO', reason_code: '45', amount: 29.00, description: 'Charges exceed fee schedule/maximum allowable' }],
      service_lines: [
        { procedure_code: '90834', charge: 145.00, allowed: 116.00, paid: 116.00, adjustment: 29.00, adjustment_code: 'CO-45' },
      ],
      raw_segments: [],
    },
    {
      id: ECP5,
      organization_id: ORG_ID,
      era_import_batch_id: EB5,
      professional_claim_id: null,
      client_id: null,
      clp01_claim_control_number: 'CLM-2026-CIGNA-001',
      clp02_claim_status_code: '1',
      clp03_total_charge: 195.00,
      clp04_payment_amount: 156.00,
      clp05_patient_responsibility: 39.00,
      payer_claim_control_number: 'CIGNA-EXT-0001',
      claim_match_status: 'unmatched',
      posting_status: 'blocked',
      cas_adjustments: [{ group_code: 'CO', reason_code: '45', amount: 39.00, description: 'Charges exceed fee schedule/maximum allowable' }],
      service_lines: [
        { procedure_code: '90837', charge: 195.00, allowed: 156.00, paid: 156.00, adjustment: 39.00, adjustment_code: 'CO-45' },
      ],
      raw_segments: [],
    },
  ]);

  // ─── 12. ERA Posting Ledger Entries ──────────────────────────────────────────
  console.log('12. ERA posting ledger entries');
  const ledgerRows = [
    { era_claim_payment_id: ECP1, professional_claim_id: PC4, client_id: C1, entry_type: 'insurance_payment',      amount: 168.00, group_code: null, reason_code: null, description: 'BlueCross BlueShield payment — CLM-2026-004' },
    { era_claim_payment_id: ECP1, professional_claim_id: PC4, client_id: C1, entry_type: 'contractual_adjustment', amount: 42.00,  group_code: 'CO', reason_code: '45',  description: 'Contractual write-off — charges exceed fee schedule' },
    { era_claim_payment_id: ECP1, professional_claim_id: PC4, client_id: C1, entry_type: 'patient_responsibility', amount: 42.00,  group_code: 'PR', reason_code: '1',   description: 'Patient deductible/copay — billed via invoice INV-2026-001' },
    { era_claim_payment_id: ECP2, professional_claim_id: PC2, client_id: C4, entry_type: 'insurance_payment',      amount: 140.00, group_code: null, reason_code: null, description: 'United Healthcare payment — CLM-2026-002' },
    { era_claim_payment_id: ECP2, professional_claim_id: PC2, client_id: C4, entry_type: 'contractual_adjustment', amount: 35.00,  group_code: 'CO', reason_code: '45',  description: 'Contractual write-off — charges exceed fee schedule' },
    { era_claim_payment_id: ECP2, professional_claim_id: PC2, client_id: C4, entry_type: 'patient_responsibility', amount: 35.00,  group_code: 'PR', reason_code: '3',   description: 'Patient deductible — billed via invoice INV-2026-002' },
    { era_claim_payment_id: ECP3, professional_claim_id: PC3, client_id: C5, entry_type: 'other_adjustment',       amount: 145.00, group_code: 'CO', reason_code: '97',  description: 'Claim denied — CARC 97: service not covered' },
    { era_claim_payment_id: ECP4, professional_claim_id: PC1, client_id: C2, entry_type: 'insurance_payment',      amount: 116.00, group_code: null, reason_code: null, description: 'BlueCross BlueShield payment — CLM-2026-001 (pending posting)' },
    { era_claim_payment_id: ECP4, professional_claim_id: PC1, client_id: C2, entry_type: 'contractual_adjustment', amount: 29.00,  group_code: 'CO', reason_code: '45',  description: 'Contractual write-off — charges exceed fee schedule' },
    { era_claim_payment_id: ECP4, professional_claim_id: PC1, client_id: C2, entry_type: 'patient_responsibility', amount: 29.00,  group_code: 'PR', reason_code: '3',   description: 'Patient deductible — invoice pending' },
  ];
  let ledgerOk = 0, ledgerErr = 0;
  for (const row of ledgerRows) {
    const { error } = await supabase.from('era_posting_ledger_entries').insert({
      organization_id: ORG_ID,
      era_claim_payment_id: row.era_claim_payment_id,
      professional_claim_id: row.professional_claim_id,
      client_id: row.client_id,
      entry_type: row.entry_type,
      amount: row.amount,
      group_code: row.group_code,
      reason_code: row.reason_code,
      description: row.description,
    });
    if (error && !error.message.includes('unique') && !error.message.includes('duplicate')) {
      console.error(`  ERROR ledger (${row.description?.slice(0, 45)}):`, error.message);
      ledgerErr++;
    } else {
      ledgerOk++;
    }
  }
  console.log(`  ✓ era_posting_ledger_entries: ${ledgerOk} inserted/skipped, ${ledgerErr} errors`);

  // ─── 13. Patient Invoices ─────────────────────────────────────────────────────
  console.log('13. Patient invoices');
  await upsert('patient_invoices', [
    {
      id: PI1,
      organization_id: ORG_ID,
      client_id: C1,
      professional_claim_id: PC4,
      era_claim_payment_id: ECP1,
      invoice_status: 'paid',
      invoice_number: 'INV-2026-001',
      patient_responsibility_amount: 42.00,
      paid_amount: 42.00,
      balance_amount: 0.00,
      source: 'era_pr',
    },
    {
      id: PI2,
      organization_id: ORG_ID,
      client_id: C4,
      professional_claim_id: PC2,
      era_claim_payment_id: ECP2,
      invoice_status: 'sent',
      invoice_number: 'INV-2026-002',
      patient_responsibility_amount: 35.00,
      paid_amount: 0.00,
      balance_amount: 35.00,
      source: 'era_pr',
    },
    {
      id: PI3,
      organization_id: ORG_ID,
      client_id: C2,
      professional_claim_id: PC1,
      era_claim_payment_id: ECP4,
      invoice_status: 'open',
      invoice_number: 'INV-2026-003',
      patient_responsibility_amount: 29.00,
      paid_amount: 0.00,
      balance_amount: 29.00,
      source: 'era_pr',
    },
  ]);

  // ─── 14. Patient Invoice Payments ─────────────────────────────────────────────
  // These drive the "Posted payments" metric in the Billing Reports page.
  // paid_at is set within the current month (May 2026) so they appear in the report.
  console.log('14. Patient invoice payments');
  await upsert('patient_invoice_payments', [
    {
      id: PIP1,
      organization_id: ORG_ID,
      patient_invoice_id: PI1,
      client_id: C1,
      payment_status: 'posted',
      payment_method: 'card',
      amount: 42.00,
      memo: 'Patient copay — Sarah Johnson — CLM-2026-004 — card on file',
      paid_at: daysAgo(8),
    },
    {
      id: PIP2,
      organization_id: ORG_ID,
      patient_invoice_id: PI2,
      client_id: C4,
      payment_status: 'posted',
      payment_method: 'check',
      amount: 20.00,
      memo: 'Partial deductible payment — James Rivera — CLM-2026-002 — check #4421',
      paid_at: daysAgo(3),
    },
  ]);

  console.log('\n=== Seed complete ===\n');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
