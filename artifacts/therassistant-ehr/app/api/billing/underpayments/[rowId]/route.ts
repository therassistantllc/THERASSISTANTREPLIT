/**
 * POST /api/billing/underpayments/[rowId]
 *
 * Action endpoint for the Underpayments workqueue (Task #377). The rowId is
 * `<eraPaymentId>#<lineIndex>` so each ERA service line is addressable on its
 * own.
 *
 * Body shape:
 *   { organizationId, action,
 *     reason?, allowedAmount?, ruleText?, feeScheduleId?,
 *     payerContractId?, procedureCode?, modifiers? }
 *
 * Actions:
 *   create_appeal       — writes a claim_note with marker UNDERPAYMENT_APPEAL
 *                         describing the underpayment + reason.
 *   request_reprocessing — writes a claim_note marker UNDERPAYMENT_REPROCESS
 *                         and audit entry; biller can then 276 the payer.
 *   mark_accepted        — writes a claim_note marker UNDERPAYMENT_ACCEPTED
 *                         which suppresses the row from the queue going forward.
 *   update_contract_rate — updates fee_schedules.allowed_amount in place (or
 *                         inserts a new row scoped to the payer contract if
 *                         none exists for the procedure_code + modifiers).
 *   add_payer_rule       — appends a free-form rule to payer_profiles.notes
 *                         tagged with [UNDERPAYMENT_RULE].
 *
 * Every action writes an audit_logs entry tagged with object_type='claim' (or
 * 'payer_profile' / 'fee_schedule' for the structural actions) and
 * event_type='underpayment_action'.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

type Action =
  | "create_appeal"
  | "request_reprocessing"
  | "mark_accepted"
  | "update_contract_rate"
  | "add_payer_rule";

const VALID: Action[] = [
  "create_appeal",
  "request_reprocessing",
  "mark_accepted",
  "update_contract_rate",
  "add_payer_rule",
];

const text = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : null;
};

interface Body {
  organizationId?: string;
  action?: Action;
  reason?: string;
  allowedAmount?: number;
  ruleText?: string;
  feeScheduleId?: string;
  payerContractId?: string;
  payerProfileId?: string;
  procedureCode?: string;
  modifiers?: string[];
  /**
   * Additional `<eraPaymentId>#<lineIndex>` row ids to archive (mark accepted)
   * alongside this action. Used by the "Adopt suggested contract rate" banner
   * on the Underpayments queue to close every related variance row in one
   * click. Ignored unless `action === 'update_contract_rate'`.
   */
  acceptRowIds?: string[];
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
  });
}

async function writeAudit(
  supabase: any,
  args: {
    organizationId: string;
    claimId: string | null;
    patientId: string | null;
    objectType: string;
    objectId: string | null;
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
    object_type: args.objectType,
    object_id: args.objectId,
    action: args.action,
    event_type: "underpayment_action",
    event_summary: args.summary,
    event_metadata: args.metadata,
    user_id: args.userId,
    user_role: args.userRole,
    before_value: args.before ?? null,
    after_value: args.after ?? null,
  });
}

function parseRowId(rowId: string): { eraPaymentId: string; lineIndex: number } | null {
  const [eraPaymentId, idxStr] = rowId.split("#");
  if (!eraPaymentId) return null;
  const lineIndex = Number(idxStr ?? 0);
  return {
    eraPaymentId,
    lineIndex: Number.isFinite(lineIndex) ? lineIndex : 0,
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ rowId: string }> },
) {
  try {
    const { rowId: rawRowId } = await ctx.params;
    const rowId = decodeURIComponent(rawRowId);
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

    const parsed = parseRowId(rowId);
    if (!parsed) {
      return NextResponse.json(
        { success: false, error: "Invalid row id" },
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

    // Load the ERA payment to get the linked claim.
    const { data: era } = await (supabase as any)
      .from("era_claim_payments")
      .select(
        "id, organization_id, professional_claim_id, client_id, service_lines, clp04_payment_amount, allowed_amount",
      )
      .eq("id", parsed.eraPaymentId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!era) {
      return NextResponse.json(
        { success: false, error: "ERA payment not found" },
        { status: 404 },
      );
    }

    const claimId = text(era.professional_claim_id) || null;
    const patientId = text(era.client_id) || null;
    const author = await authorName(supabase, guard.staffId ?? null);
    const reason = text(body.reason).slice(0, 1000) || null;

    // ── update_contract_rate (structural — does not require a claim) ────
    if (action === "update_contract_rate") {
      const allowed = num(body.allowedAmount);
      if (allowed == null || allowed < 0) {
        return NextResponse.json(
          { success: false, error: "allowedAmount (>= 0) is required" },
          { status: 400 },
        );
      }
      const feeScheduleId = text(body.feeScheduleId) || null;
      const procedureCode = text(body.procedureCode).toUpperCase() || null;
      const modifiers = Array.isArray(body.modifiers)
        ? body.modifiers.map((m) => String(m).toUpperCase()).filter(Boolean)
        : [];
      const payerContractId = text(body.payerContractId) || null;

      let beforeRow: Record<string, unknown> | null = null;
      let afterRow: Record<string, unknown> | null = null;
      let updatedId: string;

      if (feeScheduleId) {
        const { data: before } = await (supabase as any)
          .from("fee_schedules")
          .select("id, allowed_amount, procedure_code, modifiers")
          .eq("id", feeScheduleId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!before) {
          return NextResponse.json(
            { success: false, error: "Fee schedule not found" },
            { status: 404 },
          );
        }
        beforeRow = before as Record<string, unknown>;
        const { error: updErr } = await (supabase as any)
          .from("fee_schedules")
          .update({ allowed_amount: allowed, updated_at: new Date().toISOString() })
          .eq("id", feeScheduleId)
          .eq("organization_id", organizationId);
        if (updErr) {
          return NextResponse.json(
            { success: false, error: updErr.message },
            { status: 422 },
          );
        }
        updatedId = feeScheduleId;
        afterRow = { ...beforeRow, allowed_amount: allowed };
      } else {
        if (!procedureCode) {
          return NextResponse.json(
            { success: false, error: "procedureCode is required when no feeScheduleId" },
            { status: 400 },
          );
        }
        const insert = {
          organization_id: organizationId,
          payer_contract_id: payerContractId,
          schedule_name:
            reason?.slice(0, 80) ||
            `Updated from Underpayments queue ${new Date().toISOString().slice(0, 10)}`,
          procedure_code: procedureCode,
          modifiers,
          allowed_amount: allowed,
        };
        const { data: created, error: insErr } = await (supabase as any)
          .from("fee_schedules")
          .insert(insert)
          .select("id")
          .single();
        if (insErr) {
          return NextResponse.json(
            { success: false, error: insErr.message },
            { status: 422 },
          );
        }
        updatedId = text((created as any).id);
        afterRow = insert as Record<string, unknown>;
      }

      if (claimId) {
        await writeNote(supabase, {
          organizationId,
          claimId,
          authorUserId: guard.userId ?? null,
          authorDisplayName: author,
          body: `UNDERPAYMENT_CONTRACT_UPDATE: fee_schedule=${updatedId} allowed=${allowed}${
            reason ? ` — ${reason}` : ""
          }`,
        });
      }
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId,
        objectType: "fee_schedule",
        objectId: updatedId,
        action,
        summary: `Updated contract rate to ${allowed}`,
        metadata: {
          rowId,
          allowed,
          procedureCode,
          modifiers,
          reason,
          eraPaymentId: parsed.eraPaymentId,
        },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
        before: beforeRow,
        after: afterRow,
      });

      // Bulk-archive related variance rows when the suggestion banner adopts
      // a rate that closes out a whole cluster in one click. Each "accepted"
      // marker has to be written on the claim associated with that ERA, so
      // we resolve them in one batch before inserting notes.
      const extraIds = Array.isArray(body.acceptRowIds)
        ? body.acceptRowIds
            .map((s) => text(s))
            .filter((s) => s && s !== rowId)
            .slice(0, 200)
        : [];
      let archivedCount = 0;
      if (extraIds.length > 0) {
        const eraIds = [
          ...new Set(extraIds.map((s) => s.split("#")[0]).filter(Boolean)),
        ];
        const { data: eraRows } = await (supabase as any)
          .from("era_claim_payments")
          .select("id, professional_claim_id")
          .eq("organization_id", organizationId)
          .in("id", eraIds);
        const claimByEra = new Map<string, string>();
        for (const row of (eraRows as any[]) ?? []) {
          const cid = text((row as any).professional_claim_id);
          if (cid) claimByEra.set(text((row as any).id), cid);
        }
        let writtenCount = 0;
        for (const id of extraIds) {
          const eraId = id.split("#")[0];
          const cid = claimByEra.get(eraId);
          if (!cid) continue;
          const { error: noteErr } = await insertClaimNote(supabase as any, {
            organizationId,
            claimId: cid,
            authorUserId: guard.userId ?? null,
            authorDisplayName: author,
            body: `UNDERPAYMENT_ACCEPTED:${id} — adopted contract rate ${allowed} (auto, fee_schedule=${updatedId})`,
          });
          if (!noteErr) writtenCount += 1;
        }
        archivedCount = writtenCount;
      }

      return NextResponse.json({
        success: true,
        action,
        feeScheduleId: updatedId,
        archivedRows: archivedCount,
      });
    }

    // ── add_payer_rule ──────────────────────────────────────────────────
    if (action === "add_payer_rule") {
      const ruleText = text(body.ruleText).slice(0, 1000);
      const payerProfileId = text(body.payerProfileId) || null;
      if (!ruleText) {
        return NextResponse.json(
          { success: false, error: "ruleText is required" },
          { status: 400 },
        );
      }
      if (!payerProfileId) {
        return NextResponse.json(
          { success: false, error: "payerProfileId is required" },
          { status: 400 },
        );
      }
      const { data: prof } = await (supabase as any)
        .from("payer_profiles")
        .select("id, notes")
        .eq("id", payerProfileId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!prof) {
        return NextResponse.json(
          { success: false, error: "Payer profile not found" },
          { status: 404 },
        );
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const appended = `${text((prof as any).notes)}\n[UNDERPAYMENT_RULE ${stamp}]: ${ruleText}`.trim();
      const { error: updErr } = await (supabase as any)
        .from("payer_profiles")
        .update({ notes: appended, updated_at: new Date().toISOString() })
        .eq("id", payerProfileId)
        .eq("organization_id", organizationId);
      if (updErr) {
        return NextResponse.json(
          { success: false, error: updErr.message },
          { status: 422 },
        );
      }
      if (claimId) {
        await writeNote(supabase, {
          organizationId,
          claimId,
          authorUserId: guard.userId ?? null,
          authorDisplayName: author,
          body: `UNDERPAYMENT_RULE: payer=${payerProfileId} — ${ruleText}`,
        });
      }
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId,
        objectType: "payer_profile",
        objectId: payerProfileId,
        action,
        summary: `Added payer rule to ${payerProfileId}`,
        metadata: { rowId, ruleText, eraPaymentId: parsed.eraPaymentId },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
        before: { notes: (prof as any).notes ?? null },
        after: { notes: appended },
      });
      return NextResponse.json({ success: true, action });
    }

    // Remaining actions require a linked claim.
    if (!claimId) {
      return NextResponse.json(
        {
          success: false,
          error: "This action requires the ERA payment to be matched to a claim",
        },
        { status: 422 },
      );
    }

    // ── create_appeal ───────────────────────────────────────────────────
    if (action === "create_appeal") {
      if (!reason) {
        return NextResponse.json(
          { success: false, error: "A reason is required for this action" },
          { status: 400 },
        );
      }
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `UNDERPAYMENT_APPEAL [${rowId}]: ${reason}`,
      });
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId,
        objectType: "claim",
        objectId: claimId,
        action,
        summary: "Created underpayment appeal",
        metadata: { rowId, reason, eraPaymentId: parsed.eraPaymentId },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
      return NextResponse.json({ success: true, action });
    }

    // ── request_reprocessing ────────────────────────────────────────────
    if (action === "request_reprocessing") {
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `UNDERPAYMENT_REPROCESS [${rowId}]${reason ? `: ${reason}` : ""}`,
      });
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId,
        objectType: "claim",
        objectId: claimId,
        action,
        summary: "Requested reprocessing for underpayment",
        metadata: { rowId, reason, eraPaymentId: parsed.eraPaymentId },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
      return NextResponse.json({ success: true, action });
    }

    // ── mark_accepted ───────────────────────────────────────────────────
    if (action === "mark_accepted") {
      await writeNote(supabase, {
        organizationId,
        claimId,
        authorUserId: guard.userId ?? null,
        authorDisplayName: author,
        body: `UNDERPAYMENT_ACCEPTED:${rowId}${reason ? ` — ${reason}` : ""}`,
      });
      await writeAudit(supabase, {
        organizationId,
        claimId,
        patientId,
        objectType: "claim",
        objectId: claimId,
        action,
        summary: "Accepted underpayment (closed out of queue)",
        metadata: { rowId, reason, eraPaymentId: parsed.eraPaymentId },
        userId: guard.userId ?? null,
        userRole: guard.roles?.[0] ?? null,
      });
      return NextResponse.json({ success: true, action });
    }

    return NextResponse.json(
      { success: false, error: "Unhandled action" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
