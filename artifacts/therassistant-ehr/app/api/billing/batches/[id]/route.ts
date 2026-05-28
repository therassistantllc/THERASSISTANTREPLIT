import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;

function text(value: unknown) {
  return String(value ?? "").trim();
}
function num(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function money(value: unknown) {
  const n = num(value);
  return Math.round(n * 100) / 100;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: batch, error: batchErr } = await supabase
      .from("claim_837p_batches")
      .select("*")
      .eq("id", id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (batchErr) return NextResponse.json({ success: false, error: batchErr.message }, { status: 422 });
    if (!batch) return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 });

    const batchRow = batch as DbRow;
    const batchNumber = text(batchRow.batch_number);

    const { data: linkRows } = await supabase
      .from("claim_837p_batch_claims")
      .select("professional_claim_id")
      .eq("organization_id", organizationId)
      .eq("batch_id", id)
      .is("archived_at", null);
    const claimIds = [...new Set(((linkRows ?? []) as DbRow[]).map((r) => text(r.professional_claim_id)).filter(Boolean))];

    const { data: claims } = claimIds.length
      ? await supabase
          .from("professional_claims")
          .select("id, patient_id, claim_number, claim_status, total_charge_amount, updated_at, submitted_at, accepted_at, denied_at")
          .eq("organization_id", organizationId)
          .in("id", claimIds)
      : { data: [] as DbRow[] };

    const clientIds = [...new Set(((claims ?? []) as DbRow[]).map((c) => text(c.patient_id)).filter(Boolean))];
    const { data: clients } = clientIds.length
      ? await supabase.from("clients").select("id, first_name, last_name").in("id", clientIds)
      : { data: [] as DbRow[] };
    const clientById = new Map<string, DbRow>(((clients ?? []) as DbRow[]).map((c) => [text(c.id), c]));

    const { data: submissions } = claimIds.length
      ? await supabase
          .from("claim_submissions")
          .select("id, claim_id, submission_status, submission_sequence, submitted_at, acknowledged_at, clearinghouse_reference, response_summary, created_at")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .is("archived_at", null)
          .order("created_at", { ascending: true })
      : { data: [] as DbRow[] };

    const { data: respEvents } = claimIds.length
      ? await supabase
          .from("clearinghouse_response_events")
          .select("id, claim_id, event_type, severity, source, title, message, normalized_code, is_resolved, created_at")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .order("created_at", { ascending: true })
      : { data: [] as DbRow[] };

    const { data: statusEvents } = claimIds.length
      ? await supabase
          .from("claim_status_events")
          .select("id, claim_id, source, status, status_message, availity_claim_id, availity_file_id, created_at")
          .in("claim_id", claimIds)
          .order("created_at", { ascending: true })
      : { data: [] as DbRow[] };

    const { data: workqueue } = claimIds.length
      ? await supabase
          .from("claim_workqueue_items")
          .select("id, claim_id, item_status, priority, carc_code, rarc_code, group_code, denial_reason, action_taken, assigned_to_user_id, resolved_at, created_at, updated_at")
          .eq("organization_id", organizationId)
          .in("claim_id", claimIds)
          .is("archived_at", null)
          .is("resolved_at", null)
          .order("created_at", { ascending: false })
      : { data: [] as DbRow[] };

    let ediBatchIds: string[] = [];
    if (batchNumber) {
      const { data: ediBatches } = await supabase
        .from("edi_batches")
        .select("id")
        .eq("organization_id", organizationId)
        .or(
          `isa_control_number.eq.${batchNumber},gs_control_number.eq.${batchNumber},st_control_number.eq.${batchNumber},availity_file_id.eq.${batchNumber}`,
        );
      ediBatchIds = ((ediBatches ?? []) as DbRow[]).map((r) => text(r.id));
    }
    const { data: acks } = ediBatchIds.length
      ? await supabase
          .from("edi_acknowledgements")
          .select("id, acknowledgement_type, file_name, parsed_content, created_at")
          .eq("organization_id", organizationId)
          .in("edi_batch_id", ediBatchIds)
          .order("created_at", { ascending: false })
      : { data: [] as DbRow[] };

    const claimNumberById = new Map<string, string>();
    const claimsOut = ((claims ?? []) as DbRow[]).map((c) => {
      const cid = text(c.id);
      const client = clientById.get(text(c.patient_id));
      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
        : "Unknown client";
      const cn = text(c.claim_number);
      claimNumberById.set(cid, cn);
      return {
        id: cid,
        patientId: text(c.patient_id),
        patientName,
        claimNumber: cn,
        status: text(c.claim_status),
        totalCharge: money(c.total_charge_amount),
        submittedAt: text(c.submitted_at),
        acceptedAt: text(c.accepted_at),
        deniedAt: text(c.denied_at),
        updatedAt: text(c.updated_at),
      };
    });

    type TimelineEvent = {
      id: string;
      at: string;
      kind: "submission" | "status" | "response";
      severity: "info" | "success" | "warning" | "error";
      title: string;
      detail: string;
      claimId: string;
      claimNumber: string;
    };

    const timeline: TimelineEvent[] = [];
    for (const s of (submissions ?? []) as DbRow[]) {
      const cid = text(s.claim_id);
      const ss = text(s.submission_status);
      timeline.push({
        id: `sub-${text(s.id)}`,
        at: text(s.submitted_at) || text(s.created_at),
        kind: "submission",
        severity: ss === "rejected" || ss === "error" ? "error" : ss === "acknowledged" ? "success" : "info",
        title: `Submission ${ss || "queued"}`,
        detail: text(s.clearinghouse_reference) || (s.response_summary ? "with payer response" : ""),
        claimId: cid,
        claimNumber: claimNumberById.get(cid) || cid.slice(0, 8),
      });
    }
    for (const e of (statusEvents ?? []) as DbRow[]) {
      const cid = text(e.claim_id);
      const status = text(e.status);
      timeline.push({
        id: `st-${text(e.id)}`,
        at: text(e.created_at),
        kind: "status",
        severity: /reject|denied|fail/i.test(status) ? "error" : /accept|paid/i.test(status) ? "success" : "info",
        title: `Status: ${status || "update"}`,
        detail: [text(e.status_message), text(e.source) ? `via ${text(e.source)}` : ""].filter(Boolean).join(" · "),
        claimId: cid,
        claimNumber: claimNumberById.get(cid) || cid.slice(0, 8),
      });
    }
    for (const e of (respEvents ?? []) as DbRow[]) {
      const cid = text(e.claim_id);
      const sev = text(e.severity);
      const mapped: TimelineEvent["severity"] =
        sev === "critical" || sev === "error" ? "error" : sev === "warning" ? "warning" : "info";
      timeline.push({
        id: `rsp-${text(e.id)}`,
        at: text(e.created_at),
        kind: "response",
        severity: mapped,
        title: text(e.title) || text(e.event_type) || "Clearinghouse response",
        detail: [text(e.message), text(e.normalized_code) ? `code ${text(e.normalized_code)}` : ""].filter(Boolean).join(" · "),
        claimId: cid,
        claimNumber: claimNumberById.get(cid) || cid.slice(0, 8),
      });
    }
    timeline.sort((a, b) => (b.at || "").localeCompare(a.at || ""));

    const exceptions = ((workqueue ?? []) as DbRow[]).map((w) => {
      const cid = text(w.claim_id);
      return {
        id: text(w.id),
        claimId: cid,
        claimNumber: claimNumberById.get(cid) || cid.slice(0, 8),
        itemStatus: text(w.item_status),
        priority: text(w.priority),
        carcCode: text(w.carc_code),
        rarcCode: text(w.rarc_code),
        groupCode: text(w.group_code),
        denialReason: text(w.denial_reason),
        actionTaken: text(w.action_taken),
        createdAt: text(w.created_at),
        updatedAt: text(w.updated_at),
      };
    });

    const acksOut = ((acks ?? []) as DbRow[]).map((a) => ({
      id: text(a.id),
      type: text(a.acknowledgement_type),
      fileName: text(a.file_name),
      receivedAt: text(a.created_at),
      parsed: a.parsed_content ?? null,
    }));

    return NextResponse.json({
      success: true,
      batch: {
        id: text(batchRow.id),
        batchNumber,
        status: text(batchRow.batch_status),
        claimCount: num(batchRow.claim_count) || claimsOut.length,
        totalCharge: money(batchRow.total_charge_amount),
        generatedFileName: text(batchRow.generated_file_name),
        submittedAt: text(batchRow.submitted_at),
        createdAt: text(batchRow.created_at),
        updatedAt: text(batchRow.updated_at),
        lastGenerationError: text(batchRow.last_generation_error) || null,
        lastGenerationErrorDetail:
          batchRow.last_generation_error_detail &&
          typeof batchRow.last_generation_error_detail === "object"
            ? (batchRow.last_generation_error_detail as Record<string, unknown>)
            : null,
        lastGenerationAttemptedAt: text(batchRow.last_generation_attempted_at) || null,
      },
      claims: claimsOut,
      submissions: ((submissions ?? []) as DbRow[]).map((s) => {
        const cid = text(s.claim_id);
        return {
          id: text(s.id),
          claimId: cid,
          claimNumber: claimNumberById.get(cid) || cid.slice(0, 8),
          status: text(s.submission_status),
          sequence: num(s.submission_sequence),
          submittedAt: text(s.submitted_at),
          acknowledgedAt: text(s.acknowledged_at),
          clearinghouseReference: text(s.clearinghouse_reference),
        };
      }),
      timeline,
      exceptions,
      acknowledgements: acksOut,
      counts: {
        claims: claimsOut.length,
        events: timeline.length,
        exceptions: exceptions.length,
        acks999: acksOut.filter((a) => a.type === "999").length,
        acks277ca: acksOut.filter((a) => a.type === "277CA").length,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Batch detail failed" },
      { status: 500 },
    );
  }
}
