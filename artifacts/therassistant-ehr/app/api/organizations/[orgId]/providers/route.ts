import { NextResponse, NextRequest } from "next/server";
import crypto from "crypto";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

function uuid() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? "Unknown error");
  return "Unknown error";
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ providers: [], error: "Service role key not configured" }, { status: 503 });

  const { data, error } = await supabase
    .from("provider_credentialing_profiles")
    .select("id, provider_name, credential_display, email, individual_npi, is_active, organization_id")
    .eq("organization_id", orgId)
    .order("provider_name", { ascending: true });
  if (error) return NextResponse.json({ providers: [], error: error.message }, { status: 500 });
  return NextResponse.json({ providers: data ?? [] });
}

/**
 * POST { mode: "create", provider_name, credential_display?, email?, individual_npi? }
 *   → creates a new credentialing profile scoped to this org.
 * POST { mode: "attach", profile_id }
 *   → reassigns an existing profile to this org (move provider between orgs).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ success: false, error: "Service role key not configured" }, { status: 503 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty */ }
  const mode = body.mode === "attach" ? "attach" : "create";
  const now = new Date().toISOString();

  try {
    if (mode === "attach") {
      const profileId = typeof body.profile_id === "string" ? body.profile_id : "";
      if (!profileId) return NextResponse.json({ success: false, error: "profile_id required" }, { status: 400 });
      const { data, error } = await supabase
        .from("provider_credentialing_profiles")
        .update({ organization_id: orgId, updated_at: now })
        .eq("id", profileId)
        .select("id, provider_name, organization_id")
        .single();
      if (error) throw error;
      return NextResponse.json({ success: true, profile: data });
    }

    const provider_name = typeof body.provider_name === "string" ? body.provider_name.trim() : "";
    if (!provider_name) return NextResponse.json({ success: false, error: "provider_name required" }, { status: 400 });

    const payload: Record<string, unknown> = {
      id: uuid(),
      organization_id: orgId,
      provider_name,
      credential_display: typeof body.credential_display === "string" ? body.credential_display.trim() || null : null,
      email: typeof body.email === "string" ? body.email.trim() || null : null,
      individual_npi: typeof body.individual_npi === "string" ? body.individual_npi.replace(/\D/g, "").slice(0, 10) || null : null,
      is_active: true,
      source: "manual",
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await supabase
      .from("provider_credentialing_profiles")
      .insert(payload)
      .select("id, provider_name, organization_id")
      .single();
    if (error) throw error;
    return NextResponse.json({ success: true, profile: data });
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}
