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

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

export async function POST() {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required for organization creation. Add it to .env.local and restart dev server.",
        },
        { status: 503 },
      );
    }

    const { data: existingOrg, error: existingErr } = await supabase
      .from("organizations")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingErr) throw existingErr;

    if (existingOrg?.id) {
      return NextResponse.json({ success: true, organizationId: existingOrg.id, created: false });
    }

    const now = new Date().toISOString();
    const organizationId = generateUuid();
    const organizationName = `Organization ${new Date().toLocaleDateString("en-US")}`;

    // Try with common columns first, then gracefully fall back if schema differs.
    const attempts: Array<Record<string, unknown>> = [
      { id: organizationId, name: organizationName, created_at: now, updated_at: now },
      { id: organizationId, name: organizationName },
      { name: organizationName },
    ];

    let createdId: string | null = null;
    let lastError: unknown = null;

    for (const payload of attempts) {
      const { data, error } = await supabase
        .from("organizations")
        .insert(payload)
        .select("id")
        .single();

      if (!error && data?.id) {
        createdId = String(data.id);
        break;
      }

      lastError = error;
    }

    if (!createdId) throw lastError ?? new Error("Could not create organization");

    return NextResponse.json({ success: true, organizationId: createdId, created: true });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
