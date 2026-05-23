import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function GET(request: Request) {
  try {
    const guard = await requireBillingAccess();
    if (guard instanceof NextResponse) return guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") ?? "").trim();
    const parent = (searchParams.get("parent") ?? "").trim().toUpperCase();
    const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") ?? 20)));
    const includeInactive = searchParams.get("includeInactive") !== "0";

    let query = supabase
      .from("diagnosis_codes")
      .select("code, description, code_system, is_active, expiration_date")
      .limit(limit);

    if (parent) {
      // Children-of-header mode: return billable descendants of an ICD-10
      // header (e.g. parent=F32 → F32.0, F32.1, F32.9, F32.A…). Always
      // restrict to active codes — non-billable sub-headers would just
      // produce the same problem again.
      query = query
        .ilike("code", `${parent}.%`)
        .eq("is_active", true)
        .order("code", { ascending: true });
      const { data, error } = await query;
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, items: data ?? [] });
    }

    if (!includeInactive) {
      query = query.eq("is_active", true);
    }

    if (q) {
      const upper = q.toUpperCase();
      query = query.or(`code.ilike.${upper}%,description.ilike.%${q}%`);
    }
    // Active codes first, then by code.
    query = query.order("is_active", { ascending: false }).order("code", { ascending: true });

    const { data, error } = await query;
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, items: data ?? [] });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Search failed" },
      { status: 500 },
    );
  }
}
