import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeClient(client: unknown) {
  const row = Array.isArray(client) ? client[0] : client;
  if (!row || typeof row !== "object") return null;
  const record = row as DbRow;
  return {
    id: getString(record.id),
    firstName: getString(record.first_name),
    lastName: getString(record.last_name),
    dateOfBirth: getString(record.date_of_birth),
  };
}

function itemToDto(row: DbRow) {
  const client = normalizeClient(row.clients);
  return {
    id: getString(row.id),
    title: getString(row.title),
    description: getString(row.description),
    workType: getString(row.work_type),
    status: getString(row.status),
    priority: getString(row.priority),
    sourceObjectType: getString(row.source_object_type),
    sourceObjectId: getString(row.source_object_id),
    clientId: getString(row.client_id),
    appointmentId: getString(row.appointment_id),
    encounterId: getString(row.encounter_id),
    claimId: getString(row.claim_id),
    professionalClaimId: getString(row.professional_claim_id),
    assignedToUserId: getString(row.assigned_to_user_id),
    deferredUntil: getString(row.deferred_until),
    deferReason: getString(row.defer_reason),
    createdAt: getString(row.created_at),
    updatedAt: getString(row.updated_at),
    resolvedAt: getString(row.resolved_at),
    closedAt: getString(row.closed_at),
    contextPayload: row.context_payload ?? {},
    client,
  };
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const url = new URL(request.url);
    const organizationId = url.searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
    const status = url.searchParams.get("status") || "active";
    const workType = url.searchParams.get("workType") || "";
    const priority = url.searchParams.get("priority") || "";
    const audience = (url.searchParams.get("audience") || "").toLowerCase();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);

    // Clinician-facing work types belong in the Clinician Inbox.
    // Everything else (billing, ERA, AR aging, denials, eligibility ops, etc.)
    // belongs in the Operations Workqueues.
    const CLINICIAN_WORK_TYPES = [
      "documentation_needed",
      "signature_needed",
      "chart_question",
      "clinician_review",
      "clinician_routed_question",
      "note_cosign_needed",
    ];

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    let query = supabase
      .from("workqueue_items")
      .select(`
        id,
        title,
        description,
        work_type,
        status,
        priority,
        source_object_type,
        source_object_id,
        client_id,
        encounter_id,
        claim_id,
        professional_claim_id,
        assigned_to_user_id,
        deferred_until,
        defer_reason,
        created_at,
        updated_at,
        resolved_at,
        closed_at,
        context_payload,
        clients:client_id(id, first_name, last_name, date_of_birth)
      `)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status === "active") {
      query = query.in("status", ["open", "in_progress", "blocked"]);
    } else if (status && status !== "all") {
      query = query.eq("status", status);
    }

    if (workType) {
      query = query.eq("work_type", workType);
    } else if (audience === "clinician") {
      query = query.in("work_type", CLINICIAN_WORK_TYPES);
    } else if (audience === "operations") {
      query = query.not("work_type", "in", `(${CLINICIAN_WORK_TYPES.join(",")})`);
    }
    if (priority) query = query.eq("priority", priority);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    }

    const items = ((data ?? []) as DbRow[]).map(itemToDto);
    const counts = items.reduce(
      (acc, item) => {
        acc.total += 1;
        acc.byStatus[item.status || "unknown"] = (acc.byStatus[item.status || "unknown"] || 0) + 1;
        acc.byPriority[item.priority || "unknown"] = (acc.byPriority[item.priority || "unknown"] || 0) + 1;
        acc.byWorkType[item.workType || "unknown"] = (acc.byWorkType[item.workType || "unknown"] || 0) + 1;
        return acc;
      },
      { total: 0, byStatus: {} as Record<string, number>, byPriority: {} as Record<string, number>, byWorkType: {} as Record<string, number> },
    );

    return NextResponse.json({ success: true, items, counts });
  } catch (error) {
    console.error("Workqueue list API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Workqueue list failed" },
      { status: 500 },
    );
  }
}
