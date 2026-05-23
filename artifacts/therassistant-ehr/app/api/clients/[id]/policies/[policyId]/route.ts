import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";
import { writeChartObjectAuditLogs } from "@/lib/audit/chartObjectAudit";

const POLICY_COLUMN_LABELS: Record<string, string> = {
  group_number: "Group number",
  plan_name: "Plan name",
  policy_number: "Policy number",
  subscriber_id: "Subscriber ID",
  payer_id: "Payer",
  effective_date: "Effective date",
  termination_date: "Termination date",
  copay_amount: "Copay",
  archived_at: "Archived",
};

type PatchBody = {
  organizationId?: string;
  groupNumber?: string | null;
  policyNumber?: string | null;
  planName?: string | null;
  payerId?: string | null;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  copayAmount?: string | number | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normDate(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  const s = String(value).trim();
  if (!s) return { ok: true, value: null };
  if (!DATE_RE.test(s)) return { ok: false, error: "Dates must be in YYYY-MM-DD format" };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid date" };
  return { ok: true, value: s };
}

function normCopay(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  const s = String(value).trim();
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: "Copay must be a number" };
  if (n < 0) return { ok: false, error: "Copay cannot be negative" };
  if (n > 100000) return { ok: false, error: "Copay is unreasonably large" };
  return { ok: true, value: n.toFixed(2) };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; policyId: string }> },
) {
  try {
    const ctx = await requireAuthenticatedStaff();
    if (!ctx) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401 },
      );
    }

    const { id: clientId, policyId } = await context.params;
    const body = (await request.json()) as PatchBody;

    const organizationId = ctx.organizationId;
    if (body.organizationId && body.organizationId !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Organization mismatch" },
        { status: 403 },
      );
    }

    // Build the update payload from whichever editable fields the caller
    // actually included. Editable surface for in-chart corrections:
    //   group_number, policy_number, plan_name, payer_id,
    //   effective_date, termination_date, copay_amount.
    const update: Record<string, string | number | null> = {};

    if ("groupNumber" in body) {
      const v = normString(body.groupNumber);
      if (v && v.length > 80) {
        return NextResponse.json(
          { success: false, error: "Group number must be 80 characters or fewer" },
          { status: 400 },
        );
      }
      update.group_number = v;
    }

    if ("policyNumber" in body) {
      const v = normString(body.policyNumber);
      if (!v) {
        return NextResponse.json(
          { success: false, error: "Policy number is required" },
          { status: 400 },
        );
      }
      if (v.length > 80) {
        return NextResponse.json(
          { success: false, error: "Policy number must be 80 characters or fewer" },
          { status: 400 },
        );
      }
      update.policy_number = v;
    }

    if ("planName" in body) {
      const v = normString(body.planName);
      if (v && v.length > 200) {
        return NextResponse.json(
          { success: false, error: "Plan name must be 200 characters or fewer" },
          { status: 400 },
        );
      }
      update.plan_name = v;
    }

    if ("payerId" in body) {
      const v = normString(body.payerId);
      if (!v) {
        return NextResponse.json(
          { success: false, error: "Payer is required" },
          { status: 400 },
        );
      }
      update.payer_id = v;
    }

    let effectiveForCompare: string | null | undefined;
    let terminationForCompare: string | null | undefined;

    if ("effectiveDate" in body) {
      const r = normDate(body.effectiveDate);
      if (!r.ok) {
        return NextResponse.json({ success: false, error: r.error }, { status: 400 });
      }
      update.effective_date = r.value;
      effectiveForCompare = r.value;
    }

    if ("terminationDate" in body) {
      const r = normDate(body.terminationDate);
      if (!r.ok) {
        return NextResponse.json({ success: false, error: r.error }, { status: 400 });
      }
      update.termination_date = r.value;
      terminationForCompare = r.value;
    }

    if ("copayAmount" in body) {
      const r = normCopay(body.copayAmount);
      if (!r.ok) {
        return NextResponse.json({ success: false, error: r.error }, { status: 400 });
      }
      update.copay_amount = r.value;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { success: false, error: "No editable fields supplied" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // Select all columns we might mutate so we can both validate cross-field
    // rules (effective <= termination) and build a clean before/after diff
    // for the audit log.
    const { data: existing, error: fetchError } = await supabase
      .from("insurance_policies")
      .select(
        "id, organization_id, client_id, archived_at, group_number, policy_number, plan_name, payer_id, effective_date, termination_date, copay_amount",
      )
      .eq("id", policyId)
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json(
        { success: false, error: fetchError.message },
        { status: 500 },
      );
    }

    if (!existing || existing.archived_at) {
      return NextResponse.json(
        { success: false, error: "Policy not found" },
        { status: 404 },
      );
    }

    // Effective must be on or before termination. Compare against the
    // not-yet-updated existing row for whichever side the caller did not
    // touch in this request.
    const nextEffective =
      effectiveForCompare === undefined
        ? (existing.effective_date as string | null)
        : effectiveForCompare;
    const nextTermination =
      terminationForCompare === undefined
        ? (existing.termination_date as string | null)
        : terminationForCompare;
    if (nextEffective && nextTermination && nextEffective > nextTermination) {
      return NextResponse.json(
        { success: false, error: "Effective date must be on or before termination date" },
        { status: 400 },
      );
    }

    // Payer must belong to the same organization. Validate after the
    // policy lookup so we don't leak payer existence to other orgs.
    if (typeof update.payer_id === "string") {
      const { data: payer, error: payerError } = await supabase
        .from("insurance_payers")
        .select("id, organization_id, archived_at")
        .eq("id", update.payer_id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (payerError) {
        return NextResponse.json(
          { success: false, error: payerError.message },
          { status: 500 },
        );
      }
      if (!payer || payer.archived_at) {
        return NextResponse.json(
          { success: false, error: "Payer not found for this organization" },
          { status: 400 },
        );
      }
    }

    // Build before/after only for the columns the caller actually changed
    // (skip no-op writes where the new value equals the stored one). Write
    // audit FIRST so a failure refuses the mutation, matching the
    // demographics pattern (HIPAA — no silent un-audited PHI edits).
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const existingRow = existing as Record<string, unknown>;
    for (const column of Object.keys(update)) {
      const priorValue = existingRow[column] ?? null;
      const nextValue = update[column] ?? null;
      if (priorValue !== nextValue) {
        before[column] = priorValue;
        after[column] = nextValue;
      }
    }

    if (Object.keys(after).length > 0) {
      await writeChartObjectAuditLogs({
        supabase,
        organizationId,
        patientId: clientId,
        staff: ctx,
        objectType: "insurance_policy",
        objectId: policyId,
        action: "insurance_policy_updated",
        objectLabel: "Insurance policy",
        before,
        after,
        columnLabels: POLICY_COLUMN_LABELS,
      });
    }

    const { error: updateError } = await supabase
      .from("insurance_policies")
      .update(update)
      .eq("id", policyId)
      .eq("organization_id", organizationId)
      .eq("client_id", clientId);

    if (updateError) {
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      groupNumber: "group_number" in update ? update.group_number : undefined,
      updated: Object.keys(update),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update policy",
      },
      { status: 500 },
    );
  }
}
