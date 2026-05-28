import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    const { data: charge, error } = await supabase
      .from("charge_capture_items")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle();
    if (error || !charge) {
      return NextResponse.json({ success: false, error: "Charge not found" }, { status: 404 });
    }

    const [clientRes, providerRes, policyRes, apptRes, encRes, eligRes] = await Promise.all([
      charge.client_id
        ? supabase.from("clients").select("id, first_name, last_name, date_of_birth, mrn").eq("id", charge.client_id).maybeSingle()
        : Promise.resolve({ data: null }),
      charge.provider_id
        ? supabase.from("providers").select("id, display_name, first_name, last_name, credential, npi").eq("id", charge.provider_id).maybeSingle()
        : Promise.resolve({ data: null }),
      charge.insurance_policy_id
        ? supabase.from("insurance_policies").select("id, payer_id, plan_name, policy_number, subscriber_id, copay_amount, deductible_amount, coinsurance_percent, priority").eq("id", charge.insurance_policy_id).maybeSingle()
        : Promise.resolve({ data: null }),
      charge.appointment_id
        ? (supabase as any).from("appointments").select("id, appointment_type, appointment_status, scheduled_start_at, scheduled_end_at, cpt_code, memo").eq("id", charge.appointment_id).maybeSingle()
        : Promise.resolve({ data: null }),
      charge.encounter_id
        ? (supabase as any).from("encounters").select("id, encounter_status, required_billing_fields_complete, session_summary, started_at, ended_at, case_id").eq("id", charge.encounter_id).maybeSingle()
        : Promise.resolve({ data: null }),
      charge.client_id
        ? (supabase as any)
            .from("eligibility_checks")
            .select("id, eligibility_status, checked_at, authorization_required, raw_status_text, copay_amount, deductible_remaining")
            .eq("organization_id", organizationId)
            .eq("client_id", charge.client_id)
            .is("archived_at", null)
            .order("checked_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const client = clientRes.data as DbRow | null;
    const provider = providerRes.data as DbRow | null;
    const policy = policyRes.data as DbRow | null;
    const appointment = (apptRes as { data: DbRow | null }).data;
    const encounter = (encRes as { data: DbRow | null }).data;
    const eligibility = (eligRes as { data: DbRow | null }).data;

    let payer: { id: string; name: string; payerType: string | null } | null = null;
    if (policy?.payer_id) {
      const { data: p } = await supabase.from("insurance_payers").select("id, payer_name, payer_category").eq("id", policy.payer_id).maybeSingle();
      if (p) payer = { id: text(p.id), name: text(p.payer_name), payerType: (p.payer_category as string) ?? null };
    }

    const serviceLines = Array.isArray(charge.service_lines) ? (charge.service_lines as DbRow[]) : [];
    const diagnoses = Array.isArray(charge.diagnosis_codes) ? (charge.diagnosis_codes as unknown[]).map(text).filter(Boolean) : [];

    const detail = {
      id: text(charge.id),
      organizationId: text(charge.organization_id),
      status: text(charge.charge_status) || "unknown",
      serviceDate: charge.service_date ?? null,
      placeOfService: text(charge.place_of_service) || null,
      totalCharge: num(charge.total_charge),
      claimId: charge.claim_id ?? null,
      appointmentId: charge.appointment_id ?? null,
      encounterId: charge.encounter_id ?? null,
      blockerReasons: Array.isArray(charge.blocker_reasons) ? charge.blocker_reasons : [],
      updatedAt: charge.updated_at ?? null,
      client: client
        ? {
            id: text(client.id),
            firstName: text(client.first_name),
            lastName: text(client.last_name),
            displayName: [client.first_name, client.last_name].map(text).filter(Boolean).join(", "),
            dateOfBirth: client.date_of_birth ?? null,
            accountNumber: text(client.mrn) || null,
          }
        : null,
      provider: provider
        ? {
            id: text(provider.id),
            displayName: text(provider.display_name) || [provider.first_name, provider.last_name].map(text).filter(Boolean).join(" "),
            credential: text(provider.credential) || null,
            npi: text(provider.npi) || null,
          }
        : null,
      payer,
      policy: policy
        ? {
            id: text(policy.id),
            planName: text(policy.plan_name) || null,
            policyNumber: text(policy.policy_number) || null,
            subscriberId: text(policy.subscriber_id) || null,
            copay: num(policy.copay_amount),
            deductible: num(policy.deductible_amount),
            coinsurancePercent: num(policy.coinsurance_percent),
            priority: text(policy.priority) || null,
          }
        : null,
      diagnoses,
      appointment: appointment
        ? {
            id: text(appointment.id),
            type: text(appointment.appointment_type) || null,
            status: text(appointment.appointment_status) || null,
            startAt: (appointment.scheduled_start_at as string | null) ?? null,
            endAt: (appointment.scheduled_end_at as string | null) ?? null,
            cptCode: text(appointment.cpt_code) || null,
            memo: text(appointment.memo) || null,
          }
        : null,
      encounter: encounter
        ? {
            id: text(encounter.id),
            status: text(encounter.encounter_status) || null,
            billingFieldsComplete: Boolean(encounter.required_billing_fields_complete),
            sessionSummary: text(encounter.session_summary) || null,
            startedAt: (encounter.started_at as string | null) ?? null,
            endedAt: (encounter.ended_at as string | null) ?? null,
            caseId: (encounter.case_id as string | null) ?? null,
          }
        : null,
      eligibility: eligibility
        ? {
            status: text(eligibility.eligibility_status) || null,
            checkedAt: (eligibility.checked_at as string | null) ?? null,
            authorizationRequired: Boolean(eligibility.authorization_required),
            rawStatusText: text(eligibility.raw_status_text) || null,
            copay: num(eligibility.copay_amount),
            deductibleRemaining: num(eligibility.deductible_remaining),
          }
        : null,
      serviceLines: serviceLines.map((line, idx) => ({
        lineNumber: idx + 1,
        procedureCode: text(line.procedureCode),
        serviceDateFrom: text(line.serviceDate) || charge.service_date || null,
        serviceDateTo: text(line.serviceDateTo) || text(line.serviceDate) || charge.service_date || null,
        modifiers: Array.isArray(line.modifiers) ? (line.modifiers as unknown[]).map(text).filter(Boolean) : [],
        diagnosisPointers: Array.isArray(line.diagnosisPointers) ? (line.diagnosisPointers as unknown[]).map(text).filter(Boolean) : ["1"],
        units: Number(line.units ?? 1) || 1,
        unitOfMeasure: text(line.unitOfMeasure) || "UN",
        chargeAmount: num(line.chargeAmount),
        placeOfService: text(line.placeOfService) || text(charge.place_of_service) || null,
        renderingProviderNpi: text(line.renderingProviderNpi) || (provider ? text(provider.npi) : null),
        authorizationNumber: text(line.authorizationNumber) || null,
      })),
    };

    return NextResponse.json({ success: true, detail });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

interface SaveBody {
  diagnoses?: string[];
  serviceLines?: Array<{
    procedureCode?: string;
    serviceDateFrom?: string;
    serviceDateTo?: string;
    modifiers?: string[];
    diagnosisPointers?: string[];
    units?: number;
    chargeAmount?: number;
    placeOfService?: string | null;
    renderingProviderNpi?: string | null;
    authorizationNumber?: string | null;
  }>;
  placeOfService?: string | null;
  serviceDate?: string | null;
  /**
   * Status transition action. Maps to allowed values on
   * charge_capture_items.charge_status (captured, ready_for_claim,
   * blocked, voided). Used by the row/detail Approve / Hold /
   * Route-back buttons in the Charge Capture workqueue.
   */
  action?: "approve" | "hold" | "route_back";
  actionReason?: string;
}

const ACTION_TO_STATUS: Record<NonNullable<SaveBody["action"]>, string> = {
  approve: "ready_for_claim",
  hold: "blocked",
  route_back: "blocked",
};

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database not available" }, { status: 500 });

    const body = (await request.json().catch(() => ({}))) as SaveBody;

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    // ── Status transition (approve / hold / route-back) ─────────────────
    // Handled before any code validation so a biller can hold/route a
    // charge that currently has bad codes without first fixing them.
    if (body.action) {
      const targetStatus = ACTION_TO_STATUS[body.action];
      if (!targetStatus) {
        return NextResponse.json({ success: false, error: `Unknown action: ${body.action}` }, { status: 400 });
      }
      update.charge_status = targetStatus;
      if (body.action === "hold" || body.action === "route_back") {
        const label = body.action === "hold" ? "Held by biller" : "Routed back to clinician";
        const reason = (body.actionReason ?? "").trim();
        const entry = {
          field: body.action,
          message: reason ? `${label}: ${reason}` : label,
          at: new Date().toISOString(),
        };
        const { data: existing } = await supabase
          .from("charge_capture_items")
          .select("blocker_reasons")
          .eq("organization_id", organizationId)
          .eq("id", id)
          .is("archived_at", null)
          .maybeSingle();
        const prior = Array.isArray(existing?.blocker_reasons) ? (existing!.blocker_reasons as unknown[]) : [];
        update.blocker_reasons = [...prior, entry];
      } else if (body.action === "approve") {
        // Clearing blockers on approve keeps the next step (release)
        // from re-tripping over stale hold notes.
        update.blocker_reasons = [];
      }
    }

    let computedTotal: number | null = null;
    if (Array.isArray(body.serviceLines)) {
      const cleaned = body.serviceLines
        .map((line) => {
          const procedureCode = String(line.procedureCode ?? "").trim();
          const units = Number(line.units ?? 1) || 1;
          const chargeAmount = num(line.chargeAmount);
          const serviceDate = line.serviceDateFrom || body.serviceDate || null;
          if (!procedureCode) return null;
          return {
            procedureCode,
            serviceDate,
            serviceDateTo: line.serviceDateTo || serviceDate,
            modifiers: Array.isArray(line.modifiers) ? line.modifiers.map((m) => String(m).trim()).filter(Boolean) : [],
            diagnosisPointers: Array.isArray(line.diagnosisPointers) && line.diagnosisPointers.length
              ? line.diagnosisPointers.map((p) => String(p).trim()).filter(Boolean)
              : ["1"],
            units,
            chargeAmount,
            placeOfService: line.placeOfService ? String(line.placeOfService) : (body.placeOfService ?? null),
            renderingProviderNpi: line.renderingProviderNpi ? String(line.renderingProviderNpi) : null,
            authorizationNumber: line.authorizationNumber ? String(line.authorizationNumber) : null,
          };
        })
        .filter((l): l is NonNullable<typeof l> => l !== null);
      update.service_lines = cleaned;
      computedTotal = cleaned.reduce((sum, l) => sum + l.chargeAmount * l.units, 0);
      update.total_charge = Math.round(computedTotal * 100) / 100;
    }

    if (Array.isArray(body.diagnoses)) {
      update.diagnosis_codes = body.diagnoses.map((d) => String(d).trim()).filter(Boolean);
    }

    // Reference-table validation: reject unknown ICD-10 / CPT / HCPCS codes
    // so saved charges never carry codes that the claim scrubber can't bill.
    const dxToCheck = Array.isArray(update.diagnosis_codes) ? (update.diagnosis_codes as string[]) : [];
    const procToCheck = Array.isArray(update.service_lines)
      ? (update.service_lines as Array<{ procedureCode: string }>)
          .map((l) => String(l.procedureCode ?? "").trim().toUpperCase())
          .filter(Boolean)
      : [];

    const codeErrors: Array<{ field: string; message: string }> = [];

    if (dxToCheck.length) {
      const upperDx = dxToCheck.map((c) => c.toUpperCase());
      const { data: dxRows, error: dxErr } = await supabase
        .from("diagnosis_codes")
        .select("code")
        .eq("is_active", true)
        .in("code", upperDx);
      if (dxErr) return NextResponse.json({ success: false, error: dxErr.message }, { status: 500 });
      const known = new Set((dxRows ?? []).map((r: { code: string }) => String(r.code).toUpperCase()));
      const unknown = upperDx.filter((c) => !known.has(c));
      for (const c of unknown) {
        codeErrors.push({ field: "diagnosis_codes", message: `Unknown ICD-10 code: ${c}` });
      }
    }

    if (procToCheck.length) {
      const { data: pxRows, error: pxErr } = await supabase
        .from("procedure_codes")
        .select("code")
        .eq("is_active", true)
        .in("code", procToCheck);
      if (pxErr) return NextResponse.json({ success: false, error: pxErr.message }, { status: 500 });
      const known = new Set((pxRows ?? []).map((r: { code: string }) => String(r.code).toUpperCase()));
      const unknown = [...new Set(procToCheck)].filter((c) => !known.has(c));
      for (const c of unknown) {
        codeErrors.push({ field: "service_lines.procedure_code", message: `Unknown CPT/HCPCS code: ${c}` });
      }
    }

    if (codeErrors.length) {
      return NextResponse.json(
        { success: false, error: codeErrors.map((e) => e.message).join("; "), errors: codeErrors },
        { status: 422 },
      );
    }

    if (body.placeOfService !== undefined) {
      update.place_of_service = body.placeOfService ? String(body.placeOfService) : null;
    }
    if (body.serviceDate !== undefined) {
      update.service_date = body.serviceDate || null;
    }

    const { data, error } = await supabase
      .from("charge_capture_items")
      .update(update)
      .eq("organization_id", organizationId)
      .eq("id", id)
      .is("archived_at", null)
      .select("id, total_charge, service_lines, diagnosis_codes, place_of_service, service_date")
      .maybeSingle();

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    if (!data) return NextResponse.json({ success: false, error: "Charge not found" }, { status: 404 });

    return NextResponse.json({ success: true, charge: data });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
