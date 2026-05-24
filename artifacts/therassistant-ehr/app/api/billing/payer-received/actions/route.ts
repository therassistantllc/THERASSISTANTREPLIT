import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { dispatchClaimStatusInquiry } from "@/lib/billing/claimStatusDispatcher";

type ActionName =
  | "check_status"
  | "add_note"
  | "set_follow_up"
  | "move_to_aging";

interface ActionBody {
  organizationId?: string;
  action?: ActionName;
  claimId?: string;
  clientId?: string | null;
  note?: string;
  followUpDueAt?: string | null;
}

type Sb = ReturnType<typeof createServerSupabaseAdminClient>;

async function writeAudit(
  supabase: Sb,
  args: {
    organizationId: string;
    userId: string | null;
    action: string;
    claimId: string;
    clientId: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (!supabase) return;
  try {
    await (supabase as unknown as { from: (t: string) => { insert: (v: unknown) => Promise<unknown> } })
      .from("audit_logs")
      .insert({
        organization_id: args.organizationId,
        user_id: args.userId,
        action: args.action,
        event_type: "payer_received_workqueue",
        event_summary: args.summary,
        event_metadata: args.metadata ?? {},
        claim_id: args.claimId,
        patient_id: args.clientId,
        object_type: "professional_claim",
        object_id: args.claimId,
      });
  } catch (e) {
    console.warn("payer-received audit failed:", e);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const body = (await request.json()) as ActionBody;
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const action = body.action;
    const claimId = body.claimId ?? "";
    if (!action || !claimId) {
      return NextResponse.json(
        { success: false, error: "action and claimId are required" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    switch (action) {
      case "check_status": {
        // Validate the claim exists AND belongs to the authenticated
        // user's organization BEFORE we create any inquiry or event
        // rows. Without this, a known-foreign claim UUID could be used
        // to inject claim_status_events / inquiry rows scoped to the
        // caller's org but pointing at someone else's claim id.
        const { data: claimOwner, error: ownerErr } = await sb
          .from("professional_claims")
          .select("id")
          .eq("id", claimId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (ownerErr) {
          return NextResponse.json(
            { success: false, error: ownerErr.message ?? "Failed to verify claim" },
            { status: 500 },
          );
        }
        if (!claimOwner?.id) {
          return NextResponse.json(
            { success: false, error: "Claim not found" },
            { status: 404 },
          );
        }

        // Queue a 276 status inquiry and immediately dispatch it through
        // the clearinghouse adapter. If the queueing insert fails, surface
        // the failure — we never want to tell the user a status inquiry
        // was queued when it wasn't.
        const duplicateKey = `payer_received:${claimId}:${Date.now()}`;
        const queuedAt = new Date().toISOString();
        const { data: inserted, error: insertErr } = await sb
          .from("claim_status_inquiries")
          .insert({
            organization_id: organizationId,
            claim_id: claimId,
            inquiry_status: "queued",
            requested_at: queuedAt,
            duplicate_detection_key: duplicateKey,
            created_by_user_id: userId,
            // Task #540: distinguish biller-initiated checks from the
            // scheduled cron auto-checks (see claimStatusAutoCheck.ts).
            trigger_source: "manual",
          })
          .select("id")
          .single();
        if (insertErr || !inserted?.id) {
          return NextResponse.json(
            {
              success: false,
              error: insertErr?.message ?? "Failed to queue payer status inquiry",
            },
            { status: 500 },
          );
        }

        // Synchronously act as the dispatcher: send the 276, record the
        // 277, update this same inquiry row with payer_status_code/text/
        // responded_at, and write a claim_status_events history entry.
        const dispatchOutcome = await dispatchClaimStatusInquiry({
          supabase,
          organizationId,
          claimId,
          inquiryId: inserted.id as string,
        });

        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "payer_received_status_checked",
          claimId,
          clientId: body.clientId ?? null,
          summary:
            dispatchOutcome.inquiryStatus === "received"
              ? "Submitted 276 payer status inquiry"
              : "Queued 276 payer status inquiry (dispatch failed)",
          metadata: {
            queuedAt,
            inquiryId: inserted.id,
            inquiryStatus: dispatchOutcome.inquiryStatus,
            normalizedStatus: dispatchOutcome.normalized?.status ?? null,
            controlNumber: dispatchOutcome.controlNumber,
            correlationId: dispatchOutcome.correlationId,
            error: dispatchOutcome.errorMessage,
          },
        });

        if (dispatchOutcome.inquiryStatus === "failed") {
          return NextResponse.json(
            {
              success: false,
              queuedAt,
              inquiryId: inserted.id,
              inquiryStatus: dispatchOutcome.inquiryStatus,
              error: dispatchOutcome.errorMessage ?? "276/277 dispatch failed",
            },
            { status: 502 },
          );
        }

        return NextResponse.json({
          success: true,
          queuedAt,
          inquiryId: inserted.id,
          inquiryStatus: dispatchOutcome.inquiryStatus,
          normalizedStatus: dispatchOutcome.normalized?.status ?? null,
          payerStatusCode: dispatchOutcome.normalized?.statusCode ?? null,
          payerStatusText: dispatchOutcome.normalized?.payerMessage ?? null,
        });
      }
      case "add_note": {
        const note = (body.note ?? "").trim();
        if (!note) {
          return NextResponse.json({ success: false, error: "note is required" }, { status: 400 });
        }
        // Append the note to billing_notes (best-effort) AND log it.
        try {
          const { data: existing } = await sb
            .from("professional_claims")
            .select("billing_notes")
            .eq("id", claimId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          const prior = text((existing as { billing_notes?: unknown } | null)?.billing_notes);
          const stamp = new Date().toISOString().slice(0, 10);
          const next = prior ? `${prior}\n[${stamp}] ${note}` : `[${stamp}] ${note}`;
          await sb.from("professional_claims")
            .update({ billing_notes: next })
            .eq("id", claimId)
            .eq("organization_id", organizationId);
        } catch (e) {
          console.warn("append billing_notes failed:", e);
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "payer_received_note_added",
          claimId,
          clientId: body.clientId ?? null,
          summary: note.slice(0, 280),
        });
        return NextResponse.json({ success: true, note });
      }
      case "set_follow_up": {
        const dueAt = (body.followUpDueAt ?? "").trim();
        if (!dueAt) {
          return NextResponse.json(
            { success: false, error: "followUpDueAt is required" },
            { status: 400 },
          );
        }
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "payer_received_follow_up_set",
          claimId,
          clientId: body.clientId ?? null,
          summary: `Follow-up set for ${dueAt}`,
          metadata: { dueAt, billerId: userId },
        });
        return NextResponse.json({ success: true, dueAt });
      }
      case "move_to_aging": {
        await writeAudit(supabase, {
          organizationId,
          userId,
          action: "payer_received_moved_to_aging",
          claimId,
          clientId: body.clientId ?? null,
          summary: "Moved to aging / no-response queue",
        });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}

function text(v: unknown): string {
  return String(v ?? "").trim();
}
