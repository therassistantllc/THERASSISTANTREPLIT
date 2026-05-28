import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

type Row = Record<string, unknown>;

function value(v: unknown) {
  return String(v ?? "").trim();
}

/**
 * Mark a client journal entry as reviewed by the clinician — a lightweight
 * acknowledgement that does NOT pull the entry into a SOAP note. Clients see
 * "Reviewed by <clinician> on <date>" in their portal once set.
 *
 * Auth: staff session in the same org (requireOrgAccess + view_patient_chart).
 * The reviewer's auth user id is taken from the session; any reviewer id in
 * the body is ignored.
 *
 * Idempotent: the first review wins. Subsequent calls return success without
 * overwriting `reviewed_at` / `reviewed_by_user_id` so a later viewer doesn't
 * silently claim the original review.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id: clientId, entryId } = await context.params;
  const body = (await request.json().catch(() => null)) as Row | null;
  const requestedOrg = value(body?.organizationId);

  const guard = await requireOrgAccess({
    requestedOrganizationId: requestedOrg || null,
    permission: "view_patient_chart",
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });
  }

  const { data: existing } = await supabase
    .from("patient_journal_entries")
    .select("id, reviewed_at, reviewed_by_user_id")
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
  }
  const existingRow = existing as Row;
  if (value(existingRow.reviewed_at)) {
    // Already reviewed — keep the original reviewer + timestamp.
    return NextResponse.json({
      success: true,
      alreadyReviewed: true,
      reviewedAt: existingRow.reviewed_at,
      reviewedByUserId: existingRow.reviewed_by_user_id,
    });
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("patient_journal_entries")
    .update({
      reviewed_at: now,
      reviewed_by_user_id: guard.userId ?? null,
      updated_at: now,
    })
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    // Only stamp if still unreviewed — guards against a race between two
    // clinicians clicking the button at the same time.
    .is("reviewed_at", null);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    reviewedAt: now,
    reviewedByUserId: guard.userId ?? null,
  });
}
