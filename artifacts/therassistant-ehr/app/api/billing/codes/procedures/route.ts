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
    const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") ?? 20)));

    let query = supabase
      .from("procedure_codes")
      .select("code, description, code_system")
      .eq("is_active", true)
      .limit(limit);

    if (q) {
      const upper = q.toUpperCase();
      query = query.or(`code.ilike.${upper}%,description.ilike.%${q}%`);
      query = query.order("code", { ascending: true });
    } else {
      query = query.order("code", { ascending: true });
    }

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
