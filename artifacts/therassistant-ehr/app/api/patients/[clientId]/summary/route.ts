import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
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
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const FULL_CLIENT_COLS =
      "id, first_name, middle_name, last_name, date_of_birth, email, phone, preferred_name, pronouns, mrn, external_client_ref, sex_at_birth, gender_identity, address_line_1, address_line_2, city, state, postal_code, preferred_language, emergency_contact_name, emergency_contact_phone";
    const BASE_CLIENT_COLS =
      "id, first_name, middle_name, last_name, date_of_birth, email, phone, preferred_name, pronouns, mrn, external_client_ref, sex_at_birth, gender_identity, address_line_1, address_line_2, city, state, postal_code, preferred_language";

    let { data: client, error: clientError } = await supabase
      .from("clients")
      .select(FULL_CLIENT_COLS)
      .eq("organization_id", organizationId)
      .eq("id", clientId)
      .is("archived_at", null)
      .maybeSingle();

    if (clientError) {
      const errCode = (clientError as { code?: string }).code ?? "";
      const errMessage = String((clientError as { message?: string }).message ?? "");
      const missingEmergency =
        (errCode === "42703" || errCode === "PGRST204" || errCode === "PGRST200") &&
        /emergency_contact_(name|phone)/i.test(errMessage);
      if (missingEmergency) {
        console.warn(
          "[client summary] emergency_contact_* columns missing; loading without them.",
        );
        const retry = await supabase
          .from("clients")
          .select(BASE_CLIENT_COLS)
          .eq("organization_id", organizationId)
          .eq("id", clientId)
          .is("archived_at", null)
          .maybeSingle();
        client = retry.data as typeof client;
        clientError = retry.error;
      }
    }

    if (clientError || !client) {
      if (clientError) console.error("[client summary] client lookup failed:", clientError);
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }

    const { data: policiesRaw } = await supabase
      .from("insurance_policies")
      .select(
        "id, plan_name, policy_number, group_number, priority, active_flag, effective_date, termination_date, payer_id, copay_amount, insurance_payers(payer_name)",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("priority", { ascending: true });

    const policies = (policiesRaw ?? []).map((p: DbRow) => {
      const payer = Array.isArray(p.insurance_payers) ? p.insurance_payers[0] : p.insurance_payers;
      return {
        id: p.id,
        plan_name: p.plan_name,
        policy_number: p.policy_number,
        group_number: p.group_number ?? null,
        priority: p.priority,
        active_flag: p.active_flag,
        effective_date: p.effective_date,
        termination_date: p.termination_date,
        payer_id: p.payer_id,
        payer_name: payer?.payer_name ?? null,
        copay_amount: p.copay_amount ?? null,
      };
    });

    const { data: eligibility } = await supabase
      .from("eligibility_checks")
      .select(
        "id, eligibility_status, checked_at, copay_amount, deductible_remaining, coverage_start_date, coverage_end_date, response_summary, benefit_tier, authorization_required, telemedicine_covered",
      )
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

    // Sum unapplied client credits as "Credit on account". The
    // client_credits table may not exist in older environments — treat
    // any error as a zero balance so the Summary card never blows up.
    let creditOnAccount: number | null = null;
    {
      const { data: credits, error: creditsErr } = await supabase
        .from("client_credits")
        .select("balance_amount")
        .eq("organization_id", organizationId)
        .eq("client_id", clientId)
        .is("archived_at", null);
      if (!creditsErr) {
        creditOnAccount = (credits ?? []).reduce(
          (sum: number, row: DbRow) => sum + Number(row.balance_amount ?? 0),
          0,
        );
      }
    }

    return NextResponse.json({
      success: true,
      organizationId,
      client: {
        id: client.id,
        name: fullName(client),
        firstName: client.first_name ?? null,
        middleName: client.middle_name ?? null,
        lastName: client.last_name ?? null,
        preferredName: client.preferred_name,
        dateOfBirth: client.date_of_birth,
        email: client.email,
        phone: client.phone,
        pronouns: client.pronouns,
        mrn: client.mrn ?? null,
        sexAtBirth: client.sex_at_birth ?? null,
        genderIdentity: client.gender_identity ?? null,
        addressLine1: client.address_line_1 ?? null,
        addressLine2: client.address_line_2 ?? null,
        city: client.city ?? null,
        state: client.state ?? null,
        postalCode: client.postal_code ?? null,
        preferredLanguage: client.preferred_language ?? null,
        sourceClientId: client.external_client_ref ?? null,
        emergencyContactName: client.emergency_contact_name ?? null,
        emergencyContactPhone: client.emergency_contact_phone ?? null,
      },
      insurance: {
        policies: policies ?? [],
        latestEligibility: eligibility ?? null,
      },
      balance,
      creditOnAccount,
      encounters: encounters ?? [],
      workqueueItems: workqueueItems ?? [],
    });
  } catch (error) {
    console.error("Client summary API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Client summary failed" },
      { status: 500 },
    );
  }
}
