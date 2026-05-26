/**
 * PATCH /api/billing/claims/[claimId]/notes/[noteId]
 *
 * Toggles the `resolved_denial` flag on a single claim note so billers can
 * undo (or re-apply) the "this note resolved the denial" mark after the
 * fact. This is the only field this endpoint will mutate — body text,
 * author, defer_until, etc. are intentionally out of scope.
 *
 * Tenant isolation follows the same pattern as the sibling POST: the
 * organization id comes from the session (via requireBillingAccess) and
 * both the parent claim and the note row are scoped to it before update.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

interface PatchBody {
  organizationId?: string | null;
  resolved_denial?: boolean | null;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ claimId: string; noteId: string }> },
) {
  try {
    const { claimId, noteId } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    if (typeof body.resolved_denial !== "boolean") {
      return NextResponse.json(
        { success: false, error: "resolved_denial (boolean) is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    // Confirm the parent claim belongs to this org (defence in depth — the
    // note row is also org-scoped on update below).
    const { data: claim } = await supabase
      .from("professional_claims")
      .select("id, organization_id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    const { data, error } = await (supabase as any)
      .from("claim_notes")
      .update({ resolved_denial: body.resolved_denial })
      .eq("id", noteId)
      .eq("claim_id", claimId)
      .eq("organization_id", organizationId)
      .select(
        "id, body, defer_until, author_user_id, author_display_name, rarc_codes, resolved_denial, created_at",
      )
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }
    if (!data) {
      return NextResponse.json(
        { success: false, error: "Note not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, note: data });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
