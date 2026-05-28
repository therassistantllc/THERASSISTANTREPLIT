import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
type Row = Record<string, unknown>;

export async function GET(
  request: Request,
  context: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { appointmentId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data: appt, error: apptError } = await supabase
      .from("appointments")
      .select(
        "id, client_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, cpt_code, memo",
      )
      .eq("organization_id", organizationId)
      .eq("id", appointmentId)
      .is("archived_at", null)
      .maybeSingle();

    if (apptError || !appt) {
      return NextResponse.json(
        { success: false, error: "Appointment not found" },
        { status: 404 },
      );
    }

    // CPT still falls back to the legacy heuristic (CPT-shaped string
    // stashed in appointment_type) for rows that predate the dedicated
    // cpt_code column. Memo no longer falls back to reason — historical
    // memos have been backfilled into the memo column.
    const apptTypeRaw =
      typeof (appt as Row).appointment_type === "string"
        ? String((appt as Row).appointment_type)
        : "";
    const cptRaw =
      typeof (appt as Row).cpt_code === "string"
        ? String((appt as Row).cpt_code)
        : "";
    const cpt = cptRaw || (/^9\d{4}$/.test(apptTypeRaw) ? apptTypeRaw : null);
    const memo =
      typeof (appt as Row).memo === "string"
        ? String((appt as Row).memo)
        : "";

    const [clientRes, providerRes, policiesRes, encounterRes] =
      await Promise.all([
        appt.client_id
          ? supabase
              .from("clients")
              .select(
                "id, first_name, last_name, preferred_name, date_of_birth, email, phone",
              )
              .eq("organization_id", organizationId)
              .eq("id", appt.client_id)
              .maybeSingle()
          : Promise.resolve({ data: null as Row | null }),
        appt.provider_id
          ? supabase
              .from("providers")
              .select("id, first_name, last_name, display_name, credential")
              .eq("organization_id", organizationId)
              .eq("id", appt.provider_id)
              .maybeSingle()
          : Promise.resolve({ data: null as Row | null }),
        appt.client_id
          ? supabase
              .from("insurance_policies")
              .select(
                "id, plan_name, policy_number, priority, active_flag, payer_id, effective_date, termination_date",
              )
              .eq("organization_id", organizationId)
              .eq("client_id", appt.client_id)
              .is("archived_at", null)
              .order("priority", { ascending: true })
          : Promise.resolve({ data: [] as Row[] }),
        supabase
          .from("encounters")
          .select("id, encounter_status")
          .eq("organization_id", organizationId)
          .eq("appointment_id", appointmentId)
          .is("archived_at", null)
          .limit(1)
          .maybeSingle(),
      ]);

    const client = (clientRes.data ?? null) as Row | null;
    const provider = (providerRes.data ?? null) as Row | null;
    const policies = (policiesRes.data ?? []) as Row[];
    const primaryPolicy = policies[0] ?? null;

    let payer: Row | null = null;
    if (primaryPolicy?.payer_id) {
      const { data: payerRow } = await supabase
        .from("insurance_payers")
        .select("id, payer_name, payer_id")
        .eq("organization_id", organizationId)
        .eq("id", primaryPolicy.payer_id)
        .is("archived_at", null)
        .maybeSingle();
      payer = (payerRow ?? null) as Row | null;
    }

    // Latest eligibility — scoped to the appointment's primary policy so
    // we don't show a status that belongs to a different payer.
    let eligibility: Row | null = null;
    if (appt.client_id && primaryPolicy?.id) {
      const { data: elig } = await supabase
        .from("eligibility_checks")
        .select(
          "id, eligibility_status, checked_at, copay_amount, deductible_remaining, insurance_policy_id",
        )
        .eq("organization_id", organizationId)
        .eq("client_id", appt.client_id)
        .eq("insurance_policy_id", primaryPolicy.id)
        .is("archived_at", null)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      eligibility = (elig ?? null) as Row | null;
    }

    // Derive display status: Active / Inactive / Unknown / Stale / not_checked
    const STALE_MS = 30 * 24 * 60 * 60 * 1000;
    let displayStatus: "active" | "inactive" | "unknown" | "stale" | "not_checked" =
      "not_checked";
    let asOf: string | null = null;
    if (eligibility) {
      asOf = (eligibility.checked_at as string | null) ?? null;
      const raw = String(eligibility.eligibility_status ?? "").toLowerCase();
      const isStale =
        asOf !== null && Date.now() - new Date(asOf).getTime() > STALE_MS;
      if (raw === "active" || raw === "eligible") displayStatus = "active";
      else if (raw === "inactive" || raw === "ineligible")
        displayStatus = "inactive";
      else if (raw === "not_checked" || raw === "" || raw === "pending")
        displayStatus = asOf ? "unknown" : "not_checked";
      else displayStatus = "unknown";
      if (isStale && displayStatus !== "not_checked") displayStatus = "stale";
    }

    // Open client balance
    let openBalance = 0;
    if (appt.client_id) {
      const { data: invoices } = await supabase
        .from("patient_invoices")
        .select("balance_amount, invoice_status")
        .eq("organization_id", organizationId)
        .eq("client_id", appt.client_id)
        .in("invoice_status", ["open", "sent", "collections"])
        .is("archived_at", null);
      openBalance = ((invoices ?? []) as Row[]).reduce(
        (sum, inv) => sum + Number(inv.balance_amount ?? 0),
        0,
      );
    }

    const clientName = client
      ? [client.first_name, client.last_name].filter(Boolean).join(" ") ||
        "Unknown client"
      : "Unknown client";
    const providerName = provider
      ? String(provider.display_name ?? "").trim() ||
        [provider.first_name, provider.last_name].filter(Boolean).join(" ") ||
        "Unassigned"
      : "Unassigned";

    return NextResponse.json({
      success: true,
      appointment: {
        id: String(appt.id),
        clientId: appt.client_id ? String(appt.client_id) : null,
        clientName,
        providerId: appt.provider_id ? String(appt.provider_id) : null,
        providerName,
        scheduledStartAt: appt.scheduled_start_at,
        scheduledEndAt: appt.scheduled_end_at,
        status: appt.appointment_status,
        appointmentType: appt.appointment_type,
        serviceLocation: null,
        cptCode: cpt,
        memo,
      },
      insurance: {
        primaryPolicy: primaryPolicy
          ? {
              id: String(primaryPolicy.id),
              planName: primaryPolicy.plan_name ?? null,
              policyNumber: primaryPolicy.policy_number ?? null,
              priority: primaryPolicy.priority ?? null,
              payerId: primaryPolicy.payer_id ?? null,
              payerName: payer?.payer_name ?? null,
              payerCode: payer?.payer_id ?? null,
            }
          : null,
      },
      eligibility: eligibility
        ? { ...eligibility, displayStatus, asOf }
        : { displayStatus, asOf: null },
      balance: { openBalance },
      encounter: encounterRes.data ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error:
          err instanceof Error ? err.message : "Failed to load appointment",
      },
      { status: 500 },
    );
  }
}
