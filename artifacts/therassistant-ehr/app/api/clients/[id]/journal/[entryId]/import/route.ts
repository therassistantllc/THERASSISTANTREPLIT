import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
import { SOAP_FIELDS, SoapField } from "@/lib/portal/journal";

type Row = Record<string, unknown>;

function value(v: unknown) {
  return String(v ?? "").trim();
}

/**
 * Mark a journal entry as imported into a SOAP note.
 *
 * Auth: staff session in the same org (requireOrgAccess). The session's
 * staffId is the source of truth for `imported_by_user_id`; the request
 * body's `userId` is ignored.
 *
 * The target note is validated to belong to the same org + client before any
 * write happens. Idempotent for the same (note, field); rejected (409) when
 * the entry was previously imported into a different note so it can't be
 * silently double-counted.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id: clientId, entryId } = await context.params;
  const body = (await request.json().catch(() => null)) as Row | null;
  const requestedOrg = value(body?.organizationId);
  const noteId = value(body?.noteId);
  const field = value(body?.field) as SoapField;

  const guard = await requireOrgAccess({
    requestedOrganizationId: requestedOrg || null,
    permission: "edit_notes",
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  if (!noteId || !SOAP_FIELDS.includes(field)) {
    return NextResponse.json(
      {
        success: false,
        error: "noteId and field (subjective|objective|assessment|plan) are required",
      },
      { status: 400 },
    );
  }
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });
  }

  // Validate the note belongs to the same org + client. Without this, a
  // caller could stamp a journal entry as "imported" into a note for a
  // completely different client or org.
  const { data: note } = await supabase
    .from("encounter_clinical_notes")
    .select("id, encounter_id, encounters!inner(client_id, organization_id)")
    .eq("id", noteId)
    .maybeSingle();
  const noteRow = note as Row | null;
  const noteEnc = (noteRow?.encounters ?? null) as Row | null;
  if (
    !noteRow ||
    !noteEnc ||
    value(noteEnc.organization_id) !== organizationId ||
    value(noteEnc.client_id) !== clientId
  ) {
    return NextResponse.json(
      { success: false, error: "Target note does not belong to this client." },
      { status: 400 },
    );
  }

  const { data: existing } = await supabase
    .from("patient_journal_entries")
    .select("imported_into_note_id, imported_into_field")
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
  }
  const prevNote = value((existing as Row).imported_into_note_id);
  const prevField = value((existing as Row).imported_into_field);
  if (prevNote && (prevNote !== noteId || prevField !== field)) {
    return NextResponse.json(
      {
        success: false,
        error: "This entry has already been imported into another note.",
      },
      { status: 409 },
    );
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("patient_journal_entries")
    .update({
      imported_into_note_id: noteId,
      imported_into_field: field,
      imported_at: now,
      imported_by_user_id: guard.userId ?? null,
      updated_at: now,
    })
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .eq("client_id", clientId);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
