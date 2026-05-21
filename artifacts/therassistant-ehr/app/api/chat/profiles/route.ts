import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const url = new URL(request.url);
    const organizationId =
      url.searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("role", { ascending: true })
      .order("full_name", { ascending: true });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    }

    return NextResponse.json({
      success: true,
      profiles: (data ?? []).map((p: Record<string, unknown>) => ({
        id: String(p.id ?? ""),
        fullName: String(p.full_name ?? "") || String(p.email ?? ""),
        email: String(p.email ?? ""),
        role: String(p.role ?? "clinician"),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Profiles list failed" },
      { status: 500 },
    );
  }
}
