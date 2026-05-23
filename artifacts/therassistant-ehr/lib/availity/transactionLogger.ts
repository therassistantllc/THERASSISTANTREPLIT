import "server-only";

import { createServerSupabaseAdminClient as createServerSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Sensitive key patterns to redact from headers and request/response bodies
 * Normalized patterns (lowercase, no hyphens/underscores/spaces)
 */
const SENSITIVE_PATTERNS = [
  "authorization",
  "bearer",
  "clientsecret",
  "clientid", // only in credential context
  "secret",
  "password",
  "token",
  "apikey",
  "accesstoken",
  "refreshtoken",
];

/**
 * Normalize a key for sensitivity checking by removing formatting characters
 * and converting to lowercase
 */
function normalizeKeyForSensitivityCheck(key: string): string {
  return key
    .toLowerCase()
    .replace(/[-_\s]/g, ""); // Remove hyphens, underscores, spaces
}

/**
 * Check if a normalized key matches any sensitive pattern
 */
function isSensitiveKey(normalizedKey: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) =>
    normalizedKey.includes(pattern)
  );
}

/**
 * Sanitize headers by removing sensitive values
 */
function sanitizeHeaders(
  headers?: Record<string, string | string[]>
): Record<string, string | string[]> | null {
  if (!headers || Object.keys(headers).length === 0) {
    return null;
  }

  const sanitized: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = normalizeKeyForSensitivityCheck(key);
    const isSensitive = isSensitiveKey(normalizedKey);

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize request or response body by removing sensitive fields
 */
function sanitizeBody(body?: unknown): unknown {
  if (!body) {
    return null;
  }

  if (typeof body === "string") {
    // Try to parse as JSON if needed, but keep as string otherwise
    if (body.startsWith("{") || body.startsWith("[")) {
      try {
        return sanitizeObject(JSON.parse(body));
      } catch {
        // If parsing fails, return string as-is (safe for logging)
        return body;
      }
    }
    return body;
  }

  if (typeof body === "object" && body !== null) {
    return sanitizeObject(body);
  }

  return body;
}

/**
 * Recursively sanitize an object by removing sensitive keys
 */
function sanitizeObject(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const normalizedKey = normalizeKeyForSensitivityCheck(key);
    const isSensitive = isSensitiveKey(normalizedKey);

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Create transaction type definition
 */
interface CreateTransactionLogInput {
  organizationId?: string;
  patientId?: string;
  encounterId?: string;
  claimId?: string;
  payerId?: string;
  payerName?: string;
  transactionType:
    | "eligibility_270"
    | "eligibility_271"
    | "claim_status_276"
    | "claim_status_277"
    | "claim_submission_837p"
    | "era_835"
    | "payer_list"
    | "enrollment"
    | "enrollment_status"
    | "diagnostics"
    | "token_test"
    | "other";
  transactionDirection?: "outbound" | "inbound" | "internal";
  environment?: "demo" | "production" | "sandbox" | "test";
  requestMethod?: string;
  requestUrl?: string;
  requestHeaders?: Record<string, string | string[]>;
  requestBody?: unknown;
  correlationId?: string;
  createdBy?: string;
}

/**
 * Create a new Availity transaction log entry
 */
export async function createAvailityTransactionLog(
  input: CreateTransactionLogInput
): Promise<string | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    console.warn("Availity transaction log: Supabase client not available");
    return null;
  }

  const now = new Date().toISOString();

  const sanitizedHeaders = sanitizeHeaders(input.requestHeaders);
  const sanitizedBody = sanitizeBody(input.requestBody);

  const { data, error } = await supabase
    .from("availity_transactions")
    .insert({
      organization_id: input.organizationId || null,
      patient_id: input.patientId || null,
      encounter_id: input.encounterId || null,
      claim_id: input.claimId || null,
      payer_id: input.payerId || null,
      payer_name: input.payerName || null,
      transaction_type: input.transactionType,
      transaction_direction: input.transactionDirection || "outbound",
      environment: input.environment || "demo",
      status: "created",
      request_method: input.requestMethod || null,
      request_url: input.requestUrl || null,
      request_headers_safe: sanitizedHeaders,
      request_body_safe: sanitizedBody,
      started_at: now,
      created_by: input.createdBy || null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to create Availity transaction log:", error);
    return null;
  }

  return data?.id ? String(data.id) : null;
}

interface UpdateTransactionLogInput {
  transactionId: string;
  status?: "pending" | "sent" | "received" | "completed" | "failed" | "cancelled";
  responseStatus?: number;
  responseHeaders?: Record<string, string | string[]>;
  responseBody?: unknown;
  externalTransactionId?: string;
}

/**
 * Update an existing Availity transaction log entry
 */
async function updateAvailityTransactionLog(
  input: UpdateTransactionLogInput
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    console.warn("Availity transaction log: Supabase client not available");
    return false;
  }

  const now = new Date().toISOString();

  const sanitizedHeaders = input.responseHeaders
    ? sanitizeHeaders(input.responseHeaders)
    : null;
  const sanitizedBody = input.responseBody
    ? sanitizeBody(input.responseBody)
    : null;

  const { error } = await supabase
    .from("availity_transactions")
    .update({
      status: input.status || undefined,
      response_status: input.responseStatus || null,
      response_headers_safe: sanitizedHeaders,
      response_body_safe: sanitizedBody,
      external_transaction_id: input.externalTransactionId || null,
      updated_at: now,
    })
    .eq("id", input.transactionId);

  if (error) {
    console.error("Failed to update Availity transaction log:", error);
    return false;
  }

  return true;
}

interface CompleteTransactionLogInput {
  transactionId: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string | string[]>;
  responseBody?: unknown;
  externalTransactionId?: string;
}

/**
 * Mark an Availity transaction as completed successfully
 */
export async function completeAvailityTransactionLog(
  input: CompleteTransactionLogInput
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    console.warn("Availity transaction log: Supabase client not available");
    return false;
  }

  const now = new Date().toISOString();

  const sanitizedHeaders = input.responseHeaders
    ? sanitizeHeaders(input.responseHeaders)
    : null;
  const sanitizedBody = input.responseBody
    ? sanitizeBody(input.responseBody)
    : null;

  const { error } = await supabase
    .from("availity_transactions")
    .update({
      status: "completed",
      response_status: input.responseStatus || null,
      response_headers_safe: sanitizedHeaders,
      response_body_safe: sanitizedBody,
      external_transaction_id: input.externalTransactionId || null,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", input.transactionId);

  if (error) {
    console.error("Failed to complete Availity transaction log:", error);
    return false;
  }

  return true;
}

interface FailTransactionLogInput {
  transactionId: string;
  errorMessage: string;
  errorType?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string | string[]>;
  responseBody?: unknown;
}

/**
 * Mark an Availity transaction as failed
 */
export async function failAvailityTransactionLog(
  input: FailTransactionLogInput
): Promise<boolean> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    console.warn("Availity transaction log: Supabase client not available");
    return false;
  }

  const now = new Date().toISOString();

  const sanitizedHeaders = input.responseHeaders
    ? sanitizeHeaders(input.responseHeaders)
    : null;
  const sanitizedBody = input.responseBody
    ? sanitizeBody(input.responseBody)
    : null;

  const { error } = await supabase
    .from("availity_transactions")
    .update({
      status: "failed",
      error_message: input.errorMessage,
      error_type: input.errorType || null,
      response_status: input.responseStatus || null,
      response_headers_safe: sanitizedHeaders,
      response_body_safe: sanitizedBody,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", input.transactionId);

  if (error) {
    console.error("Failed to mark Availity transaction as failed:", error);
    return false;
  }

  return true;
}
