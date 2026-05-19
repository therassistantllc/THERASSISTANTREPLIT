import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type ImportRowRecord = {
  id: string;
  row_number: number;
  mapped_data: Record<string, unknown> | null;
  validation_errors: unknown;
  import_status: string;
  duplicate_match_client_id: string | null;
  source_client_id: string | null;
};

type PromotionJob = {
  id: string;
  organization_id: string | null;
  source_system: string;
  status: string;
};

export interface PromoteClientImportRowsOptions {
  jobId: string;
  importDuplicates?: boolean;
  allowUpdateExisting?: boolean;
}

export interface PromoteClientImportRowsResult {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  promoted: number;
  skipped: number;
  failed: number;
  failedRows: Array<{ rowNumber: number; error: string }>;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeIsoDate(value: unknown): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  return normalized;
}

function normalizeNullable(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter((entry) => entry.length > 0);
  }
  return [];
}

function appendError(existing: unknown, message: string): string[] {
  const previous = asStringArray(existing);
  return [...previous, message];
}

async function ensurePayerId(
  organizationId: string,
  payerName: string,
  sourceSystem: string,
  sourceClientId: string | null
): Promise<string | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const normalizedPayerName = normalizeText(payerName);
  if (!normalizedPayerName) return null;

  const { data: existingPayer } = await supabase
    .from("insurance_payers")
    .select("id")
    .eq("organization_id", organizationId)
    .ilike("payer_name", normalizedPayerName)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (existingPayer?.id) {
    return existingPayer.id;
  }

  const payerPayload = {
    organization_id: organizationId,
    payer_name: normalizedPayerName,
    payer_id: sourceClientId ? `${sourceSystem}:${sourceClientId}` : `import:${normalizedPayerName}`,
  };

  const { data: insertedPayer, error: insertPayerError } = await supabase
    .from("insurance_payers")
    .insert(payerPayload)
    .select("id")
    .single();

  if (insertPayerError || !insertedPayer) {
    return null;
  }

  return insertedPayer.id;
}

async function ensureSubscriberId(params: {
  organizationId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  memberId: string;
  groupNumber: string | null;
}): Promise<string | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  if (!params.firstName || !params.lastName || !params.memberId) return null;
  // date_of_birth is NOT NULL on insurance_subscribers
  if (!params.dateOfBirth) return null;

  const { data: existing } = await supabase
    .from("insurance_subscribers")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("member_id", params.memberId)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { data: inserted, error } = await supabase
    .from("insurance_subscribers")
    .insert({
      organization_id: params.organizationId,
      first_name: params.firstName,
      last_name: params.lastName,
      date_of_birth: params.dateOfBirth,
      relationship_to_client: "self",
      member_id: params.memberId,
      group_number: params.groupNumber ?? undefined,
    })
    .select("id")
    .single();

  if (error || !inserted) return null;
  return inserted.id;
}

async function ensurePrimaryInsurancePolicy(params: {
  organizationId: string | null;
  clientId: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  payerName: string | null;
  memberId: string | null;
  groupId: string | null;
  policyNumber: string | null;
  sourceSystem: string;
  sourceClientId: string | null;
}): Promise<string | null> {
  if (!params.organizationId) return null;
  if (!params.payerName && !params.memberId && !params.policyNumber) return null;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const payerId = params.payerName
    ? await ensurePayerId(
        params.organizationId,
        params.payerName,
        params.sourceSystem,
        params.sourceClientId
      )
    : null;

  if (!payerId) return null;

  const subscriberId = params.memberId
    ? await ensureSubscriberId({
        organizationId: params.organizationId,
        firstName: params.firstName ?? "",
        lastName: params.lastName ?? "",
        dateOfBirth: params.dateOfBirth,
        memberId: params.memberId,
        groupNumber: params.groupId,
      })
    : null;

  if (!subscriberId) return null;

  const { data: existingPolicy } = await supabase
    .from("insurance_policies")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("client_id", params.clientId)
    .eq("priority", "primary")
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  if (existingPolicy?.id) {
    return existingPolicy.id;
  }

  const today = new Date().toISOString().split("T")[0];

  const policyPayload = {
    organization_id: params.organizationId,
    client_id: params.clientId,
    payer_id: payerId,
    subscriber_id: subscriberId,
    plan_name: normalizeNullable(params.payerName),
    policy_number: normalizeNullable(params.policyNumber) ?? normalizeNullable(params.groupId) ?? normalizeNullable(params.memberId),
    priority: "primary" as const,
    active_flag: true,
    effective_date: today,
  };

  const { data: insertedPolicy, error: insertPolicyError } = await supabase
    .from("insurance_policies")
    .insert(policyPayload)
    .select("id")
    .single();

  if (insertPolicyError || !insertedPolicy) {
    return null;
  }

  return insertedPolicy.id;
}

async function updateExistingClientConservatively(params: {
  clientId: string;
  mappedData: Record<string, unknown>;
}): Promise<void> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) throw new Error("Database connection not available");

  const { data: existingClient, error: existingClientError } = await supabase
    .from("clients")
    .select(
      "id, first_name, last_name, date_of_birth, email, phone, address_line_1, address_line_2, city, state, postal_code"
    )
    .eq("id", params.clientId)
    .single();

  if (existingClientError || !existingClient) {
    throw new Error("Failed to load existing duplicate client");
  }

  const fields: Array<{ key: string; incoming: string | null }> = [
    { key: "first_name", incoming: normalizeNullable(params.mappedData.first_name) },
    { key: "last_name", incoming: normalizeNullable(params.mappedData.last_name) },
    { key: "date_of_birth", incoming: normalizeIsoDate(params.mappedData.date_of_birth) },
    { key: "email", incoming: normalizeNullable(params.mappedData.email) },
    { key: "phone", incoming: normalizeNullable(params.mappedData.phone) },
    { key: "address_line_1", incoming: normalizeNullable(params.mappedData.address_line1) },
    { key: "address_line_2", incoming: normalizeNullable(params.mappedData.address_line2) },
    { key: "city", incoming: normalizeNullable(params.mappedData.city) },
    { key: "state", incoming: normalizeNullable(params.mappedData.state) },
    { key: "postal_code", incoming: normalizeNullable(params.mappedData.postal_code) },
  ];

  const updatePayload: Record<string, unknown> = {};
  for (const field of fields) {
    const current = normalizeNullable((existingClient as Record<string, unknown>)[field.key]);
    if (!current && field.incoming) {
      updatePayload[field.key] = field.incoming;
    }
  }

  if (Object.keys(updatePayload).length === 0) {
    return;
  }

  updatePayload.updated_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("clients")
    .update(updatePayload)
    .eq("id", params.clientId);

  if (updateError) {
    throw new Error(updateError.message || "Failed to update existing client");
  }
}

export async function promoteClientImportRows(
  options: PromoteClientImportRowsOptions
): Promise<PromoteClientImportRowsResult> {
  const { jobId, importDuplicates = false, allowUpdateExisting = false } = options;

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    throw new Error("Database connection not available");
  }

  const { data: job, error: jobError } = await supabase
    .from("client_import_jobs")
    .select("id, organization_id, source_system, status")
    .eq("id", jobId)
    .single();

  if (jobError || !job) {
    throw new Error("Import job not found");
  }

  const typedJob = job as PromotionJob;
  if (typedJob.status !== "validated" && typedJob.status !== "importing") {
    throw new Error(`Job status is ${typedJob.status}, expected 'validated'`);
  }

  const { data: allRows, error: rowsError } = await supabase
    .from("client_import_rows")
    .select(
      "id, row_number, mapped_data, validation_errors, import_status, duplicate_match_client_id, source_client_id"
    )
    .eq("import_job_id", jobId)
    .order("row_number", { ascending: true });

  if (rowsError || !allRows) {
    throw new Error("Failed to fetch rows for import");
  }

  const rows = allRows as unknown as ImportRowRecord[];

  await supabase
    .from("client_import_jobs")
    .update({ status: "importing", updated_at: new Date().toISOString() })
    .eq("id", jobId);

  const summary: PromoteClientImportRowsResult = {
    total: rows.length,
    valid: rows.filter((row) => row.import_status === "valid").length,
    invalid: rows.filter((row) => row.import_status === "invalid").length,
    duplicates: rows.filter((row) => row.import_status === "duplicate").length,
    promoted: 0,
    skipped: 0,
    failed: 0,
    failedRows: [],
  };

  for (const row of rows) {
    const mappedData = (row.mapped_data ?? {}) as Record<string, unknown>;

    if (row.import_status === "invalid" || row.import_status === "pending") {
      summary.skipped += 1;
      continue;
    }

    if (row.import_status === "duplicate" && !importDuplicates) {
      summary.skipped += 1;
      await supabase
        .from("client_import_rows")
        .update({
          import_status: "skipped",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      continue;
    }

    const sourceClientId = normalizeNullable(mappedData.source_client_id) ?? row.source_client_id;
    const sourceRef = sourceClientId ? `${typedJob.source_system}:${sourceClientId}` : null;

    try {
      let promotedClientId: string | null = null;

      if (row.import_status === "duplicate" && row.duplicate_match_client_id) {
        if (!allowUpdateExisting) {
          summary.skipped += 1;
          await supabase
            .from("client_import_rows")
            .update({
              import_status: "skipped",
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          continue;
        }

        promotedClientId = row.duplicate_match_client_id;
        await updateExistingClientConservatively({
          clientId: promotedClientId,
          mappedData,
        });
      } else {
        const clientPayload: Record<string, unknown> = {
          organization_id: typedJob.organization_id,
          first_name: normalizeNullable(mappedData.first_name),
          last_name: normalizeNullable(mappedData.last_name),
          middle_name: normalizeNullable(mappedData.middle_name),
          preferred_name: normalizeNullable(mappedData.preferred_name),
          date_of_birth: normalizeIsoDate(mappedData.date_of_birth),
          email: normalizeNullable(mappedData.email),
          phone: normalizeNullable(mappedData.phone),
          mrn: normalizeNullable(mappedData.mrn),
          sex_at_birth: normalizeNullable(mappedData.sex_at_birth),
          gender_identity: normalizeNullable(mappedData.gender_identity),
          pronouns: normalizeNullable(mappedData.pronouns),
          preferred_language: normalizeNullable(mappedData.preferred_language),
          address_line_1: normalizeNullable(mappedData.address_line1),
          address_line_2: normalizeNullable(mappedData.address_line2),
          city: normalizeNullable(mappedData.city),
          state: normalizeNullable(mappedData.state),
          postal_code: normalizeNullable(mappedData.postal_code),
          external_client_ref: sourceRef,
          updated_at: new Date().toISOString(),
        };

        const { data: insertedClient, error: insertClientError } = await supabase
          .from("clients")
          .insert(clientPayload)
          .select("id")
          .single();

        if (insertClientError || !insertedClient) {
          throw new Error(insertClientError?.message ?? "Failed to insert client");
        }

        promotedClientId = insertedClient.id;
      }

      if (!promotedClientId) {
        throw new Error("Client promotion produced no target client id");
      }

      const promotedPolicyId = await ensurePrimaryInsurancePolicy({
        organizationId: typedJob.organization_id,
        clientId: promotedClientId,
        firstName: normalizeNullable(mappedData.first_name),
        lastName: normalizeNullable(mappedData.last_name),
        dateOfBirth: normalizeIsoDate(mappedData.date_of_birth),
        payerName: normalizeNullable(mappedData.primary_insurance_name),
        memberId: normalizeNullable(mappedData.primary_member_id),
        groupId: normalizeNullable(mappedData.primary_group_id),
        policyNumber: normalizeNullable(mappedData.primary_policy_number),
        sourceSystem: typedJob.source_system,
        sourceClientId,
      });

      const { error: rowUpdateError } = await supabase
        .from("client_import_rows")
        .update({
          imported_client_id: promotedClientId,
          promoted_policy_id: promotedPolicyId,
          source_client_id: sourceClientId,
          import_status: "imported",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (rowUpdateError) {
        throw new Error("Failed to update imported row status");
      }

      summary.promoted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown row import error";
      summary.failed += 1;
      summary.failedRows.push({
        rowNumber: row.row_number,
        error: message,
      });

      await supabase
        .from("client_import_rows")
        .update({
          import_status: "failed",
          validation_errors: appendError(row.validation_errors, message),
          promotion_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  }

  const promotionSummary = {
    total: summary.total,
    valid: summary.valid,
    invalid: summary.invalid,
    duplicates: summary.duplicates,
    promoted: summary.promoted,
    skipped: summary.skipped,
    failed: summary.failed,
    promotedAt: new Date().toISOString(),
  };

  await supabase
    .from("client_import_jobs")
    .update({
      status: "completed",
      imported_rows: summary.promoted,
      promotion_summary: promotionSummary,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  return summary;
}
