/**
 * /api/billing/fax-queue/[id]
 *
 * POST — row-level actions on a single fax_queue entry.
 *
 * Actions:
 *   retry  : move a 'failed' row back to 'pending' so the downstream
 *            fax worker picks it up again (clears the error message).
 *   cancel : move a still-'pending' row to 'canceled' so it never
 *            gets sent.
 *
 * No fax-provider integration exists yet — these state changes only
 * affect the queue row itself. Sent rows are immutable here.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();

const ACTIONS = ["retry", "cancel"] as const;
type ActionName = (typeof ACTIONS)[number];

export async function POST(
  request: Request,
  context: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const resolved = await Promise.resolve(context.params);
    const faxId = text((resolved as any)?.id);
    if (!faxId) {
      return NextResponse.json(
        { success: false, error: "Fax id is required" },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({} as any));
    const action = text(body?.action) as ActionName;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json(
        { success: false, error: `action must be one of: ${ACTIONS.join(", ")}` },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const guard = await requireBillingAccess({
      requestedOrganizationId: text(body?.organizationId) || null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: existing, error: loadErr } = await (supabase as any)
      .from("fax_queue")
      .select("id, status")
      .eq("organization_id", organizationId)
      .eq("id", faxId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Fax not found" },
        { status: 404 },
      );
    }

    const currentStatus = text((existing as DbRow).status) || "pending";

    if (action === "retry") {
      if (currentStatus !== "failed") {
        return NextResponse.json(
          { success: false, error: `Cannot retry a fax in status '${currentStatus}' — only 'failed' rows are retryable.` },
          { status: 409 },
        );
      }
      const { data: updated, error } = await (supabase as any)
        .from("fax_queue")
        .update({ status: "pending", error: null })
        .eq("organization_id", organizationId)
        .eq("id", faxId)
        .select("id, status")
        .single();
      if (error) throw error;
      return NextResponse.json({
        success: true,
        id: text((updated as DbRow).id),
        status: text((updated as DbRow).status),
      });
    }

    if (action === "cancel") {
      if (currentStatus !== "pending") {
        return NextResponse.json(
          { success: false, error: `Cannot cancel a fax in status '${currentStatus}' — only 'pending' rows can be canceled.` },
          { status: 409 },
        );
      }
      const { data: updated, error } = await (supabase as any)
        .from("fax_queue")
        .update({ status: "canceled" })
        .eq("organization_id", organizationId)
        .eq("id", faxId)
        .select("id, status")
        .single();
      if (error) throw error;
      return NextResponse.json({
        success: true,
        id: text((updated as DbRow).id),
        status: text((updated as DbRow).status),
      });
    }

    return NextResponse.json({ success: false, error: "Unhandled action" }, { status: 400 });
  } catch (error) {
    console.error("Fax queue action error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Fax queue action failed" },
      { status: 500 },
    );
  }
}
