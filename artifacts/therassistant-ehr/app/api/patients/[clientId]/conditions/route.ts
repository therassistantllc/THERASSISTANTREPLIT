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
      .select("id, service_date")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null);

    if (encErr) return NextResponse.json({ success: false, error: encErr.message }, { status: 422 });

    const encounterIds = (encounters ?? []).map((e: DbRow) => e.id as string);

    const { data: diagnoses, error: diagErr } = encounterIds.length > 0
      ? await supabase
          .from("encounter_diagnoses")
          .select("id, encounter_id, diagnosis_code, diagnosis_description, is_primary, sequence_number, present_on_claim, created_at")
          .in("encounter_id", encounterIds)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(200)
      : { data: [] as DbRow[], error: null };

    if (diagErr) return NextResponse.json({ success: false, error: diagErr.message }, { status: 422 });

    const encMap: Record<string, DbRow> = {};
    for (const enc of (encounters ?? [])) encMap[enc.id as string] = enc;

    // Deduplicate by diagnosis_code, showing most recent encounter date
    const seen = new Set<string>();
    const items: {
      id: string;
      code: string;
      description: string | null;
      isPrimary: boolean;
      presentOnClaim: boolean;
      encounterId: string;
      encounterDate: string | null;
      createdAt: string | null;
    }[] = [];

    for (const d of (diagnoses ?? []) as DbRow[]) {
      const code = String(d.diagnosis_code ?? "");
      if (!seen.has(code)) {
        seen.add(code);
        items.push({
          id: d.id as string,
          code,
          description: (d.diagnosis_description as string | null) ?? null,
          isPrimary: Boolean(d.is_primary),
          presentOnClaim: Boolean(d.present_on_claim),
          encounterId: d.encounter_id as string,
          encounterDate: (encMap[d.encounter_id as string]?.service_date as string | null) ?? null,
          createdAt: (d.created_at as string | null) ?? null,
        });
      }
    }

    return NextResponse.json({ success: true, conditions: items, total: items.length });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to load conditions" },
      { status: 500 },
    );
  }
}
