import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ organizations: [], error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });
  }
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, legal_name, slug, default_state, timezone, is_active, archived_at, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ organizations: [], error: error.message }, { status: 500 });
  }
  return NextResponse.json({ organizations: data ?? [] });
}
