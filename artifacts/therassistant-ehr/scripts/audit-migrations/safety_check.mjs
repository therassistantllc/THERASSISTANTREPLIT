#!/usr/bin/env node
// Pre-replay safety: confirm rows we'd be NOT-NULLing are absent.
const REF = process.env.SUPABASE_PROJECT_REF.trim();
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN.trim();
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// Tables enforce_client_schema_drift will set client_id NOT NULL on.
// We need them empty (or all rows already have client_id) before replay.
for (const t of ['encounters', 'claims', 'eligibility_checks', 'claim_status_inquiries']) {
  const total = (await q(`select count(*)::int as n from public.${t}`))[0].n;
  let nullCount = 0;
  // column may not exist yet
  const hasCol = (await q(`select 1 from information_schema.columns where table_schema='public' and table_name='${t}' and column_name='client_id'`)).length > 0;
  if (hasCol) nullCount = (await q(`select count(*)::int as n from public.${t} where client_id is null`))[0].n;
  console.log(`${t}: rows=${total}, has client_id col=${hasCol}, null=${nullCount}`);
}

// Tables 837p_foundation will reference (FKs to clients, organizations, appointments)
for (const t of ['organizations', 'clients', 'appointments']) {
  const exists = (await q(`select to_regclass('public.${t}') as r`))[0].r;
  console.log(`${t}: ${exists ? 'present' : 'MISSING'}`);
}

// claim_status_events should already exist (the migration only adds columns to it)
console.log('claim_status_events exists?', (await q(`select to_regclass('public.claim_status_events') as r`))[0].r);
