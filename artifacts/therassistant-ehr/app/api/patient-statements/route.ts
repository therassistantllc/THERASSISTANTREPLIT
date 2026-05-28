import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      organizationId?: string;
      clientId?: string;
      memo?: string | null;
      openBalance?: number | string | null;
    };
    const guard = await requireOrgAccess({ requestedOrganizationId: body.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const clientId = body.clientId ?? "";
    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId required" }, { status: 400 });
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", clientId)
      .is("archived_at", null)
      .maybeSingle();
    if (clientError || !client) {
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }

    const openBalance = Number(body.openBalance ?? 0) || 0;
    const memo = (body.memo ?? "").toString().trim() || null;

    const { data: inserted, error: insertError } = await supabase
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        patient_id: clientId,
        event_type: "patient_statement_generated",
        action: "generate",
        object_type: "patient_statement",
        event_summary: `Client statement generated; open balance ${openBalance.toFixed(2)}`,
        event_metadata: {
          open_balance: openBalance,
          memo,
          generated_at: new Date().toISOString(),
          source: "patient_balance_ui",
        },
      })
      .select("id")
      .single();

    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 422 });
    }

    return NextResponse.json({
      success: true,
      statementId: inserted?.id ?? null,
      openBalance,
    });
  } catch (error) {
    console.error("Client statement generate error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Statement generation failed" },
      { status: 500 },
    );
  }
}
