import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export type CaseType =
  | "commercial"
  | "medicaid"
  | "medicare"
  | "workers_comp"
  | "charity"
  | "self_pay"
  | "other";

export type PolicyPriority = "primary" | "secondary" | "tertiary";

export const CASE_TYPES: CaseType[] = [
  "commercial",
  "medicaid",
  "medicare",
  "workers_comp",
  "charity",
  "self_pay",
  "other",
];

export const PATIENT_RESPONSIBILITY_CASE_TYPES: CaseType[] = [
  "self_pay",
  "charity",
];

interface ClientCasePolicySummary {
  id: string;
  policyId: string;
  priority: PolicyPriority;
  planName: string | null;
  payerName: string | null;
  payerId: string | null;
  policyNumber: string | null;
  activeFlag: boolean;
}

export interface ClientCaseRecord {
  id: string;
  organizationId: string;
  clientId: string;
  name: string;
  caseType: CaseType;
  notes: string | null;
  activeFlag: boolean;
  isDefault: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  policies: ClientCasePolicySummary[];
}

export interface CaseValidationError {
  field: string;
  message: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function dbRowToCase(row: DbRow, policies: ClientCasePolicySummary[]): ClientCaseRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    clientId: String(row.client_id),
    name: String(row.name ?? ""),
    caseType: (row.case_type ?? "commercial") as CaseType,
    notes: row.notes ?? null,
    activeFlag: Boolean(row.active_flag ?? true),
    isDefault: Boolean(row.is_default ?? false),
    archivedAt: row.archived_at ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    policies,
  };
}

export function isPatientResponsibilityCaseType(caseType: CaseType | string | null | undefined): boolean {
  if (!caseType) return false;
  return PATIENT_RESPONSIBILITY_CASE_TYPES.includes(caseType as CaseType);
}

async function loadCasePolicies(caseIds: string[]): Promise<Map<string, ClientCasePolicySummary[]>> {
  const map = new Map<string, ClientCasePolicySummary[]>();
  if (caseIds.length === 0) return map;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return map;

  const { data, error } = await supabase
    .from("client_case_policies")
    .select(
      `id, case_id, policy_id, priority,
       insurance_policies:policy_id (id, plan_name, policy_number, active_flag, payer_id,
         insurance_payers:payer_id (payer_name, payer_id))`,
    )
    .in("case_id", caseIds);

  if (error || !data) return map;

  for (const row of data as DbRow[]) {
    const policyRow = (row.insurance_policies ?? {}) as DbRow;
    const payerRow = (policyRow.insurance_payers ?? {}) as DbRow;
    const summary: ClientCasePolicySummary = {
      id: String(row.id),
      policyId: String(row.policy_id),
      priority: row.priority as PolicyPriority,
      planName: policyRow.plan_name ?? null,
      payerName: payerRow.payer_name ?? null,
      payerId: payerRow.payer_id ?? null,
      policyNumber: policyRow.policy_number ?? null,
      activeFlag: Boolean(policyRow.active_flag ?? true),
    };
    const caseId = String(row.case_id);
    const arr = map.get(caseId) ?? [];
    arr.push(summary);
    map.set(caseId, arr);
  }

  for (const list of map.values()) {
    list.sort((a, b) => {
      const order: Record<PolicyPriority, number> = { primary: 1, secondary: 2, tertiary: 3 };
      return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
    });
  }

  return map;
}

export async function listCasesForClient(params: {
  organizationId: string;
  clientId: string;
  includeArchived?: boolean;
}): Promise<ClientCaseRecord[]> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return [];

  let query = supabase
    .from("client_cases")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("client_id", params.clientId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });

  if (!params.includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error || !data) return [];

  const ids = data.map((r) => String(r.id));
  const policies = await loadCasePolicies(ids);
  return data.map((row) => dbRowToCase(row, policies.get(String(row.id)) ?? []));
}

export async function getCaseById(params: {
  organizationId: string;
  caseId: string;
}): Promise<ClientCaseRecord | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("client_cases")
    .select("*")
    .eq("id", params.caseId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();

  if (error || !data) return null;
  const policies = await loadCasePolicies([params.caseId]);
  return dbRowToCase(data, policies.get(params.caseId) ?? []);
}

export async function getDefaultCaseForClient(params: {
  organizationId: string;
  clientId: string;
}): Promise<ClientCaseRecord | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from("client_cases")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("client_id", params.clientId)
    .eq("is_default", true)
    .is("archived_at", null)
    .maybeSingle();

  if (!data) return null;
  const policies = await loadCasePolicies([String(data.id)]);
  return dbRowToCase(data, policies.get(String(data.id)) ?? []);
}

export interface CreateCaseInput {
  organizationId: string;
  clientId: string;
  name: string;
  caseType?: CaseType;
  notes?: string | null;
  activeFlag?: boolean;
  isDefault?: boolean;
}

export async function createCase(input: CreateCaseInput): Promise<
  { ok: true; case: ClientCaseRecord } | { ok: false; errors: CaseValidationError[] }
> {
  const errors: CaseValidationError[] = [];
  if (!normalizeText(input.organizationId)) errors.push({ field: "organization_id", message: "Organization is required" });
  if (!normalizeText(input.clientId)) errors.push({ field: "client_id", message: "Client is required" });
  if (!normalizeText(input.name)) errors.push({ field: "name", message: "Case name is required" });
  const caseType = (input.caseType ?? "commercial") as CaseType;
  if (!CASE_TYPES.includes(caseType)) errors.push({ field: "case_type", message: "Invalid case type" });
  if (errors.length > 0) return { ok: false, errors };

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, errors: [{ field: "system", message: "Database connection not available" }] };

  if (input.isDefault) {
    await supabase
      .from("client_cases")
      .update({ is_default: false })
      .eq("organization_id", input.organizationId)
      .eq("client_id", input.clientId)
      .eq("is_default", true)
      .is("archived_at", null);
  }

  // Auto-promote to default when this is the client's first case.
  let isDefault = Boolean(input.isDefault);
  if (!isDefault) {
    const { data: existing } = await supabase
      .from("client_cases")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("client_id", input.clientId)
      .is("archived_at", null)
      .limit(1);
    if (!existing || existing.length === 0) isDefault = true;
  }

  const { data, error } = await supabase
    .from("client_cases")
    .insert({
      organization_id: input.organizationId,
      client_id: input.clientId,
      name: normalizeText(input.name),
      case_type: caseType,
      notes: input.notes ?? null,
      active_flag: input.activeFlag ?? true,
      is_default: isDefault,
    })
    .select("*")
    .single();

  if (error || !data) return { ok: false, errors: [{ field: "client_cases", message: error?.message ?? "Failed to create case" }] };
  return { ok: true, case: dbRowToCase(data, []) };
}

export interface UpdateCaseInput {
  organizationId: string;
  caseId: string;
  name?: string;
  caseType?: CaseType;
  notes?: string | null;
  activeFlag?: boolean;
  isDefault?: boolean;
}

export async function updateCase(input: UpdateCaseInput): Promise<
  { ok: true; case: ClientCaseRecord } | { ok: false; errors: CaseValidationError[] }
> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, errors: [{ field: "system", message: "Database connection not available" }] };

  const { data: existing } = await supabase
    .from("client_cases")
    .select("id, client_id")
    .eq("id", input.caseId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!existing) return { ok: false, errors: [{ field: "case_id", message: "Case not found" }] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};
  if (typeof input.name === "string") {
    const n = normalizeText(input.name);
    if (!n) return { ok: false, errors: [{ field: "name", message: "Case name is required" }] };
    patch.name = n;
  }
  if (input.caseType) {
    if (!CASE_TYPES.includes(input.caseType)) return { ok: false, errors: [{ field: "case_type", message: "Invalid case type" }] };
    patch.case_type = input.caseType;
  }
  if ("notes" in input) patch.notes = input.notes ?? null;
  if (typeof input.activeFlag === "boolean") patch.active_flag = input.activeFlag;

  if (input.isDefault === true) {
    await supabase
      .from("client_cases")
      .update({ is_default: false })
      .eq("organization_id", input.organizationId)
      .eq("client_id", existing.client_id)
      .eq("is_default", true)
      .is("archived_at", null);
    patch.is_default = true;
  } else if (input.isDefault === false) {
    patch.is_default = false;
  }

  if (Object.keys(patch).length === 0) {
    const fresh = await getCaseById({ organizationId: input.organizationId, caseId: input.caseId });
    return fresh ? { ok: true, case: fresh } : { ok: false, errors: [{ field: "case_id", message: "Case not found" }] };
  }

  const { error } = await supabase
    .from("client_cases")
    .update(patch)
    .eq("id", input.caseId)
    .eq("organization_id", input.organizationId);
  if (error) return { ok: false, errors: [{ field: "client_cases", message: error.message }] };

  const fresh = await getCaseById({ organizationId: input.organizationId, caseId: input.caseId });
  return fresh ? { ok: true, case: fresh } : { ok: false, errors: [{ field: "case_id", message: "Case not found after update" }] };
}

export async function archiveCase(params: {
  organizationId: string;
  caseId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  const { error } = await supabase
    .from("client_cases")
    .update({ archived_at: new Date().toISOString(), is_default: false, active_flag: false })
    .eq("id", params.caseId)
    .eq("organization_id", params.organizationId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function attachPolicyToCase(params: {
  organizationId: string;
  caseId: string;
  policyId: string;
  priority: PolicyPriority;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  // Validate policy exists in this org & belongs to the same client as the case.
  const { data: caseRow } = await supabase
    .from("client_cases")
    .select("id, client_id, organization_id")
    .eq("id", params.caseId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();
  if (!caseRow) return { ok: false, error: "Case not found" };

  const { data: policyRow } = await supabase
    .from("insurance_policies")
    .select("id, client_id, organization_id")
    .eq("id", params.policyId)
    .eq("organization_id", params.organizationId)
    .is("archived_at", null)
    .maybeSingle();
  if (!policyRow) return { ok: false, error: "Insurance policy not found" };
  if (String(policyRow.client_id) !== String(caseRow.client_id)) {
    return { ok: false, error: "Policy belongs to a different client" };
  }

  // Upsert by (case_id, policy_id). If the priority slot is taken by another
  // policy, return a clear error rather than silently breaking the unique
  // constraint.
  const { data: existingAtPriority } = await supabase
    .from("client_case_policies")
    .select("id, policy_id")
    .eq("case_id", params.caseId)
    .eq("priority", params.priority)
    .maybeSingle();

  if (existingAtPriority && String(existingAtPriority.policy_id) !== params.policyId) {
    return { ok: false, error: `Another policy is already attached as ${params.priority}` };
  }

  const { error } = await supabase
    .from("client_case_policies")
    .upsert(
      {
        organization_id: params.organizationId,
        case_id: params.caseId,
        policy_id: params.policyId,
        priority: params.priority,
      },
      { onConflict: "case_id,policy_id" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function detachPolicyFromCase(params: {
  organizationId: string;
  caseId: string;
  policyId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  const { error } = await supabase
    .from("client_case_policies")
    .delete()
    .eq("case_id", params.caseId)
    .eq("policy_id", params.policyId)
    .eq("organization_id", params.organizationId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function reorderCasePolicies(params: {
  organizationId: string;
  caseId: string;
  ordered: Array<{ policyId: string; priority: PolicyPriority }>;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  const seenPriority = new Set<string>();
  const seenPolicy = new Set<string>();
  for (const { policyId, priority } of params.ordered) {
    if (seenPriority.has(priority)) return { ok: false, error: `Duplicate priority ${priority}` };
    if (seenPolicy.has(policyId)) return { ok: false, error: "Duplicate policy in ordering" };
    seenPriority.add(priority);
    seenPolicy.add(policyId);
  }

  // Two-phase: clear priorities to a temporary slot first to avoid colliding
  // with the (case_id, priority) unique index, then write the desired ones.
  // Easier: delete all attachments and re-insert in the requested order.
  const { error: delError } = await supabase
    .from("client_case_policies")
    .delete()
    .eq("case_id", params.caseId)
    .eq("organization_id", params.organizationId);
  if (delError) return { ok: false, error: delError.message };

  if (params.ordered.length === 0) return { ok: true };

  const rows = params.ordered.map((r) => ({
    organization_id: params.organizationId,
    case_id: params.caseId,
    policy_id: r.policyId,
    priority: r.priority,
  }));
  const { error: insError } = await supabase.from("client_case_policies").insert(rows);
  if (insError) return { ok: false, error: insError.message };
  return { ok: true };
}

// ── Move claim to another case ────────────────────────────────────────────────

export interface MoveClaimToCaseInput {
  organizationId: string;
  claimId: string;
  targetCaseId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  reason?: string | null;
}

export interface MoveClaimToCaseResult {
  ok: boolean;
  error?: string;
  previousCaseId?: string | null;
  newPayerProfileId?: string | null;
}

/**
 * Re-tag a professional_claim onto a different case, swapping its billed
 * payer to the target case's primary policy/payer. Self-pay / charity cases
 * are allowed (the claim is moved but no payer profile is required — the
 * caller should void / write off the claim separately).
 *
 * Writes an audit_logs row of action='claim_moved_to_case' with before/after.
 */
export async function moveClaimToCase(input: MoveClaimToCaseInput): Promise<MoveClaimToCaseResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { ok: false, error: "Database connection not available" };

  const { data: claim } = await supabase
    .from("professional_claims")
    .select("id, organization_id, patient_id, case_id, payer_profile_id, claim_status")
    .eq("id", input.claimId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!claim) return { ok: false, error: "Claim not found" };

  const targetCase = await getCaseById({
    organizationId: input.organizationId,
    caseId: input.targetCaseId,
  });
  if (!targetCase) return { ok: false, error: "Target case not found" };
  if (targetCase.archivedAt) return { ok: false, error: "Target case is archived" };
  if (String(targetCase.clientId) !== String(claim.patient_id)) {
    return { ok: false, error: "Target case belongs to a different client" };
  }

  const isPatientResp = isPatientResponsibilityCaseType(targetCase.caseType);
  if (!isPatientResp) {
    const primaryPolicy = targetCase.policies.find((p) => p.priority === "primary");
    if (!primaryPolicy) {
      return { ok: false, error: "Target case has no primary insurance policy. Attach one before moving the claim." };
    }
  }

  // Resolve a payer_profile_id for the new case (commercial path only).
  let newPayerProfileId: string | null = null;
  if (!isPatientResp) {
    const primaryPolicy = targetCase.policies.find((p) => p.priority === "primary")!;
    // Load full policy + payer to look up / create the payer_profile.
    const { data: policyFull } = await supabase
      .from("insurance_policies")
      .select("id, payer_id, insurance_payers:payer_id (payer_name, payer_id)")
      .eq("id", primaryPolicy.policyId)
      .maybeSingle();

    const payerRow = ((policyFull ?? {}) as DbRow).insurance_payers ?? {};
    const availityPayerId = normalizeText(payerRow.payer_id);
    const payerName = normalizeText(payerRow.payer_name);
    if (availityPayerId && payerName) {
      const { data: existingProfile } = await supabase
        .from("payer_profiles")
        .select("id")
        .eq("organization_id", input.organizationId)
        .eq("availity_payer_id", availityPayerId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      if (existingProfile?.id) {
        newPayerProfileId = String(existingProfile.id);
      } else {
        const { data: inserted } = await supabase
          .from("payer_profiles")
          .insert({
            organization_id: input.organizationId,
            payer_name: payerName,
            availity_payer_id: availityPayerId,
            payer_type: "commercial",
            is_active: true,
          })
          .select("id")
          .single();
        newPayerProfileId = inserted?.id ? String(inserted.id) : null;
      }
    }
  }

  const previousCaseId = claim.case_id ? String(claim.case_id) : null;
  const previousPayerProfileId = claim.payer_profile_id ? String(claim.payer_profile_id) : null;

  const { error: updateError } = await supabase
    .from("professional_claims")
    .update({
      case_id: input.targetCaseId,
      payer_profile_id: isPatientResp ? null : newPayerProfileId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.claimId)
    .eq("organization_id", input.organizationId);
  if (updateError) return { ok: false, error: updateError.message };

  // Best-effort audit (do not fail the move if audit insert errors).
  await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    claim_id: input.claimId,
    user_id: input.actorUserId ?? null,
    user_role: input.actorRole ?? null,
    action: "claim_moved_to_case",
    object_type: "professional_claim",
    object_id: input.claimId,
    event_type: "claim_moved_to_case",
    event_summary: input.reason ?? `Claim moved to case ${targetCase.name}`,
    before_value: {
      case_id: previousCaseId,
      payer_profile_id: previousPayerProfileId,
    },
    after_value: {
      case_id: input.targetCaseId,
      payer_profile_id: isPatientResp ? null : newPayerProfileId,
      case_type: targetCase.caseType,
    },
    event_metadata: {
      target_case_name: targetCase.name,
      target_case_type: targetCase.caseType,
      reason: input.reason ?? null,
    },
  });

  return {
    ok: true,
    previousCaseId,
    newPayerProfileId,
  };
}

/**
 * Resolve the billed policy for a given case. Returns the primary policy id
 * if the case has one; null for self-pay / charity (no insurance claim).
 */
export async function resolveCaseBillingPolicy(params: {
  organizationId: string;
  caseId: string;
}): Promise<
  | { kind: "insurance"; policyId: string }
  | { kind: "patient_responsibility"; caseType: CaseType }
  | { kind: "missing"; reason: string }
> {
  const c = await getCaseById({ organizationId: params.organizationId, caseId: params.caseId });
  if (!c) return { kind: "missing", reason: "Case not found" };
  if (isPatientResponsibilityCaseType(c.caseType)) {
    return { kind: "patient_responsibility", caseType: c.caseType };
  }
  const primary = c.policies.find((p) => p.priority === "primary");
  if (!primary) return { kind: "missing", reason: "Case has no primary insurance policy" };
  return { kind: "insurance", policyId: primary.policyId };
}
