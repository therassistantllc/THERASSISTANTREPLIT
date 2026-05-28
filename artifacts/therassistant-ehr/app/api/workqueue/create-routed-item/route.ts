import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type DbRow = Record<string, unknown>;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function patientName(client: DbRow | null | undefined) {
  if (!client) return "Client";
  const first = typeof client.first_name === "string" ? client.first_name : "";
  const last = typeof client.last_name === "string" ? client.last_name : "";
  return [first, last].filter(Boolean).join(" ") || "Client";
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const body = await request.json();
    const organizationId = clean(body.organizationId);
    const clientId = clean(body.clientId);
    const appointmentId = clean(body.appointmentId) || null;
    const encounterId = clean(body.encounterId) || null;
    const title = clean(body.title) || "Clinician routed billing question";
    const description = clean(body.description) || "Clinician routed this client to billing/admin review.";
    const priority = clean(body.priority) || "medium";
    const workType = clean(body.workType) || "clinician_routed_billing_review";

    if (!organizationId || !clientId) {
      return NextResponse.json({ success: false, error: "organizationId and clientId are required" }, { status: 400 });
    }

    const { data: client } = await supabase
      .from("clients")
      .select("id, first_name, last_name, date_of_birth")
      .eq("organization_id", organizationId)
      .eq("id", clientId)
      .is("archived_at", null)
      .maybeSingle();

    const now = new Date().toISOString();
    const { data: item, error } = await supabase
      .from("workqueue_items")
      .insert({
        organization_id: organizationId,
        title: `${title} - ${patientName(client as DbRow | null)}`,
        description,
        work_type: workType,
        status: "open",
        priority,
        source_object_type: appointmentId ? "appointment" : encounterId ? "encounter" : "client",
        source_object_id: appointmentId ?? encounterId ?? clientId,
        client_id: clientId,
        appointment_id: appointmentId,
        encounter_id: encounterId,
        context_payload: {
          routed_from: "clinician_ui",
          patient_name: patientName(client as DbRow | null),
          patient_date_of_birth: client && typeof client.date_of_birth === "string" ? client.date_of_birth : null,
          reason: body.reason ?? null,
        },
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (error || !item) {
      return NextResponse.json({ success: false, error: error?.message ?? "Failed to create routed item" }, { status: 422 });
    }

    return NextResponse.json({ success: true, workqueueItemId: item.id });
  } catch (error) {
    console.error("Create routed workqueue item API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Create routed workqueue item failed" },
      { status: 500 },
    );
  }
}
