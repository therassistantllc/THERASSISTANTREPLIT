import { NextResponse } from "next/server";
import crypto from "crypto";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  try { return JSON.stringify(error); } catch { return "Unknown error"; }
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export async function POST(req: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "SUPABASE_SERVICE_ROLE_KEY is required for organization creation." },
        { status: 503 },
      );
    }

    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; } catch { /* allow empty body */ }

    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : `Organization ${new Date().toLocaleDateString("en-US")}`;
    const legal_name = typeof body.legal_name === "string" && body.legal_name.trim() ? body.legal_name.trim() : name;
    const slug = typeof body.slug === "string" && body.slug.trim() ? slugify(body.slug) : `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const default_state = typeof body.default_state === "string" ? body.default_state.trim().toUpperCase().slice(0, 2) : "";
    const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "America/New_York";

    const now = new Date().toISOString();
    const organizationId = generateUuid();

    const attempts: Array<Record<string, unknown>> = [
      { id: organizationId, name, legal_name, slug, default_state, timezone, is_active: true, created_at: now, updated_at: now },
      { id: organizationId, name, slug, is_active: true, created_at: now, updated_at: now },
      { id: organizationId, name, created_at: now, updated_at: now },
      { id: organizationId, name },
      { name },
    ];

    let createdId: string | null = null;
    let lastError: unknown = null;
    for (const payload of attempts) {
      const { data, error } = await supabase.from("organizations").insert(payload).select("id").single();
      if (!error && data?.id) { createdId = String(data.id); break; }
      lastError = error;
    }
    if (!createdId) throw lastError ?? new Error("Could not create organization");

    return NextResponse.json({ success: true, organizationId: createdId, created: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: extractErrorMessage(error) }, { status: 500 });
  }
}
