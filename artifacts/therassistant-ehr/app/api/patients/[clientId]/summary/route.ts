import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function fullName(client: DbRow | null) {
  if (!client) return "Unknown client";
  return [client.first_name, client.last_name].filter(Boolean).join(" ") || "Unknown client";
}

async function getOpenBalance(organizationId: string, clientId: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data, error } = await supabase
    .from("patient_invoices")
    .select("id, invoice_number, invoice_status, balance_amount, patient_responsibility_amount, created_at")
    .eq("organization_id", organizationId)
    .eq("client_id", clientId)
    .in("invoice_status", ["open", "sent", "collections"])
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) return { total: 0, invoices: [] as DbRow[] };

  const invoices = data ?? [];
  const total = invoices.reduce((sum: number, invoice: DbRow) => sum + Number(invoice.balance_amount ?? 0), 0);
  return { total, invoices };
}

export async function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const { clientId } = await context.params;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });
    }

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, date_of_birth, email, phone, preferred_name, pronouns")
      .eq("organization_id", organizationId)
      .eq("id", clientId)
      .is("archived_at", null)
      .maybeSingle();

    if (clientError || !client) {
      return NextResponse.json({ success: false, error: "Patient not found" }, { status: 404 });
    }

    const { data: policies } = await supabase
      .from("insurance_policies")
      .select("id, plan_name, policy_number, priority, active_flag, effective_date, termination_date, payer_id")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("priority", { ascending: true });

    const { data: eligibility } = await supabase
      .from("eligibility_checks")
      .select("id, eligibility_status, checked_at, copay_amount, deductible_remaining, coverage_start_date, coverage_end_date, response_summary")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: encounters } = await supabase
      .from("encounters")
      .select("id, appointment_id, encounter_status, service_date, started_at, ended_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("service_date", { ascending: false })
      .limit(10);

    const { data: workqueueItems } = await supabase
      .from("workqueue_items")
      .select("id, title, work_type, status, priority, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .in("status", ["open", "in_progress", "blocked", "deferred"])
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(10);

    const balance = await getOpenBalance(organizationId, clientId);

    return NextResponse.json({
      success: true,
      organizationId,
      patient: {
        id: client.id,
        name: fullName(client),
        preferredName: client.preferred_name,
        dateOfBirth: client.date_of_birth,
        email: client.email,
        phone: client.phone,
        pronouns: client.pronouns,
      },
      insurance: {
        policies: policies ?? [],
        latestEligibility: eligibility ?? null,
      },
      balance,
      encounters: encounters ?? [],
      workqueueItems: workqueueItems ?? [],
    });
  } catch (error) {
    console.error("Patient summary API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Patient summary failed" },
      { status: 500 },
    );
  }
}
