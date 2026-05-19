import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "DB unavailable" }, { status: 500 });

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId required" }, { status: 400 });

    const { data: encounters, error: encErr } = await supabase
      .from("encounters")
      .select("id, service_date, encounter_status, appointment_id")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("service_date", { ascending: false })
      .limit(50);

    if (encErr) return NextResponse.json({ success: false, error: encErr.message }, { status: 422 });

    const encounterIds = (encounters ?? []).map((e: DbRow) => e.id as string);

    const { data: notes, error: noteErr } = encounterIds.length > 0
      ? await supabase
          .from("encounter_notes")
          .select("id, encounter_id, note_status, note_type, note_body, signed_at, created_at")
          .in("encounter_id", encounterIds)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(100)
      : { data: [] as DbRow[], error: null };

    if (noteErr) return NextResponse.json({ success: false, error: noteErr.message }, { status: 422 });

    const encMap: Record<string, DbRow> = {};
    for (const enc of (encounters ?? [])) encMap[enc.id as string] = enc;

    const items = (notes ?? []).map((note: DbRow) => ({
      id: note.id as string,
      encounterId: note.encounter_id as string,
      encounterDate: (encMap[note.encounter_id as string]?.service_date as string | null) ?? null,
      encounterStatus: (encMap[note.encounter_id as string]?.encounter_status as string | null) ?? null,
      noteStatus: note.note_status as string | null,
      noteType: note.note_type as string | null,
      signedAt: note.signed_at as string | null,
      createdAt: note.created_at as string | null,
      hasSoapNote: Boolean(note.note_body),
    }));

    return NextResponse.json({ success: true, notes: items, encounters: encounters ?? [], total: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load notes" },
      { status: 500 },
    );
  }
}
