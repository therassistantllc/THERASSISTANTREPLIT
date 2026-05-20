// File: lib/clearinghouse/ClearinghouseService.ts
import { MockClearinghouseAdapter } from "@/lib/clearinghouse/MockClearinghouseAdapter";
import { createServerSupabaseAdminClient as createServerSupabaseAdminClient } from "@/lib/supabase/server";
import type {
  ClaimStatusCheck,
  ClaimStatusRequestInput,
  ClearinghouseConnection,
  ClearinghouseResponseEvent,
  EdiTransaction,
  EligibilityCheck,
  EligibilityRequestInput,
} from "@/types/clearinghouse";

interface AppPatient {
  id: string;
  organization_id: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface InsurancePolicy {
  id: string;
  organization_id: string;
  client_id: string;
  payer_id?: string | null;
  plan_name?: string | null;
  subscriber_id?: string | null;
  policy_number?: string | null;
}

interface AppClaim {
  id: string;
  organization_id: string;
  client_id?: string | null;
  encounter_id?: string | null;
  insurance_policy_id?: string | null;
  claim_status?: string | null;
  total_charge_amount?: number | string | null;
  provider_id?: string | null;
  created_at?: string | null;
  date_of_service_from?: string | null;
}

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function patientName(patient: AppPatient) {
  return [patient.first_name, patient.last_name].filter(Boolean).join(" ") || patient.id;
}

async function getActiveConnection(organizationId: string): Promise<ClearinghouseConnection | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from("clearinghouse_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as ClearinghouseConnection | null) ?? null;
}

async function insertTransaction(transaction: Partial<EdiTransaction>) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;
  const { patient_id: _unusedPatientId, ...safeTransaction } = transaction as Partial<EdiTransaction> & {
    patient_id?: string | null;
  };
  const payload = {
    id: uuid(),
    request_payload: {},
    response_payload: {},
    parsed_summary: {},
    created_at: new Date().toISOString(),
    ...safeTransaction,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await supabase.from("edi_transactions").insert(payload as any).select("*").maybeSingle();
  return data as EdiTransaction | null;
}

async function insertEvent(event: Partial<ClearinghouseResponseEvent>) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;
  const payload = {
    id: uuid(),
    raw_codes: {},
    is_resolved: false,
    severity: "info",
    created_at: new Date().toISOString(),
    ...event,
  };
  const { data } = await supabase.from("clearinghouse_response_events").insert(payload).select("*").maybeSingle();
  return data as ClearinghouseResponseEvent | null;
}

export class ClearinghouseService {
  private adapter = new MockClearinghouseAdapter();

  async runEligibility(input: {
    patientId: string;
    appointmentId?: string | null;
    insurancePolicyId?: string | null;
    serviceTypeCode?: string;
  }) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    const patientResp = await supabase.from("clients").select("*").eq("id", input.patientId).maybeSingle();
    if (patientResp.error || !patientResp.data) {
      throw new Error("Patient not found.");
    }

    const patient = patientResp.data as AppPatient;
    const organizationId = patient.organization_id;

    const connection = (await getActiveConnection(organizationId)) ?? {
      id: uuid(),
      organization_id: organizationId,
      vendor: "mock",
      mode: "test",
      is_active: true,
    };

    let policy: InsurancePolicy | null = null;
    if (input.insurancePolicyId) {
      const policyResp = await supabase.from("insurance_policies").select("*").eq("id", input.insurancePolicyId).maybeSingle();
      if (policyResp.error || !policyResp.data) {
        throw new Error("Insurance policy not found.");
      }
      policy = policyResp.data as InsurancePolicy;
    } else {
      const policyResp = await supabase
        .from("insurance_policies")
        .select("*")
        .eq("client_id", patient.id)
        .eq("active_flag", true)
        .order("priority", { ascending: true })
        .limit(1)
        .maybeSingle();
      policy = (policyResp.data as InsurancePolicy | null) ?? null;
    }

    if (!policy) {
      throw new Error("Missing patient insurance.");
    }
    if (!policy.payer_id) {
      throw new Error("Missing payer ID.");
    }
    if (!policy.subscriber_id && !policy.policy_number) {
      throw new Error("Missing subscriber/member ID.");
    }

    const adapterInput: EligibilityRequestInput = {
      organizationId,
      patientId: patient.id,
      appointmentId: input.appointmentId ?? null,
      insurancePolicyId: policy.id,
      clearinghouseConnectionId: connection.id,
      payerId: policy.payer_id,
      payerName: policy.plan_name ?? "Mock Payer",
      memberId: policy.subscriber_id ?? policy.policy_number ?? null,
      subscriberName: patientName(patient),
      patientName: patientName(patient),
      serviceTypeCode: input.serviceTypeCode ?? "98",
    };

    const outbound = await insertTransaction({
      organization_id: organizationId,
      client_id: patient.id,
      appointment_id: input.appointmentId ?? null,
      clearinghouse_connection_id: connection.id,
      transaction_type: "270",
      direction: "outbound",
      status: "created",
      request_payload: adapterInput as unknown as Record<string, unknown>,
      sent_at: new Date().toISOString(),
    });

    const result = await this.adapter.runEligibility270(adapterInput);

    const inbound = await insertTransaction({
      organization_id: organizationId,
      client_id: patient.id,
      appointment_id: input.appointmentId ?? null,
      clearinghouse_connection_id: connection.id,
      transaction_type: "271",
      direction: "inbound",
      status: "parsed",
      control_number: result.controlNumber,
      correlation_id: result.correlationId,
      request_payload: adapterInput as unknown as Record<string, unknown>,
      response_payload: result.normalized.rawBenefits ?? {},
      raw_request: result.rawRequest,
      raw_response: result.rawResponse,
      parsed_summary: result.normalized as unknown as Record<string, unknown>,
      sent_at: outbound?.sent_at ?? new Date().toISOString(),
      received_at: new Date().toISOString(),
    });

    if (outbound) {
      await supabase
        .from("edi_transactions")
        .update({
          control_number: result.controlNumber,
          correlation_id: result.correlationId,
          raw_request: result.rawRequest,
          status: "sent",
          request_payload: adapterInput as unknown as Record<string, unknown>,
        })
        .eq("id", outbound.id);
    }

    const eligibilityPayload = {
      id: uuid(),
      organization_id: organizationId,
      client_id: patient.id,
      appointment_id: input.appointmentId ?? null,
      insurance_policy_id: policy.id,
      clearinghouse_connection_id: connection.id,
      edi_270_transaction_id: outbound?.id ?? null,
      edi_271_transaction_id: inbound?.id ?? null,
      payer_name: result.normalized.payerName ?? null,
      payer_id: result.normalized.payerId ?? null,
      service_type_code: result.normalized.serviceTypeCode ?? "98",
      eligibility_status: result.normalized.status,
      plan_name: result.normalized.planName ?? null,
      member_id: result.normalized.memberId ?? null,
      subscriber_name: result.normalized.subscriberName ?? null,
      effective_date: result.normalized.effectiveDate ?? null,
      termination_date: result.normalized.terminationDate ?? null,
      copay_amount: result.normalized.copayAmount ?? null,
      deductible_total: result.normalized.deductibleTotal ?? null,
      deductible_remaining: result.normalized.deductibleRemaining ?? null,
      coinsurance_percent: result.normalized.coinsurancePercent ?? null,
      out_of_pocket_remaining: result.normalized.outOfPocketRemaining ?? null,
      coverage_level: result.normalized.coverageLevel ?? null,
      raw_benefits: result.normalized.rawBenefits ?? {},
      checked_at: new Date().toISOString(),
    };

    const eligibilityResp = await supabase
      .from("eligibility_checks")
      .insert(eligibilityPayload)
      .select("*")
      .single();

    if (eligibilityResp.error) {
      throw new Error(eligibilityResp.error.message);
    }

    await insertEvent({
      organization_id: organizationId,
      client_id: patient.id,
      edi_transaction_id: inbound?.id ?? outbound?.id ?? null,
      event_type: "eligibility_result",
      severity: result.normalized.status === "active" ? "info" : result.normalized.status === "inactive" ? "warning" : "error",
      source: "clearinghouse",
      title: `Eligibility ${result.normalized.status}`,
      message: result.normalized.message ?? "Eligibility check completed.",
      normalized_code: result.normalized.status,
      raw_codes: {
        serviceTypeCode: result.normalized.serviceTypeCode ?? "98",
      },
    });

    return {
      latest: eligibilityResp.data as EligibilityCheck,
      normalized: result.normalized,
    };
  }

  async getPatientEligibility(patientId: string) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    const { data, error } = await supabase
      .from("eligibility_checks")
      .select("*")
      .eq("client_id", patientId)
      .order("checked_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const history = (data ?? []) as EligibilityCheck[];
    return {
      latest: history[0] ?? null,
      history,
    };
  }

  async runClaimStatus(input: { claimId: string }) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    const claimResp = await supabase.from("claims").select("*").eq("id", input.claimId).maybeSingle();
    if (claimResp.error || !claimResp.data) {
      throw new Error("Claim not found.");
    }

    const claim = claimResp.data as AppClaim;
    const organizationId = claim.organization_id;

    const connection = (await getActiveConnection(organizationId)) ?? {
      id: uuid(),
      organization_id: organizationId,
      vendor: "mock",
      mode: "test",
      is_active: true,
    };

    let policy: InsurancePolicy | null = null;
    if (claim.insurance_policy_id) {
      const policyResp = await supabase.from("insurance_policies").select("*").eq("id", claim.insurance_policy_id).maybeSingle();
      policy = (policyResp.data as InsurancePolicy | null) ?? null;
    }

    const adapterInput: ClaimStatusRequestInput = {
      organizationId,
      claimId: claim.id,
      patientId: claim.client_id ?? null,
      clearinghouseConnectionId: connection.id,
      payerId: policy?.payer_id ?? null,
      payerName: policy?.plan_name ?? "Mock Payer",
      claimAmount: typeof claim.total_charge_amount === "number" ? claim.total_charge_amount : Number.parseFloat(String(claim.total_charge_amount ?? "0")) || 0,
      memberId: policy?.subscriber_id ?? policy?.policy_number ?? null,
      currentClaimStatus: claim.claim_status ?? null,
      dateOfService: claim.date_of_service_from ?? null,
    };

    const outbound = await insertTransaction({
      organization_id: organizationId,
      client_id: claim.client_id ?? null,
      encounter_id: claim.encounter_id ?? null,
      claim_id: claim.id,
      clearinghouse_connection_id: connection.id,
      transaction_type: "276",
      direction: "outbound",
      status: "created",
      request_payload: adapterInput as unknown as Record<string, unknown>,
      sent_at: new Date().toISOString(),
    });

    const result = await this.adapter.runClaimStatus276(adapterInput);

    const inbound = await insertTransaction({
      organization_id: organizationId,
      client_id: claim.client_id ?? null,
      encounter_id: claim.encounter_id ?? null,
      claim_id: claim.id,
      clearinghouse_connection_id: connection.id,
      transaction_type: "277",
      direction: "inbound",
      status: "parsed",
      control_number: result.controlNumber,
      correlation_id: result.correlationId,
      request_payload: adapterInput as unknown as Record<string, unknown>,
      response_payload: result.normalized.rawStatus ?? {},
      raw_request: result.rawRequest,
      raw_response: result.rawResponse,
      parsed_summary: result.normalized as unknown as Record<string, unknown>,
      sent_at: outbound?.sent_at ?? new Date().toISOString(),
      received_at: new Date().toISOString(),
    });

    if (outbound) {
      await supabase
        .from("edi_transactions")
        .update({
          control_number: result.controlNumber,
          correlation_id: result.correlationId,
          raw_request: result.rawRequest,
          status: "sent",
          request_payload: adapterInput as unknown as Record<string, unknown>,
        })
        .eq("id", outbound.id);
    }

    const checkPayload = {
      id: uuid(),
      organization_id: organizationId,
      claim_id: claim.id,
      client_id: claim.client_id ?? undefined,
      clearinghouse_connection_id: connection.id,
      edi_276_transaction_id: outbound?.id ?? null,
      edi_277_transaction_id: inbound?.id ?? null,
      payer_name: result.normalized.payerName ?? null,
      payer_id: result.normalized.payerId ?? null,
      inquiry_status: result.normalized.status,
      status_category_code: result.normalized.statusCategoryCode ?? null,
      status_code: result.normalized.statusCode ?? null,
      entity_code: result.normalized.entityCode ?? null,
      billed_amount: result.normalized.billedAmount ?? null,
      paid_amount: result.normalized.paidAmount ?? null,
      check_eft_number: result.normalized.checkEftNumber ?? null,
      finalized_date: result.normalized.finalizedDate ?? null,
      raw_status: result.normalized.rawStatus ?? {},
      received_at: new Date().toISOString(),
    };

    const checkResp = await supabase
      .from("claim_status_inquiries")
      .insert(checkPayload)
      .select("*")
      .single();

    if (checkResp.error) {
      throw new Error(checkResp.error.message);
    }

    const nextClaimStatus =
      result.normalized.status === "paid"
        ? "paid"
        : result.normalized.status === "denied"
        ? "denied"
        : result.normalized.status === "rejected"
        ? "rejected"
        : result.normalized.status === "pending"
        ? "pending"
        : claim.claim_status ?? "submitted";

    await supabase
      .from("claims")
      .update({
        claim_status: nextClaimStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claim.id);

    await insertEvent({
      organization_id: organizationId,
      claim_id: claim.id,
      client_id: claim.client_id ?? null,
      edi_transaction_id: inbound?.id ?? outbound?.id ?? null,
      event_type:
        result.normalized.status === "denied"
          ? "denial"
          : result.normalized.status === "paid"
          ? "payment"
          : "status_update",
      severity:
        result.normalized.status === "denied"
          ? "error"
          : result.normalized.status === "pending"
          ? "warning"
          : "info",
      source: "payer",
      title: `Claim status ${result.normalized.status}`,
      message: result.normalized.payerMessage ?? "Claim status check completed.",
      normalized_code: result.normalized.statusCode ?? result.normalized.status,
      raw_codes: {
        statusCategoryCode: result.normalized.statusCategoryCode ?? null,
        entityCode: result.normalized.entityCode ?? null,
      },
    });

    return {
      latest: checkResp.data as ClaimStatusCheck,
      normalized: result.normalized,
    };
  }

  async getClaimStatusHistory(claimId: string) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    const [checksResp, transactionsResp, eventsResp] = await Promise.all([
      supabase
        .from("claim_status_inquiries")
        .select("*")
        .eq("claim_id", claimId)
        .order("received_at", { ascending: false }),
      supabase
        .from("edi_transactions")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false }),
      supabase
        .from("clearinghouse_response_events")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false }),
    ]);

    if (checksResp.error) throw new Error(checksResp.error.message);
    if (transactionsResp.error) throw new Error(transactionsResp.error.message);
    if (eventsResp.error) throw new Error(eventsResp.error.message);

    return {
      checks: (checksResp.data ?? []) as ClaimStatusCheck[],
      transactions: (transactionsResp.data ?? []) as EdiTransaction[],
      events: (eventsResp.data ?? []) as ClearinghouseResponseEvent[],
    };
  }

  async getTransactions(filters: Record<string, string | null | undefined>) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    let query = supabase.from("edi_transactions").select("*").order("created_at", { ascending: false }).limit(200);

    const clientFilter = filters.client_id ?? filters.patient_id;
    if (filters.transaction_type) query = query.eq("transaction_type", filters.transaction_type);
    if (clientFilter) query = query.eq("client_id", clientFilter);
    if (filters.claim_id) query = query.eq("claim_id", filters.claim_id);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.date_from) query = query.gte("created_at", filters.date_from);
    if (filters.date_to) query = query.lte("created_at", filters.date_to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as EdiTransaction[];
  }

  async getEvents(filters: Record<string, string | null | undefined>) {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for clearinghouse server routes.");
    }

    let query = supabase
      .from("clearinghouse_response_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (filters.unresolved_only === "true") query = query.eq("is_resolved", false);
    if (filters.event_type) query = query.eq("event_type", filters.event_type);
    if (filters.severity) query = query.eq("severity", filters.severity);
    if (filters.claim_id) query = query.eq("claim_id", filters.claim_id);
    const clientFilter = filters.client_id ?? filters.patient_id;
    if (clientFilter) query = query.eq("client_id", clientFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as ClearinghouseResponseEvent[];
  }
}
