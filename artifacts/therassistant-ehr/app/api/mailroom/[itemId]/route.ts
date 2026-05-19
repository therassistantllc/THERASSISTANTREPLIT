import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

function value(input: unknown) {
  return String(input ?? "").trim();
}

function auditEntry(action: string, message: string) {
  return { action, message, at: new Date().toISOString() };
}

export async function PATCH(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { itemId } = await context.params;
    const body = await request.json();
    const organizationId = value(body.organizationId);

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const { data: current, error: currentError } = await supabase
      .from("mailroom_items")
      .select("id, handling_audit")
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .is("archived_at", null)
      .maybeSingle();

    if (currentError || !current) return NextResponse.json({ success: false, error: "Mailroom item not found" }, { status: 404 });

    const now = new Date().toISOString();
    const status = value(body.status);
    const filedLocation = value(body.filedLocation);
    const action = value(body.action) || "updated";
    const audit = Array.isArray(current.handling_audit) ? current.handling_audit : [];
    const update: Record<string, unknown> = {
      updated_at: now,
      handling_audit: [...audit, auditEntry(action, value(body.message) || `Mailroom item ${action}`)],
    };

    if (status) update.mail_status = status;
    if (value(body.priority)) update.priority = value(body.priority);
    if (value(body.notes)) update.notes = value(body.notes);
    if (value(body.clientId)) update.client_id = value(body.clientId);
    if (filedLocation) update.filed_location = filedLocation;

    if (status === "filed") {
      update.filed_at = now;
      update.resolved_at = now;
    }

    if (status === "archived") {
      update.resolved_at = now;
    }

    const { data, error } = await supabase
      .from("mailroom_items")
      .update(update)
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .select("id")
      .single();

    if (error || !data) return NextResponse.json({ success: false, error: error?.message ?? "Failed to update mailroom item" }, { status: 422 });

    return NextResponse.json({ success: true, id: data.id });
  } catch (error) {
    console.error("Mailroom PATCH error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Mailroom update failed" },
      { status: 500 },
    );
  }
}
