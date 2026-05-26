/**
 * /api/billing/fax-queue/[id]
 *
 * POST — row-level actions on a single fax_queue entry.
 *
 * Actions:
 *   retry  : move a 'failed' row back to 'pending', then immediately
 *            invoke the fax-queue dispatcher so the row is actually
 *            re-transmitted through the configured fax provider
 *            (Telnyx) instead of just sitting on 'pending' until the
 *            next scheduled sweep. Surfaces the per-fax outcome
 *            (sent / failed / skipped) in the response.
 *   cancel : move a still-'pending' row to 'canceled' so it never
 *            gets sent.
 *
 * Sent rows are immutable here.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { runFaxQueueDispatch } from "@/lib/billing/faxQueueWorker";

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
      // Step 1 — reset row to 'pending' so the dispatcher can claim it.
      const { error: resetErr } = await (supabase as any)
        .from("fax_queue")
        .update({ status: "pending", error: null, sent_at: null })
        .eq("organization_id", organizationId)
        .eq("id", faxId);
      if (resetErr) throw resetErr;

      // Step 2 — actually re-transmit. The dispatcher will atomically claim
      // the row (pending → processing), download the documents referenced by
      // the matching transmission, upload the merged PDF, hand the signed
      // URL to the fax provider, and flip the row to sent/failed with the
      // real outcome. If only this one fax is pending in the org it's the
      // only row touched; if others are pending too they ride along, which
      // is the desired behavior (a manual retry shouldn't strand neighbors).
      let dispatchOutcome:
        | { status: "sent" | "failed" | "skipped"; error?: string | null; providerMessageId?: string | null }
        | null = null;
      let providerName: string | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await runFaxQueueDispatch(supabase as any, { organizationId, maxFaxes: 25 });
        providerName = r.providerName;
        const mine = r.perFax.find((p) => p.faxId === faxId) ?? null;
        if (mine) dispatchOutcome = mine;
      } catch (e) {
        console.warn(
          `[fax-queue retry] dispatcher threw for ${faxId}:`,
          e instanceof Error ? e.message : e,
        );
      }

      // Re-read the row to report the actual terminal state to the UI.
      const { data: after } = await (supabase as any)
        .from("fax_queue")
        .select("id, status, error, sent_at")
        .eq("organization_id", organizationId)
        .eq("id", faxId)
        .maybeSingle();
      const afterRow = (after as DbRow) ?? {};
      return NextResponse.json({
        success: true,
        id: text(afterRow.id) || faxId,
        status: text(afterRow.status) || "pending",
        error: text(afterRow.error) || null,
        sentAt: text(afterRow.sent_at) || null,
        providerName,
        dispatchOutcome,
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
