/**
 * Schema-aware guard for in-memory supabase fakes (shared across test suites).
 *
 * Originally lived at `lib/payments/postingEngine/__tests__/_schemaGuard.ts`
 * (Task #179). Task #140 surfaced a class of bug where a workqueue insert
 * used the wrong column name (`patient_id`, `queue_type`) or an enum value
 * that does not exist in `public.source_object_type` (e.g. `payment_refund`).
 * The fakes accepted those writes silently, so the bug only manifested in
 * production. Promoting the guard to a shared location lets every module's
 * hand-rolled fake supabase client (claims, eligibility, mailroom, EHR
 * billing, payments-import, ...) catch the same regression class at test
 * time instead of in prod.
 *
 * This guard parses the generated `lib/supabase/database.types.ts` once at
 * load time to extract the column allowlist for each table's `Insert:` block,
 * and pulls runtime enum values from the file's exported `Constants` object.
 * Tests that wire `validateWritePayload` into their fake's insert/update path
 * will fail loudly when a payload uses an unknown column or an invalid enum
 * value.
 *
 * Tables outside the allowlist (e.g. helper-only test tables that don't exist
 * in the real schema) are passed through untouched so existing assertions
 * keep working.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Constants } from "../database.types";

const TYPES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../database.types.ts",
);

/** Runtime enum -> allowed string values, sourced from the generated types file. */
const ENUM_VALUES: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(Constants.public.Enums).map(
    ([name, vals]) => [name, new Set(vals as readonly string[])],
  ),
);

/**
 * Manually-maintained enum-value overlay for enums whose generated
 * `Constants` entry is stale relative to later migrations or whose
 * accepted values have been extended in production code ahead of a
 * matching migration. Keep entries here in sync with new ALTER TYPE
 * migrations until the types file is regenerated.
 */
const EXTRA_ENUM_VALUES: Record<string, string[]> = {
  encounter_status: ["draft", "in_review", "signed", "corrected"],
};
for (const [name, extras] of Object.entries(EXTRA_ENUM_VALUES)) {
  if (!ENUM_VALUES[name]) ENUM_VALUES[name] = new Set<string>();
  for (const v of extras) ENUM_VALUES[name].add(v);
}

/**
 * Manually-maintained column overlay for tables whose `database.types.ts`
 * entry is stale relative to later migrations, or for tables missing from
 * the generated types entirely.
 *
 * `database.types.ts` was regenerated to cover all payment-posting
 * migrations through `20260524000000_payment_posting_reversal_refunds.sql`
 * (plus the bulk-action / stripe-connect follow-ups), so payment-engine
 * tables (era_claim_payments, client_payments, insurance_manual_payments,
 * era_posting_ledger_entries, payment_refunds, payment_recoupments,
 * client_credits, client_credit_applications, payment_transfers) no
 * longer need an overlay. The remaining entries cover columns from
 * non-payment migrations that the types file still doesn't reflect.
 */
const EXTRA_COLUMNS: Record<string, string[]> = {
  insurance_policies: [
    "group_number",
    "subscriber_relationship",
  ],
  professional_claims: [
    "case_id",
    "client_id",
    "legacy_claim_id",
  ],
};

const ENUM_COLUMNS: Record<string, Record<string, string>> = {
  workqueue_items: {
    source_object_type: "source_object_type",
    status: "workqueue_status",
    priority: "workqueue_priority",
  },
  appointments: { appointment_status: "appointment_status" },
  encounters: { encounter_status: "encounter_status" },
  era_claim_payments: { posting_status: "payment_posting_status" },
  insurance_manual_payments: { posting_status: "payment_posting_status" },
  client_payments: { posting_status: "payment_posting_status" },
};

let tableColumnsCache: Record<string, Set<string>> | null = null;

/**
 * Parse `database.types.ts` and extract the `Insert:` column lists per
 * table. The generated file uses very regular indentation: tables sit at
 * 6 spaces (`      tablename: {`), each `Insert: {` block sits at 8 spaces,
 * and columns inside it sit at 10 spaces. We rely on that shape rather
 * than running a real TS parser.
 */
function loadTableColumns(): Record<string, Set<string>> {
  if (tableColumnsCache) return tableColumnsCache;
  const src = readFileSync(TYPES_PATH, "utf-8");
  const lines = src.split("\n");
  const out: Record<string, Set<string>> = {};
  let currentTable: string | null = null;
  let inInsert = false;
  let cols: Set<string> | null = null;
  for (const line of lines) {
    const tableMatch = line.match(/^ {6}([a-z_][a-z0-9_]*): \{$/);
    if (tableMatch) {
      currentTable = tableMatch[1];
      inInsert = false;
      cols = null;
      continue;
    }
    if (!currentTable) continue;
    if (!inInsert) {
      if (line === "        Insert: {") {
        inInsert = true;
        cols = new Set<string>();
      }
      continue;
    }
    if (line === "        }") {
      if (cols && cols.size > 0) out[currentTable] = cols;
      inInsert = false;
      cols = null;
      continue;
    }
    const colMatch = line.match(/^ {10}([a-z_][a-z0-9_]*)\??:/);
    if (colMatch && cols) cols.add(colMatch[1]);
  }
  // Merge the manual overlay for stale/missing tables.
  for (const [table, extras] of Object.entries(EXTRA_COLUMNS)) {
    if (!out[table]) out[table] = new Set<string>();
    for (const c of extras) out[table].add(c);
  }
  tableColumnsCache = out;
  return out;
}

export class SchemaGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaGuardError";
  }
}

/**
 * Validate a single insert/update payload against the parsed schema.
 *
 * - Unknown columns throw `SchemaGuardError`.
 * - Enum-typed columns with a value outside the allowed set throw.
 * - Tables that are not in `Database["public"]["Tables"]` (e.g. ad-hoc
 *   tables the fake seeds for convenience) are passed through.
 */
export function validateWritePayload(
  table: string,
  payload: Record<string, unknown>,
): void {
  const schema = loadTableColumns();
  const cols = schema[table];
  if (!cols) return; // table not in schema — don't block
  for (const key of Object.keys(payload)) {
    if (!cols.has(key)) {
      throw new SchemaGuardError(
        `[schemaGuard] insert/update on '${table}' uses unknown column '${key}'. ` +
          `Known columns: ${[...cols].sort().join(", ")}`,
      );
    }
  }
  const enumCols = ENUM_COLUMNS[table];
  if (!enumCols) return;
  for (const [col, enumName] of Object.entries(enumCols)) {
    if (!(col in payload)) continue;
    const v = payload[col];
    if (v === undefined || v === null) continue;
    const allowed = ENUM_VALUES[enumName];
    if (!allowed) continue;
    if (!allowed.has(String(v))) {
      throw new SchemaGuardError(
        `[schemaGuard] invalid enum value '${String(v)}' for ${table}.${col} ` +
          `(enum ${enumName}). Allowed: ${[...allowed].sort().join(", ")}`,
      );
    }
  }
}

/**
 * Validate a possibly-batched insert payload.
 */
export function validateInsert(
  table: string,
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
): void {
  const list = Array.isArray(payload) ? payload : [payload];
  for (const row of list) validateWritePayload(table, row);
}

/** Test-only: clear the parse cache (used by the self-test). */
export function _resetSchemaCacheForTests(): void {
  tableColumnsCache = null;
}
