/**
 * Generic find-or-create retry helper.
 *
 * Task #148 fixed read-then-insert races on encounters / clinical notes
 * with a partial unique index + a domain-specific helper. Task #184 sweeps
 * the same pattern across the rest of the EHR: claim creation, payment
 * posting, ERA batch ingest, ledger entries, client invoice creation.
 *
 * Every site looked the same: SELECT existing → if missing INSERT. Two
 * near-simultaneous callers (double-click, retry after slow network,
 * second tab, parallel cron + UI write) can both miss the SELECT and
 * both INSERT, producing duplicate rows.
 *
 * The shape that closes the race is:
 *
 *   1. partial unique index at the DB (WHERE archived_at IS NULL) so
 *      legitimate re-creation after archive is still possible.
 *   2. application code catches the 23505 unique_violation and re-selects
 *      the winning row, so concurrent callers deterministically converge
 *      on the same id.
 *
 * `findOrCreateRow` is the application half of that pair. The DB half
 * lives in supabase/migrations/20260601000000_find_or_create_dedupe_indexes.sql.
 */

// Postgres unique_violation. Same constant used by lib/encounters/findOrCreate.ts.
export const UNIQUE_VIOLATION = "23505";

type DbError = { message: string; code?: string };

export type FindOrCreateResult<T> =
  | { ok: true; row: T; created: boolean }
  | { ok: false; error: string; code?: string };

/**
 * Run a find-or-create with 23505 retry. The DB is the source of truth
 * for uniqueness; this helper is only responsible for:
 *   - returning the existing row if the first SELECT finds it,
 *   - returning the newly-inserted row otherwise,
 *   - catching a 23505 from the INSERT and re-running the SELECT so the
 *     losing concurrent caller still returns the winning row.
 *
 * Callers pass two thunks (so this helper stays decoupled from the
 * supabase-js builder shape) plus a human label used in error messages.
 */
export async function findOrCreateRow<T>(opts: {
  // Accept any thenable so callers can pass supabase-js query builders
  // directly (they are PromiseLike, not full Promises) without an extra wrap.
  findExisting: () => PromiseLike<{ data: T | null; error: DbError | null }>;
  insertNew: () => PromiseLike<{ data: T | null; error: DbError | null }>;
  label: string;
}): Promise<FindOrCreateResult<T>> {
  const first = await opts.findExisting();
  if (first.error) {
    return { ok: false, error: `Failed to look up ${opts.label}: ${first.error.message}`, code: first.error.code };
  }
  if (first.data) {
    return { ok: true, row: first.data, created: false };
  }

  const inserted = await opts.insertNew();
  if (!inserted.error && inserted.data) {
    return { ok: true, row: inserted.data, created: true };
  }

  // Race: a parallel caller inserted between our SELECT and INSERT, and
  // the partial unique index raised 23505. Re-select to return the winner.
  if (inserted.error?.code === UNIQUE_VIOLATION) {
    const second = await opts.findExisting();
    if (second.data) {
      return { ok: true, row: second.data, created: false };
    }
    // Unique violation but nothing visible to us — surface the original
    // error rather than pretending it succeeded.
  }

  return {
    ok: false,
    error: `Failed to create ${opts.label}: ${inserted.error?.message ?? "unknown error"}`,
    code: inserted.error?.code,
  };
}
