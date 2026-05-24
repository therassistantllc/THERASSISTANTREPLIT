#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = 'artifacts/therassistant-ehr/supabase/migrations';
const REF = process.env.SUPABASE_PROJECT_REF?.trim();
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN?.trim();
if (!REF || !TOKEN) {
  console.error('Need SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN');
  process.exit(1);
}

async function query(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Parse a SQL file, returning an array of:
//   { kind: 'create_table'|'alter_add_column', schema, table, column? }
function parseFile(sqlRaw) {
  // Strip line comments and block comments
  const sql = sqlRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');

  const items = [];

  // create table [if not exists] [schema.]name
  const ctRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(public|app|"public"|"app")\.)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*\(/gi;
  let m;
  while ((m = ctRe.exec(sql)) !== null) {
    const schemaRaw = (m[1] || 'public').replace(/"/g, '');
    const table = m[2].replace(/"/g, '');
    items.push({ kind: 'create_table', schema: schemaRaw, table });
  }

  // alter table [if exists] [only] [schema.]name ... add column [if not exists] col
  const atRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:(public|app|"public"|"app")\.)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)([^;]*);/gi;
  while ((m = atRe.exec(sql)) !== null) {
    const schema = (m[1] || 'public').replace(/"/g, '');
    const table = m[2].replace(/"/g, '');
    const body = m[3];
    const addColRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/gi;
    let cm;
    while ((cm = addColRe.exec(body)) !== null) {
      const col = cm[1].replace(/"/g, '');
      items.push({ kind: 'alter_add_column', schema, table, column: col });
    }
  }

  return items;
}

// Columns renamed by later migrations — present on live under a new name.
// Format: 'schema.table.original' -> 'schema.table.renamed'
const RENAMED = {
  'public.payer_profiles.office_ally_payer_id': 'public.payer_profiles.availity_payer_id',
  'public.claim_status_events.office_ally_claim_id': 'public.claim_status_events.availity_claim_id',
  'public.claim_status_events.office_ally_file_id': 'public.claim_status_events.availity_file_id',
  'public.edi_batches.office_ally_file_id': 'public.edi_batches.availity_file_id',
};

const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
const parsed = files.map(f => ({
  file: f,
  items: parseFile(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')),
}));

// Get the applied set (informational only).
console.error('Fetching applied migrations…');
const applied = await query(`select version from supabase_migrations.schema_migrations order by version`);
const appliedSet = new Set(applied.map(r => r.version));
console.error(`Applied: ${appliedSet.size} migrations registered.`);

// Collect every distinct relation referenced.
const tableSet = new Set();
const columnSet = new Set();
for (const p of parsed) {
  for (const it of p.items) {
    if (it.kind === 'create_table') tableSet.add(`${it.schema}.${it.table}`);
    if (it.kind === 'alter_add_column') columnSet.add(`${it.schema}.${it.table}.${it.column}`);
  }
}

console.error(`Distinct tables to verify: ${tableSet.size}`);
console.error(`Distinct columns to verify: ${columnSet.size}`);

// Query existence in one shot.
const tableList = [...tableSet].map(qn => {
  const [s, t] = qn.split('.');
  return `('${s}','${t}')`;
}).join(',');
const colList = [...columnSet].map(qn => {
  const [s, t, c] = qn.split('.');
  return `('${s}','${t}','${c}')`;
}).join(',');

const tablesPresent = tableSet.size
  ? new Set((await query(`
      select table_schema || '.' || table_name as qn
      from information_schema.tables
      where (table_schema, table_name) in (${tableList})
    `)).map(r => r.qn))
  : new Set();

// Include rename targets in the lookup so we can detect "present under new name".
const allColList = [...new Set([...columnSet, ...Object.values(RENAMED)])].map(qn => {
  const [s, t, c] = qn.split('.');
  return `('${s}','${t}','${c}')`;
}).join(',');
const colsPresent = allColList
  ? new Set((await query(`
      select table_schema || '.' || table_name || '.' || column_name as qn
      from information_schema.columns
      where (table_schema, table_name, column_name) in (${allColList})
    `)).map(r => r.qn))
  : new Set();

// Build report
const report = [];
report.push(`# Migration drift audit — ${new Date().toISOString()}`);
report.push(`Project: ${REF}`);
report.push(`Migrations scanned: ${files.length}`);
report.push(`Applied (per schema_migrations): ${appliedSet.size}`);
report.push(`Tables referenced: ${tableSet.size}, missing: ${[...tableSet].filter(t => !tablesPresent.has(t)).length}`);
report.push(`Columns referenced via ALTER ADD: ${columnSet.size}, missing: ${[...columnSet].filter(c => {
  if (colsPresent.has(c)) return false;
  const renamed = RENAMED[c];
  return !(renamed && colsPresent.has(renamed));
}).length}`);
report.push('');

const drifted = [];
for (const p of parsed) {
  const version = p.file.split('_')[0];
  const isApplied = appliedSet.has(version);
  const missingTables = [];
  const missingCols = [];
  for (const it of p.items) {
    if (it.kind === 'create_table' && !tablesPresent.has(`${it.schema}.${it.table}`)) {
      missingTables.push(`${it.schema}.${it.table}`);
    }
    if (it.kind === 'alter_add_column') {
      const tQn = `${it.schema}.${it.table}`;
      const cQn = `${tQn}.${it.column}`;
      if (!tablesPresent.has(tQn)) {
        // table itself missing — surfaced in create-table report; skip
      } else if (!colsPresent.has(cQn)) {
        const renamedTo = RENAMED[cQn];
        if (renamedTo && colsPresent.has(renamedTo)) {
          // present under a renamed column — not drift
        } else {
          missingCols.push(cQn);
        }
      }
    }
  }
  if (missingTables.length || missingCols.length) {
    drifted.push({ file: p.file, isApplied, missingTables, missingCols });
  }
}

report.push('## Drifted migrations');
if (!drifted.length) report.push('_None_');
for (const d of drifted) {
  report.push(`### ${d.file} ${d.isApplied ? '(marked applied)' : '(NOT applied)'}`);
  if (d.missingTables.length) report.push(`- Missing tables: ${d.missingTables.join(', ')}`);
  if (d.missingCols.length) report.push(`- Missing columns: ${d.missingCols.join(', ')}`);
}

const out = report.join('\n');
fs.writeFileSync('.local/audit/report.md', out + '\n');
console.log(out);
