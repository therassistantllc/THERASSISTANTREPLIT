import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { getPortalSession } from "@/lib/portal/session";
import { JOURNAL_AUDIO_BUCKET } from "@/lib/portal/journal";
import { transcribeJournalAudio } from "@/lib/portal/transcribeAudio";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const SIGNED_TTL_SECONDS = 60 * 10;
const ALLOWED_MIME = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
]);

function extFor(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("aac")) return "aac";
  return "bin";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const { entryId } = await context.params;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });
  }

  const { data: existing } = await supabase
    .from("patient_journal_entries")
    .select("id, entry_type, audio_storage_bucket, audio_storage_path, imported_into_note_id")
    .eq("id", entryId)
    .eq("organization_id", session.organizationId)
    .eq("client_id", session.clientId)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Entry not found" }, { status: 404 });
  }
  if (existing.imported_into_note_id) {
    return NextResponse.json(
      { success: false, error: "This entry has been reviewed and can no longer be edited." },
      { status: 409 },
    );
  }
  if (String(existing.entry_type) !== "voice_note") {
    return NextResponse.json(
      { success: false, error: "Only voice-note entries accept audio uploads." },
      { status: 400 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { success: false, error: "Upload must include an `audio` file part." },
      { status: 400 },
    );
  }
  const mime = (file.type || "audio/webm").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { success: false, error: `Unsupported audio type: ${mime}` },
      { status: 415 },
    );
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength === 0) {
    return NextResponse.json(
      { success: false, error: "Empty audio upload." },
      { status: 400 },
    );
  }
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { success: false, error: "Audio file exceeds 20 MB limit." },
      { status: 413 },
    );
  }

  const path = `${session.organizationId}/${session.clientId}/${entryId}.${extFor(mime)}`;

  // Remove any prior recording before replacing to avoid orphaned files.
  const priorPath = String(existing.audio_storage_path ?? "");
  if (priorPath && priorPath !== path) {
    await supabase
      .storage
      .from(String(existing.audio_storage_bucket ?? JOURNAL_AUDIO_BUCKET))
      .remove([priorPath])
      .catch(() => null);
  }

  const { error: upErr } = await supabase
    .storage
    .from(JOURNAL_AUDIO_BUCKET)
    .upload(path, buf, { contentType: mime, upsert: true });
  if (upErr) {
    return NextResponse.json({ success: false, error: upErr.message }, { status: 500 });
  }

  const durationRaw = form?.get("durationSeconds");
  const duration = durationRaw ? Number(durationRaw) : null;
  const update = {
    audio_storage_bucket: JOURNAL_AUDIO_BUCKET,
    audio_storage_path: path,
    audio_mime_type: mime,
    audio_duration_seconds:
      duration !== null && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    // Reset any prior transcript — the file just changed.
    audio_transcript: null,
    updated_at: new Date().toISOString(),
  };
  const { error: dbErr } = await supabase
    .from("patient_journal_entries")
    .update(update)
    .eq("id", entryId)
    .eq("organization_id", session.organizationId)
    .eq("client_id", session.clientId);
  if (dbErr) {
    return NextResponse.json({ success: false, error: dbErr.message }, { status: 500 });
  }

  // Kick off transcription in the background. We deliberately do not await
  // this — the upload response returns immediately so the client sees the
  // entry as saved; clinicians (and the client on refresh) see the
  // transcript appear once the model call finishes. Errors are swallowed so
  // a failing transcription never blocks the audio upload itself.
  void (async () => {
    try {
      const text = await transcribeJournalAudio({ bytes: buf, contentType: mime });
      if (!text) return;
      await supabase
        .from("patient_journal_entries")
        .update({
          audio_transcript: text,
          updated_at: new Date().toISOString(),
        })
        .eq("id", entryId)
        .eq("organization_id", session.organizationId)
        .eq("client_id", session.clientId)
        // Only stamp if the same upload is still the current audio. If the
        // client re-recorded in the meantime, audio_storage_path will have
        // changed and we'd be writing a stale transcript.
        .eq("audio_storage_path", path);
    } catch (err) {
      console.warn(
        "journal audio: background transcription failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  })();

  return NextResponse.json({ success: true });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ entryId: string }> },
) {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const { entryId } = await context.params;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });
  }
  const { data: row } = await supabase
    .from("patient_journal_entries")
    .select("audio_storage_bucket, audio_storage_path")
    .eq("id", entryId)
    .eq("organization_id", session.organizationId)
    .eq("client_id", session.clientId)
    .maybeSingle();
  const bucket = String(row?.audio_storage_bucket ?? "");
  const path = String(row?.audio_storage_path ?? "");
  if (!bucket || !path) {
    return NextResponse.json({ success: false, error: "No audio attached" }, { status: 404 });
  }
  const { data: signed, error: signErr } = await supabase
    .storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { success: false, error: signErr?.message || "File not available" },
      { status: 404 },
    );
  }
  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: { "Cache-Control": "private, no-store" },
  });
}
