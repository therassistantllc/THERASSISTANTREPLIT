import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: items, error } = await supabase
      .from("workqueue_items")
      .select("id, title, work_type, status, priority, description, professional_claim_id, claim_id, encounter_id, appointment_id, deferred_until, defer_reason, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

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
      synthetic: false,
    }));

    // Surface blocked charge_capture_items as synthetic workqueue entries so
    // the client's workqueue tab shows signed visits that can't progress to
    // a claim yet (missing payer info, diagnosis codes, credentialing, etc.).
    // These are not persisted rows — they reflect the live blocker state.
    const seenChargeIds = new Set(
      (items ?? [])
        .filter((it: DbRow) => String(it.source_object_type ?? "") === "charge_capture_item")
        .map((it: DbRow) => String(it.source_object_id ?? "")),
    );

    const { data: blockedCharges } = await supabase
      .from("charge_capture_items")
      .select("id, encounter_id, appointment_id, service_date, total_charge, charge_status, blocker_reasons, claim_id, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .is("claim_id", null)
      .eq("charge_status", "blocked")
      .order("created_at", { ascending: false })
      .limit(25);

    const syntheticItems = ((blockedCharges ?? []) as DbRow[])
      .filter((row) => !seenChargeIds.has(String(row.id)))
      .map((row) => {
        const reasons = Array.isArray(row.blocker_reasons) ? row.blocker_reasons : [];
        const description = reasons
          .map((r: unknown) => {
            if (typeof r === "string") return r;
            if (r && typeof r === "object") {
              const obj = r as Record<string, unknown>;
              return String(obj.message ?? obj.reason ?? obj.code ?? "");
            }
            return "";
          })
          .filter(Boolean)
          .join("; ");
        return {
          id: `charge:${String(row.id)}`,
          title: "Signed visit blocked from billing",
          workType: "clinician_routed_billing_review",
          status: "open",
          priority: "medium",
          description: description || "Charge capture is blocked. Resolve in Charge Capture to create a claim.",
          professionalClaimId: null,
          claimId: null,
          encounterId: (row.encounter_id ?? null) as string | null,
          appointmentId: (row.appointment_id ?? null) as string | null,
          deferredUntil: null,
          deferReason: null,
          createdAt: (row.created_at ?? null) as string | null,
          updatedAt: (row.updated_at ?? null) as string | null,
          synthetic: true,
        };
      });

    const merged = [...syntheticItems, ...result];
    return NextResponse.json({ success: true, items: merged, total: merged.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load workqueue items" },
      { status: 500 },
    );
  }
}
