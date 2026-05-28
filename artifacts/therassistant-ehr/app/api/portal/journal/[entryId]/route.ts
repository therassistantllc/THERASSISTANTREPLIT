import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { getPortalSession } from "@/lib/portal/session";
import {
  ENTRY_TYPES,
  EntryType,
  JOURNAL_AUDIO_BUCKET,
  mapJournalRow,
  sanitizeBody,
} from "@/lib/portal/journal";

type Row = Record<string, unknown>;

async function loadOwnedEntry(
  entryId: string,
  organizationId: string,
  clientId: string,
) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { error: "DB unavailable" as const, supabase: null, entry: null };
  const { data } = await supabase
    .from("patient_journal_entries")
    .select(
      "id, entry_type, body, tags, audio_storage_bucket, audio_storage_path, audio_mime_type, audio_duration_seconds, audio_transcript, imported_into_note_id, imported_into_field, imported_at, created_at, updated_at",
    )
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .maybeSingle();
  return { error: null, supabase, entry: (data as Row | null) ?? null };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const { entryId } = await context.params;
  const payload = (await request.json().catch(() => null)) as Row | null;

  const { supabase, entry, error } = await loadOwnedEntry(
    entryId,
    session.organizationId,
    session.clientId,
  );
  if (error || !supabase) return NextResponse.json({ success: false, error }, { status: 500 });
  if (!entry) return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
  // Once a clinician has imported the entry it becomes part of the chart record
  // and the client can no longer edit it (matches task acceptance).
  if (entry.imported_into_note_id) {
    return NextResponse.json(
      { success: false, error: "This entry has been reviewed and can no longer be edited." },
      { status: 409 },
    );
  }
  const entryType = (entry.entry_type as EntryType) || "reflection";
  if (!ENTRY_TYPES.includes(entryType)) {
    return NextResponse.json({ success: false, error: "Invalid entry type" }, { status: 400 });
  }
  const update: Row = { updated_at: new Date().toISOString() };
  if (payload && "body" in payload) update.body = sanitizeBody(entryType, payload.body);
  if (payload && Array.isArray(payload.tags)) {
    update.tags = (payload.tags as unknown[])
      .map((t) => String(t ?? "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  const { data, error: updateErr } = await supabase
    .from("patient_journal_entries")
    .update(update)
    .eq("id", entryId)
    .eq("organization_id", session.organizationId)
    .eq("client_id", session.clientId)
    .select(
      "id, entry_type, body, tags, audio_storage_path, audio_mime_type, audio_duration_seconds, audio_transcript, imported_into_note_id, imported_into_field, imported_at, created_at, updated_at",
    )
    .single();
  if (updateErr || !data) {
    return NextResponse.json(
      { success: false, error: updateErr?.message ?? "Failed to update entry" },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, entry: mapJournalRow(data as Row) });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const { entryId } = await context.params;
  const { supabase, entry, error } = await loadOwnedEntry(
    entryId,
    session.organizationId,
    session.clientId,
  );
  if (error || !supabase) return NextResponse.json({ success: false, error }, { status: 500 });
  if (!entry) return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
  if (entry.imported_into_note_id) {
    return NextResponse.json(
      { success: false, error: "This entry has been reviewed and can no longer be removed." },
      { status: 409 },
    );
  }
  const audioPath = String(entry.audio_storage_path ?? "");
  const audioBucket = String(entry.audio_storage_bucket ?? JOURNAL_AUDIO_BUCKET);
  if (audioPath) {
    // Best-effort; we still delete the row even if the storage object is gone.
    await supabase.storage.from(audioBucket).remove([audioPath]).catch(() => null);
  }
  const { error: delErr } = await supabase
    .from("patient_journal_entries")
    .delete()
    .eq("id", entryId)
    .eq("organization_id", session.organizationId)
    .eq("client_id", session.clientId);
  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
