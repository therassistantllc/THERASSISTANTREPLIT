import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId required" }, { status: 400 });

    const { data: items, error } = await supabase
      .from("workqueue_items")
      .select("id, title, work_type, status, priority, description, professional_claim_id, claim_id, encounter_id, appointment_id, deferred_until, defer_reason, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });

    const result = (items ?? []).map((item: DbRow) => ({
      id: item.id as string,
      title: item.title as string | null,
      workType: item.work_type as string | null,
      status: item.status as string | null,
      priority: item.priority as string | null,
      description: item.description as string | null,
      professionalClaimId: item.professional_claim_id as string | null,
      claimId: item.claim_id as string | null,
      encounterId: item.encounter_id as string | null,
      appointmentId: item.appointment_id as string | null,
      deferredUntil: item.deferred_until as string | null,
      deferReason: item.defer_reason as string | null,
      createdAt: item.created_at as string | null,
      updatedAt: item.updated_at as string | null,
    }));

    return NextResponse.json({ success: true, items: result, total: result.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load workqueue items" },
      { status: 500 },
    );
  }
}
