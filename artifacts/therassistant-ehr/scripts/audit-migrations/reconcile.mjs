#!/usr/bin/env node
// Reconcile drifted migrations. Each unit runs inside its own transaction
// via the Supabase Management API.
//
// Note: 20260505010000_enforce_client_schema_drift.sql cannot be replayed
// wholesale because live made `public.eligibility_status` a typed enum
// (values: not_checked, active, inactive, pending, error) — the migration's
// text-literal check constraint (`'not_found'`, ...) fails to cast to the
// enum. The only objects from that migration actually missing on prod are
// three `client_id` columns; apply them surgically.
import fs from 'node:fs';
import path from 'node:path';

const REF = process.env.SUPABASE_PROJECT_REF.trim();
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN.trim();
const DIR = 'artifacts/therassistant-ehr/supabase/migrations';

async function exec(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text}`);
  return text;
}

const surgical_20260505010000 = `
-- Surgical replay of enforce_client_schema_drift: only the missing client_id
-- adds (skip enum-incompatible check constraint and already-applied bits).
alter table if exists public.claim_status_inquiries add column if not exists client_id uuid;
alter table if exists public.edi_transactions          add column if not exists client_id uuid;
alter table if exists public.clearinghouse_response_events add column if not exists client_id uuid;
-- claim_status_inquiries is empty on prod; safe to enforce NOT NULL per the migration intent.
alter table if exists public.claim_status_inquiries alter column client_id set not null;
`;

// Patch: live era_claim_payments has `professional_claim_id`, not the migration's
// `claim_id`. Gate the index so it only runs on schemas that match the migration.
function patch_20260505030000(sql) {
  return sql.replace(
    /create index if not exists idx_era_claim_payments_org_claim_trace[\s\S]*?where archived_at is null;/,
    () => `do $$ begin
       if exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='era_claim_payments'
                    and column_name='claim_id') then
         execute 'create index if not exists idx_era_claim_payments_org_claim_trace '
              || 'on public.era_claim_payments (organization_id, claim_id, trace_number, created_at desc) '
              || 'where archived_at is null';
       end if;
     end $$;`
  );
}

const units = [
  { name: '20260505010000_enforce_client_schema_drift (surgical)', sql: surgical_20260505010000 },
  { name: '20260505020000_office_ally_json_first_extensions.sql', file: '20260505020000_office_ally_json_first_extensions.sql' },
  { name: '20260505030000_office_ally_response_schemas.sql (patched)', file: '20260505030000_office_ally_response_schemas.sql', patch: patch_20260505030000 },
  { name: '20260507020000_scheduling_operations_upgrade.sql',     file: '20260507020000_scheduling_operations_upgrade.sql' },
  { name: '20260509020000_office_ally_837p_foundation.sql',       file: '20260509020000_office_ally_837p_foundation.sql' },
];

for (const u of units) {
  let sql = u.sql ?? fs.readFileSync(path.join(DIR, u.file), 'utf8');
  if (u.patch) sql = u.patch(sql);
  process.stdout.write(`Replaying ${u.name} … `);
  try {
    await exec(`begin;\n${sql}\ncommit;`);
    console.log('OK');
  } catch (e) {
    console.log('FAIL');
    console.error(String(e).split('\n').slice(0, 6).join('\n'));
    try { await exec('rollback;'); } catch {}
    process.exit(1);
  }
}

console.log('Reloading PostgREST schema cache…');
await exec(`notify pgrst, 'reload schema';`);
console.log('Done.');
