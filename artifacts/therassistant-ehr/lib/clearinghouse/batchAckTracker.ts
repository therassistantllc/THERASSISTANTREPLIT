// File: lib/clearinghouse/batchAckTracker.ts
//
// Batch 999 expectation tracker.
//
// CAQH CORE Eligibility & Benefits Infrastructure Rule vEB.2.0 §3.2.2
// requires batch 270 submitters to receive a 999 within 24 hours of
// submission. The 837P transport already records batch submit time on
// public.edi_batches.submitted_at and links acks via
// public.edi_acknowledgements.edi_batch_id. The migration
// 20260522010000_eligibility_ack_sla.sql defines a view
// public.edi_batch_ack_status that derives the per-batch ack window
// state. This module is the typed read API for that view.

import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export type BatchAckWindowStatus = "received" | "pending" | "overdue" | "not_submitted";

export interface BatchAckStatus {
  ediBatchId: string;
  organizationId: string;
  transactionType: string;
  batchStatus: string;
  submittedAt: string | null;
  ackReceivedAt: string | null;
  ackType: "999" | null;
  ackWindowStatus: BatchAckWindowStatus;
  /** Wall-clock hours since the batch was submitted. Null when not yet submitted. */
  hoursSinceSubmit: number | null;
}

interface BatchAckRow {
  edi_batch_id: string;
  organization_id: string;
  transaction_type: string;
  batch_status: string;
  submitted_at: string | null;
  ack_received_at: string | null;
  ack_type: string | null;
  ack_window_status: string;
  hours_since_submit: number | string | null;
}

function toFloat(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeWindow(value: string | null | undefined): BatchAckWindowStatus {
  switch (value) {
    case "received":
    case "pending":
    case "overdue":
    case "not_submitted":
      return value;
    default:
      return "pending";
  }
}

function toBatchAckStatus(row: BatchAckRow): BatchAckStatus {
  return {
    ediBatchId: row.edi_batch_id,
    organizationId: row.organization_id,
    transactionType: row.transaction_type,
    batchStatus: row.batch_status,
    submittedAt: row.submitted_at,
    ackReceivedAt: row.ack_received_at,
    ackType: row.ack_type === "999" ? "999" : null,
    ackWindowStatus: normalizeWindow(row.ack_window_status),
    hoursSinceSubmit: toFloat(row.hours_since_submit),
  };
}

/**
 * Return every batch whose 999 is overdue (>24h since submit, no ack
 * received). Scoped to one organization. Sorted oldest-overdue-first
 * so the operations dashboard can show the worst offenders at the top.
 */
export async function listOverdueBatchAcks(opts: {
  organizationId: string;
  transactionTypes?: string[];
  limit?: number;
}): Promise<BatchAckStatus[]> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to query batch acknowledgement state.");
  }
  let query = supabase
    .from("edi_batch_ack_status")
    .select("*")
    .eq("organization_id", opts.organizationId)
    .eq("ack_window_status", "overdue")
    .order("submitted_at", { ascending: true });

  if (opts.transactionTypes && opts.transactionTypes.length > 0) {
    query = query.in("transaction_type", opts.transactionTypes);
  }
  if (opts.limit && opts.limit > 0) {
    query = query.limit(opts.limit);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load overdue batch acks: ${error.message}`);
  }
  return ((data ?? []) as BatchAckRow[]).map(toBatchAckStatus);
}

/**
 * Look up a single batch's 999 ack window state. Returns null when the
 * batch does not exist or does not belong to the supplied organization.
 *
 * `organizationId` is REQUIRED — this helper uses the service-role
 * Supabase client (which bypasses RLS), so callers must enforce tenant
 * isolation here. Do not relax this signature.
 */
export async function getBatchAckStatus(opts: {
  organizationId: string;
  ediBatchId: string;
}): Promise<BatchAckStatus | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to query batch acknowledgement state.");
  }
  if (!opts.organizationId) {
    throw new Error("organizationId is required to look up batch acknowledgement state.");
  }
  const { data, error } = await supabase
    .from("edi_batch_ack_status")
    .select("*")
    .eq("edi_batch_id", opts.ediBatchId)
    .eq("organization_id", opts.organizationId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load batch ack status: ${error.message}`);
  }
  return data ? toBatchAckStatus(data as BatchAckRow) : null;
}

/**
 * Pure helper for tests and callers that have already loaded the batch
 * row. Returns the same `ack_window_status` value the SQL view does so
 * the two sources cannot drift.
 */
export function computeBatchAckWindow(opts: {
  submittedAt: Date | string | null;
  ackReceivedAt: Date | string | null;
  now?: Date;
  deadlineHours?: number;
}): BatchAckWindowStatus {
  const now = opts.now ?? new Date();
  const deadlineMs = (opts.deadlineHours ?? 24) * 60 * 60 * 1000;
  if (opts.ackReceivedAt) return "received";
  if (!opts.submittedAt) return "not_submitted";
  const submitted = opts.submittedAt instanceof Date ? opts.submittedAt : new Date(opts.submittedAt);
  if (Number.isNaN(submitted.getTime())) return "not_submitted";
  // Match the SQL view: `submitted_at > now() - interval '24 hours'`
  // is pending, otherwise overdue. So at exactly the deadline (>= 24h
  // elapsed) the batch is overdue, not pending.
  return now.getTime() - submitted.getTime() >= deadlineMs ? "overdue" : "pending";
}
