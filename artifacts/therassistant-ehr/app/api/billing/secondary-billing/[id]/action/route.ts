/**
 * POST /api/billing/secondary-billing/:id/action
 *
 * `:id` is the professional_claims.id. Every action writes both:
 *   - the authoritative claim-level columns on professional_claims
 *     (secondary_billing_*), so other queues / the timeline see the
 *     same truth the UI shows, and
 *   - a companion audit_logs row under `sec_billing_<action>` for
 *     event history.
 *
 * Body shape:
 *   {
 *     action:
 *       | "generate"
 *       | "attach_eob"
 *       | "hold"
 *       | "update_insurance"  // ordered_policy_ids[] reorders
 *                              //   insurance_policies.priority
 *       | "submit"
 *       | "reopen"
 *       | "assign"             // assignedBillerUserId
 *       | "set_follow_up"      // followUpDue (YYYY-MM-DD)
 *       | "mark_error",        // error
 *     organizationId: string,
 *     ordered_policy_ids?: string[],
 *     eob_reference?: string,
 *     assignedBillerUserId?: string | null,
 *     followUpDue?: string | null,
 *     error?: string,
 *     note?: string,
 *   }
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { buildSecondary837PBatch } from "@/lib/claims/buildSecondary837PBatch";
import { submitClaim837PBatch } from "@/lib/claims/submit837PBatch";

async function recordSecBillingError(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    claimId: string;
    patientId: string | null;
    appointmentId: string | null;
    userId: string | null | undefined;
    failedAction: "generate" | "submit";
    error: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  if (!supabase) return;
  const nowIso = new Date().toISOString();
  await (supabase as any)
    .from("professional_claims")
    .update({
      secondary_billing_state: "error",
      secondary_billing_last_error: args.error.slice(0, 1000),
      updated_at: nowIso,
    })
    .eq("id", args.claimId)
    .eq("organization_id", args.organizationId);
  await (supabase as any).from("audit_logs").insert({
    organization_id: args.organizationId,
    claim_id: args.claimId,
    patient_id: args.patientId,
    appointment_id: args.appointmentId,
    event_type: "sec_billing_error",
    event_summary: `Secondary billing ${args.failedAction} failed`,
    event_metadata: { failed_action: args.failedAction, error: args.error, ...(args.extra ?? {}) },
    user_id: args.userId ?? null,
    action: "sec_billing_error",
    object_type: "claim",
    object_id: args.claimId,
  });
}

const ALLOWED = [
  "generate",
  "attach_eob",
  "hold",
  "update_insurance",
  "submit",
  "reopen",
  "assign",
  "set_follow_up",
  "mark_error",
] as const;
type Action = (typeof ALLOWED)[number];

const SUMMARIES: Record<Action, string> = {
  generate: "Secondary claim generated",
  attach_eob: "Primary EOB attached for secondary billing",
  hold: "Secondary claim placed on hold",
  update_insurance: "Insurance order updated for secondary billing",
  submit: "Secondary claim submitted",
  reopen: "Secondary billing reopened",
  assign: "Secondary billing assignment updated",
  set_follow_up: "Secondary billing follow-up date updated",
  mark_error: "Secondary billing error recorded",
};

const PRIORITY_FOR_INDEX = ["primary", "secondary", "tertiary"] as const;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing claim id" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      organizationId?: string;
      ordered_policy_ids?: string[];
      eob_reference?: string;
      assignedBillerUserId?: string | null;
      followUpDue?: string | null;
      error?: string;
      note?: string;
    };

    const action = body.action as Action | undefined;
    if (!action || !ALLOWED.includes(action)) {
      return NextResponse.json(
        { success: false, error: `Unknown action: ${body.action ?? ""}` },
        { status: 400 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { data: claim, error: claimErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, organization_id, patient_id, appointment_id, claim_status, secondary_billing_state",
      )
      .eq("id", id)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim || claim.organization_id !== organizationId) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const metadata: Record<string, unknown> = {};
    if (body.note) metadata.note = String(body.note).slice(0, 2000);
    if (action === "update_insurance" && Array.isArray(body.ordered_policy_ids)) {
      metadata.ordered_policy_ids = body.ordered_policy_ids
        .map((x) => String(x))
        .filter(Boolean);
    }
    if (action === "attach_eob" && body.eob_reference) {
      metadata.eob_reference = String(body.eob_reference).slice(0, 500);
    }
    if (action === "assign") metadata.assigned_to = body.assignedBillerUserId ?? null;
    if (action === "set_follow_up") metadata.follow_up_due = body.followUpDue ?? null;
    if (action === "mark_error" && body.error) metadata.error = String(body.error).slice(0, 1000);

    // ── 1. Apply authoritative claim-level mutations ──────────────────
    const nowIso = new Date().toISOString();
    const claimUpdate: Record<string, unknown> = { updated_at: nowIso };

    // For generate/submit we drive the real 837P pipeline BEFORE applying
    // the optimistic state column update. Any failure flips the claim to
    // `error` + writes a `sec_billing_error` audit and short-circuits.
    if (action === "generate") {
      const result = await buildSecondary837PBatch({ claimId: id, organizationId });
      if (!result.ok) {
        await recordSecBillingError(supabase, {
          organizationId,
          claimId: id,
          patientId: claim.patient_id ?? null,
          appointmentId: claim.appointment_id ?? null,
          userId: guard.userId,
          failedAction: "generate",
          error: result.error ?? "Unknown generation error",
        });
        return NextResponse.json(
          { success: false, error: result.error ?? "Failed to generate secondary 837P" },
          { status: 422 },
        );
      }
      metadata.batch_id = result.batchId;
      metadata.batch_number = result.batchNumber;
      metadata.file_name = result.fileName;
    } else if (action === "submit") {
      // Find the most recent active secondary batch for this claim.
      const { data: linkRow, error: linkErr } = await (supabase as any)
        .from("claim_837p_batch_claims")
        .select("batch_id, created_at")
        .eq("organization_id", organizationId)
        .eq("professional_claim_id", id)
        .eq("submission_kind", "secondary")
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (linkErr || !linkRow) {
        const msg =
          linkErr?.message ??
          "No generated secondary 837P batch found for this claim. Generate the claim before submitting.";
        await recordSecBillingError(supabase, {
          organizationId,
          claimId: id,
          patientId: claim.patient_id ?? null,
          appointmentId: claim.appointment_id ?? null,
          userId: guard.userId,
          failedAction: "submit",
          error: msg,
        });
        return NextResponse.json({ success: false, error: msg }, { status: 422 });
      }
      const submitResult = await submitClaim837PBatch({
        batchId: String((linkRow as Record<string, unknown>).batch_id),
        organizationId,
      });
      if (!submitResult.ok) {
        await recordSecBillingError(supabase, {
          organizationId,
          claimId: id,
          patientId: claim.patient_id ?? null,
          appointmentId: claim.appointment_id ?? null,
          userId: guard.userId,
          failedAction: "submit",
          error: submitResult.error ?? "Availity submission failed",
          extra: {
            batch_id: submitResult.batchId,
            attempt: submitResult.attempt,
            http_status: submitResult.httpStatus,
          },
        });
        return NextResponse.json(
          { success: false, error: submitResult.error ?? "Submission failed" },
          { status: submitResult.status || 502 },
        );
      }
      metadata.batch_id = submitResult.batchId;
      metadata.availity_transaction_id = submitResult.externalTransactionId;
      metadata.attempt = submitResult.attempt;
    }

    switch (action) {
      case "generate":
        claimUpdate.secondary_billing_state = "generated";
        claimUpdate.secondary_billing_generated_at = nowIso;
        claimUpdate.secondary_billing_last_error = null;
        break;
      case "submit":
        claimUpdate.secondary_billing_state = "submitted";
        claimUpdate.secondary_billing_submitted_at = nowIso;
        claimUpdate.secondary_billing_last_error = null;
        break;
      case "attach_eob":
        claimUpdate.secondary_billing_eob_attached_at = nowIso;
        if (body.eob_reference) {
          claimUpdate.secondary_billing_eob_reference = String(body.eob_reference).slice(0, 500);
        }
        // If we were blocked on EOB, flip back to ready.
        if (claim.secondary_billing_state === "missing_eob" || !claim.secondary_billing_state) {
          claimUpdate.secondary_billing_state = "ready";
        }
        break;
      case "hold":
        claimUpdate.secondary_billing_state = "hold";
        break;
      case "reopen":
        claimUpdate.secondary_billing_state = "ready";
        claimUpdate.secondary_billing_last_error = null;
        break;
      case "assign":
        claimUpdate.secondary_billing_assigned_to_user_id =
          body.assignedBillerUserId ?? null;
        break;
      case "set_follow_up":
        claimUpdate.secondary_billing_follow_up_due = body.followUpDue ?? null;
        break;
      case "mark_error":
        claimUpdate.secondary_billing_state = "error";
        claimUpdate.secondary_billing_last_error =
          (body.error && String(body.error).slice(0, 1000)) || "Secondary billing error";
        break;
      case "update_insurance":
        // No direct column to set — the mutation below reorders the
        // client's insurance_policies. State stays where it was, but
        // we still write the audit row + bump updated_at.
        break;
    }

    const { error: updErr } = await (supabase as any)
      .from("professional_claims")
      .update(claimUpdate)
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (updErr) throw updErr;

    // For update_insurance, persistently reorder the client's policies.
    if (action === "update_insurance" && Array.isArray(body.ordered_policy_ids) && claim.patient_id) {
      const ids = body.ordered_policy_ids.map((x) => String(x)).filter(Boolean);
      const policyUpdates = ids.slice(0, PRIORITY_FOR_INDEX.length).map((policyId, idx) => ({
        policyId,
        priority: PRIORITY_FOR_INDEX[idx],
      }));
      for (const { policyId, priority } of policyUpdates) {
        const { error: pErr } = await (supabase as any)
          .from("insurance_policies")
          .update({ priority, updated_at: nowIso })
          .eq("id", policyId)
          .eq("organization_id", organizationId)
          .eq("client_id", claim.patient_id);
        if (pErr) throw pErr;
      }
      metadata.applied_priorities = policyUpdates;
    }

    // ── 2. Audit row ──────────────────────────────────────────────────
    const eventType = `sec_billing_${action}`;
    const summary = SUMMARIES[action];

    const { error: auditErr } = await (supabase as any).from("audit_logs").insert({
      organization_id: organizationId,
      claim_id: id,
      patient_id: claim.patient_id ?? null,
      appointment_id: claim.appointment_id ?? null,
      event_type: eventType,
      event_summary: summary,
      event_metadata: metadata,
      user_id: guard.userId,
      action: eventType,
      object_type: "claim",
      object_id: id,
    });
    if (auditErr) throw auditErr;

    return NextResponse.json({
      success: true,
      organizationId,
      claimId: id,
      action,
      summary,
    });
  } catch (error) {
    console.error("Secondary Billing action error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 },
    );
  }
}
