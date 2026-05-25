/**
 * POST /api/billing/corrected-claims/[claimId]
 *
 * Action endpoint for the Corrected Claim workqueue (Task #367). Body shape:
 *   { organizationId, action, correctionType?, reason?, documentation? }
 *
 * Actions:
 *   create_corrected   — Clones an original (denied/rejected) claim into a
 *                        child correction claim with claim_frequency_code='7',
 *                        original_claim_id=<orig>, correction_type='replacement',
 *                        correction_status='pending'. claimId param = original.
 *   submit_replacement — On a child claim: sets claim_frequency_code='7',
 *                        correction_status='sent', correction_sent_at=now(),
 *                        claim_status='ready_for_batch'.
 *   submit_void        — On a child claim: sets claim_frequency_code='8',
 *                        correction_type='void', correction_status='sent',
 *                        correction_sent_at=now(), claim_status='ready_for_batch'.
 *   attach_documentation — Writes a CORRECTION_DOC note recording the
 *                        attached doc URL / description.
 *   mark_complete      — Marks correction_status='sent' on the child (or
 *                        archives the original when used on the "needed"
 *                        tab without a child).
 *
 * Every action writes an audit_logs entry tagged with object_type='claim'
 * and event_type='correction_action'.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

type Action =
  | "create_corrected"
  | "submit_replacement"
  | "submit_void"
  | "attach_documentation"
  | "mark_complete"
  | "dismiss";

const VALID: Action[] = [
  "create_corrected",
  "submit_replacement",
  "submit_void",
  "attach_documentation",
  "mark_complete",
  "dismiss",
];

const text = (v: unknown) => String(v ?? "").trim();

interface Body {
  organizationId?: string;
  action?: Action;
  correctionType?: "replacement" | "void";
  reason?: string;
  documentation?: string;
}

async function loadClaim(
  supabase: any,
  organizationId: string,
  claimId: string,
) {
  const { data } = await supabase
    .from("professional_claims")
    .select(
      "id, organization_id, claim_status, claim_frequency_code, total_charge, patient_id, payer_profile_id, appointment_id, place_of_service, diagnosis_codes, prior_authorization_number, accept_assignment, benefits_assignment, release_of_information, signature_on_file, archived_at, original_claim_id, correction_type, correction_status, denial_reason_code, denial_reason_description",
    )
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data;
}

async function authorName(supabase: any, staffId: string | null) {
  if (!staffId) return "Staff";
  const { data } = await supabase
    .from("staff_profiles")
    .select("first_name, last_name, email")
    .eq("id", staffId)
    .maybeSingle();
  if (!data) return "Staff";
  const composed = [data.first_name, data.last_name]
    .map((v: unknown) => text(v))
    .filter(Boolean)
    .join(" ");
  return composed || text(data.email) || "Staff";
}

async function writeNote(
  supabase: any,
  args: {
    organizationId: string;
    claimId: string;
    authorUserId: string | null;
    authorDisplayName: string;
    body: string;
  },
) {
  return insertClaimNote(supabase, {
    organizationId: args.organizationId,
    claimId: args.claimId,
    authorUserId: args.authorUserId,
    authorDisplayName: args.authorDisplayName,
    body: args.body,
    returning: "id",
  });
}

async function writeAudit(
  supabase: any,
  args: {
    organizationId: string;
    claimId: string;
    patientId: string | null;
    action: string;
    summary: string;
    metadata: Record<string, unknown>;
    userId: string | null;
    userRole: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
) {
  await supabase.from("audit_logs").insert({
    organization_id: args.organizationId,
    claim_id: args.claimId,
    patient_id: args.patientId,
    object_type: "claim",
    object_id: args.claimId,
    action: args.action,
    event_type: "correction_action",
    event_summary: args.summary,
    event_metadata: args.metadata,
    user_id: args.userId,
    user_role: args.userRole,
    before_value: args.before ?? null,
    after_value: args.after ?? null,
  });
}

async function cloneServiceLines(
  supabase: any,
  fromClaimId: string,
  toClaimId: string,
) {
  const { data: lines } = await supabase
    .from("professional_claim_service_lines")
    .select(
      "line_number, service_date_from, service_date_to, procedure_code, modifiers, charge_amount, units, diagnosis_pointers, place_of_service, rendering_provider_npi, authorization_number",
    )
    .eq("claim_id", fromClaimId)
    .order("line_number", { ascending: true });
  const rows = ((lines as any[]) ?? []).map((l) => ({
    claim_id: toClaimId,
    line_number: l.line_number,
    service_date_from: l.service_date_from,
    service_date_to: l.service_date_to,
    procedure_code: l.procedure_code,
    modifiers: l.modifiers ?? [],
    charge_amount: l.charge_amount,
    units: l.units,
    diagnosis_pointers: l.diagnosis_pointers ?? ["1"],
    place_of_service: l.place_of_service,
    rendering_provider_npi: l.rendering_provider_npi,
    authorization_number: l.authorization_number,
  }));
  if (rows.length === 0) return;
  await supabase.from("professional_claim_service_lines").insert(rows);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as Body;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const action = body.action;
    if (!action || !VALID.includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of ${VALID.join(", ")}` },
        { status: 400 },
      );
    }
    const reason = text(body.reason).slice(0, 500) || null;
    if ((action === "create_corrected" || action === "dismiss") && !reason) {
      return NextResponse.json(
        { success: false, error: "A reason is required for this action" },
        { status: 400 },
      );
    }
    if (action === "attach_documentation" && !text(body.documentation)) {
      return NextResponse.json(
        { success: false, error: "Documentation URL or description is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const claim = await loadClaim(supabase, organizationId, claimId);
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const author = await authorName(supabase, guard.staffId ?? null);
    const nowIso = new Date().toISOString();

    // ── create_corrected ─────────────────────────────────────────────────
    if (action === "create_corrected") {
      const correctionType: "replacement" | "void" =
        body.correctionType === "void" ? "void" : "replacement";
      const frequency = correctionType === "void" ? "8" : "7";

      // Insert child claim by cloning the relevant scalar fields.
      const insertPayload = {
        organization_id: organizationId,
        patient_id: (claim as any).patient_id ?? null,
        payer_profile_id: (claim as any).payer_profile_id ?? null,
        appointment_id: (claim as any).appointment_id ?? null,
        claim_status: "draft",
        claim_frequency_code: frequency,
        total_charge: (claim as any).total_charge ?? 0,
        place_of_service: (claim as any).place_of_service ?? null,
        diagnosis_codes: (claim as any).diagnosis_codes ?? [],
        prior_authorization_number: (claim as any).prior_authorization_number ?? null,
        accept_assignment: (claim as any).accept_assignment ?? true,
        benefits_assignment: (claim as any).benefits_assignment ?? true,
        release_of_information: (claim as any).release_of_information ?? true,
        signature_on_file: (claim as any).signature_on_file ?? true,
        original_claim_id: claimId,
        correction_type: correctionType,
        correction_status: "pending",
        correction_reason: reason,
      };

      const { data: created, error: insErr } = await (supabase as any)
        .from("professional_claims")
        .insert(insertPayload)
        .select("id, claim_number")
        .single();
      if (insErr) {
        return NextResponse.json(
          { success: false, error: insErr.message },
          { status: 422 },
        );
      }
      const childId = text((created as any).id);

      // Clone party snapshot if exists (best-effort).
      const { data: parties } = await (supabase as any)
        .from("claim_parties_snapshot")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();
      if (parties) {
        const { id: _id, claim_id: _cid, created_at: _ca, updated_at: _ua, ...rest } =
          parties as any;
        await (supabase as any)
          .from("claim_parties_snapshot")
          .insert({ ...rest, claim_id: childId });
      }

      await cloneServiceLines(supabase, claimId, childId);

      await writeNote(supabase, {
        organizationId,
        claimId: childId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `CORRECTION_CREATED from ${claimId} (${correctionType}, frequency ${frequency}): ${reason}`,
      });
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `CORRECTION_LINKED: child correction claim ${childId} created (${correctionType}).`,
      });

      await writeAudit(supabase, {
        organizationId,
        claimId: childId,
        patientId: text((claim as any).patient_id) || null,
        action,
        summary: `Created corrected claim (${correctionType}) from ${claimId}`,
        metadata: { originalClaimId: claimId, correctionType, frequency, reason },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
        after: insertPayload,
      });

      return NextResponse.json({
        success: true,
        action,
        claimId,
        correctedClaimId: childId,
      });
    }

    // ── attach_documentation ─────────────────────────────────────────────
    if (action === "attach_documentation") {
      const docBody = `CORRECTION_DOC: ${text(body.documentation)}${
        reason ? ` — ${reason}` : ""
      }`;
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: docBody,
      });
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId: text((claim as any).patient_id) || null,
        action,
        summary: "Attached supporting documentation to corrected claim",
        metadata: { documentation: text(body.documentation), reason },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
      return NextResponse.json({ success: true, action, claimId });
    }

    // ── dismiss (drop a "needed" original from the queue) ────────────────
    if (action === "dismiss") {
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `CORRECTION_DISMISS:${claimId} — ${reason}`,
      });
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId: text((claim as any).patient_id) || null,
        action,
        summary: "Dismissed from corrected-claim queue",
        metadata: { reason },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
      return NextResponse.json({ success: true, action, claimId });
    }

    // ── submit_replacement / submit_void / mark_complete ────────────────
    let updatePatch: Record<string, unknown> = {};
    let summary = "";
    let noteBody = "";

    if (action === "submit_replacement") {
      updatePatch = {
        claim_frequency_code: "7",
        correction_type: "replacement",
        correction_status: "sent",
        correction_sent_at: nowIso,
        claim_status: "ready_for_batch",
        updated_at: nowIso,
      };
      summary = "Submitted replacement (frequency 7)";
      noteBody = `CORRECTION_SUBMITTED: replacement (frequency 7)${
        reason ? ` — ${reason}` : ""
      }`;
    } else if (action === "submit_void") {
      updatePatch = {
        claim_frequency_code: "8",
        correction_type: "void",
        correction_status: "sent",
        correction_sent_at: nowIso,
        claim_status: "ready_for_batch",
        updated_at: nowIso,
      };
      summary = "Submitted void (frequency 8)";
      noteBody = `CORRECTION_SUBMITTED: void (frequency 8)${
        reason ? ` — ${reason}` : ""
      }`;
    } else if (action === "mark_complete") {
      // Two flavours: on a child correction, mark it sent; on an original
      // with no child, archive the original.
      if (text((claim as any).original_claim_id) || text((claim as any).correction_type)) {
        updatePatch = {
          correction_status: "sent",
          correction_sent_at: nowIso,
          updated_at: nowIso,
        };
        summary = "Marked correction complete";
        noteBody = `CORRECTION_COMPLETE${reason ? `: ${reason}` : ""}`;
      } else {
        updatePatch = { archived_at: nowIso, updated_at: nowIso };
        summary = "Original archived — no correction needed";
        noteBody = `CORRECTION_DISMISS:${claimId} — ${
          reason ?? "Resolved without correction"
        }`;
      }
    }

    const before = {
      claim_status: (claim as any).claim_status,
      correction_status: (claim as any).correction_status,
      correction_type: (claim as any).correction_type,
      claim_frequency_code: (claim as any).claim_frequency_code,
    };

    const { error: updErr } = await (supabase as any)
      .from("professional_claims")
      .update(updatePatch)
      .eq("id", claimId)
      .eq("organization_id", organizationId);
    if (updErr) {
      return NextResponse.json(
        { success: false, error: updErr.message },
        { status: 422 },
      );
    }

    if (noteBody) {
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: noteBody,
      });
    }

    await writeAudit(supabase, {
      organizationId,
      claimId,
      patientId: text((claim as any).patient_id) || null,
      action,
      summary,
      metadata: { reason, patch: updatePatch },
      userId: guard.userId ?? null,
      userRole: guard.roles?.[0] ?? null,
      before,
      after: updatePatch,
    });

    return NextResponse.json({ success: true, action, claimId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
