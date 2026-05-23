/**
 * Task #244: race-safe upsert for the primary insurance policy an intake
 * submission creates.
 *
 * The intake POST used to do a plain read-then-insert on insurance_policies
 * keyed on (client_id, priority='primary'). Two near-simultaneous intake
 * submits could both miss the SELECT and both INSERT, producing two
 * "primary" policies that then confused eligibility and claim submission.
 *
 * The partial unique index
 *   insurance_policies (client_id, priority) WHERE archived_at IS NULL
 * (added in 20260602000000_insurance_policies_intake_dedupe_unique.sql)
 * closes the race at the DB. This helper:
 *   - SELECTs the existing live policy and UPDATEs it if found,
 *   - otherwise INSERTs,
 *   - catches the 23505 unique_violation that the partial index raises
 *     when a parallel caller inserted between our SELECT and INSERT,
 *     re-selects the winning row and UPDATEs it instead.
 *
 * Both concurrent callers therefore converge on the same policy id with
 * the latest field values, never on two separate rows.
 */

export const UNIQUE_VIOLATION = "23505";

type DbError = { message: string; code?: string };
type MaybeSingleResult<T> = PromiseLike<{ data: T | null; error: DbError | null }>;
type MutationResult = PromiseLike<{ error: DbError | null }>;

type PolicyRow = { id: string };

export type IntakePolicyFields = {
  organization_id: string;
  client_id: string;
  priority: "primary";
  plan_name: string;
  policy_number: string;
  group_number: string | null;
  subscriber_relationship: string;
  active_flag: boolean;
};

export type IntakePoliciesSupabase = {
  from(table: "insurance_policies"): {
    select(columns: string): {
      eq(field: string, value: string): {
        eq(field: string, value: string): {
          maybeSingle<T = PolicyRow>(): MaybeSingleResult<T>;
        };
      };
    };
    insert(row: Record<string, unknown>): MutationResult;
    update(row: Record<string, unknown>): {
      eq(field: string, value: string): MutationResult;
    };
  };
};

export type UpsertPolicyResult =
  | { ok: true; policyId: string; created: boolean }
  | { ok: false; error: string; code?: string };

export async function upsertPolicyFromIntake(
  supabase: IntakePoliciesSupabase,
  policy: IntakePolicyFields,
): Promise<UpsertPolicyResult> {
  const selectExisting = () =>
    supabase
      .from("insurance_policies")
      .select("id")
      .eq("client_id", policy.client_id)
      .eq("priority", policy.priority)
      .maybeSingle<PolicyRow>();

  const { data: existing, error: selectErr } = await selectExisting();
  if (selectErr) {
    return { ok: false, error: `Failed to look up insurance policy: ${selectErr.message}`, code: selectErr.code };
  }
  if (existing?.id) {
    const { error: updateErr } = await supabase
      .from("insurance_policies")
      .update(policy)
      .eq("id", String(existing.id));
    if (updateErr) {
      return { ok: false, error: `Failed to update insurance policy: ${updateErr.message}`, code: updateErr.code };
    }
    return { ok: true, policyId: String(existing.id), created: false };
  }

  const { error: insertErr } = await supabase.from("insurance_policies").insert(policy);
  if (!insertErr) {
    // Re-select to recover the id of the row we just inserted (the
    // builder shape supabase-js exposes here doesn't surface a
    // returning clause, and the id isn't part of the input).
    const { data: justInserted } = await selectExisting();
    return { ok: true, policyId: justInserted?.id ? String(justInserted.id) : "", created: true };
  }

  // Race: a parallel intake submit inserted between our SELECT and our
  // INSERT, and the partial unique index raised 23505. Re-select and
  // UPDATE the winning row so the loser still applies its latest field
  // values instead of leaving the row stale.
  if (insertErr.code === UNIQUE_VIOLATION) {
    const { data: raceRow, error: raceErr } = await selectExisting();
    if (raceErr) {
      return { ok: false, error: `Failed to re-look up insurance policy after race: ${raceErr.message}`, code: raceErr.code };
    }
    if (raceRow?.id) {
      const { error: updateErr } = await supabase
        .from("insurance_policies")
        .update(policy)
        .eq("id", String(raceRow.id));
      if (updateErr) {
        return { ok: false, error: `Failed to update insurance policy after race: ${updateErr.message}`, code: updateErr.code };
      }
      return { ok: true, policyId: String(raceRow.id), created: false };
    }
  }

  return { ok: false, error: `Failed to create insurance policy: ${insertErr.message}`, code: insertErr.code };
}
