/**
 * GET /api/billing/providers-for-routing
 * Returns active providers with their staff_profiles.id for workqueue routing.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase)
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    // Fetch active providers
    const { data: providers, error } = await supabase
      .from("providers")
      .select("id, first_name, last_name, display_name, credential, npi, user_id")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("display_name", { ascending: true });

    if (error) throw error;

    // Fetch staff_profiles for each provider's user_id
    const userIds = (providers ?? []).map((p) => p.user_id).filter(Boolean) as string[];
    const staffProfileById = new Map<string, string>(); // auth_user_id → staff_profiles.id
    if (userIds.length > 0) {
      const { data: staff } = await supabase
        .from("staff_profiles")
        .select("id, auth_user_id")
        .eq("organization_id", organizationId)
        .in("auth_user_id", userIds)
        .is("archived_at", null);
      for (const s of (staff ?? [])) {
        if (s.auth_user_id) staffProfileById.set(s.auth_user_id, s.id);
      }
    }

    const rows = (providers ?? []).map((p) => {
      const first = String(p.first_name ?? "").trim();
      const last = String(p.last_name ?? "").trim();
      const display = String(p.display_name ?? "").trim() || [first, last].filter(Boolean).join(" ");
      const staffProfileId = p.user_id ? (staffProfileById.get(p.user_id) ?? null) : null;
      return {
        id: String(p.id),
        name: display || "Unknown",
        credential: p.credential ? String(p.credential) : null,
        npi: p.npi ? String(p.npi) : null,
        staffProfileId,
      };
    });

    return NextResponse.json({ success: true, providers: rows });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
