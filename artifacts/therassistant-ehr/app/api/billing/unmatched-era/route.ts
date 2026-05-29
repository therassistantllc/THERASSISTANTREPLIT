/**
 * GET /api/billing/unmatched-era
 *
 * Powers the Unmatched ERA Claims workqueue. Each row is an
 * `era_claim_payments` line whose `claim_match_status` is unmatched (or whose
 * posting is blocked because matching was unresolved).
 *
 * Joins the parent batch (for payer + check/EFT context), the assisted-match
 * top candidate (for "possible match" + "confidence score" columns), and the
 * matching workqueue_items row when one already exists (for assignment /
 * priority / follow-up state used by the universal filter rail).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { findCandidatesForEraClaimPayment } from "@/lib/payments/assistedMatchingService";

export type UnmatchedEraTabId =
  | "client_match_needed"
  | "claim_number_mismatch"
  | "payer_mismatch"
  | "duplicate_match"
  | "manual_review";

export const UNMATCHED_ERA_TABS: Array<{ id: UnmatchedEraTabId; label: string }> = [
  { id: "client_match_needed", label: "Client Match Needed" },
  { id: "claim_number_mismatch", label: "Claim Number Mismatch" },
  { id: "payer_mismatch", label: "Payer Mismatch" },
  { id: "duplicate_match", label: "Duplicate Match" },
  { id: "manual_review", label: "Manual Review" },
];

type DbRow = Record<string, unknown>;

export interface UnmatchedEraRow {
  id: string;
  eraClaimPaymentId: string;
  eraBatchId: string;
  workqueueItemId: string | null;
  payerProfileId: string | null;
  payerName: string | null;
  payerCheckEft: string | null;
  clientId: string | null;
  clientName: string;
  primaryProviderId: string | null;
  patientName: string;
  claimNumberFromEra: string;
  payerClaimControlNumber: string | null;
  dos: string | null;
  paidAmount: number;
  totalCharge: number;
  patientResponsibility: number;
  reasonUnmatched: string;
  postingStatus: string;
  matchStatus: string;
  receivedAt: string | null;
  agingDays: number | null;
  tab: UnmatchedEraTabId;
  possibleMatch: {
    professionalClaimId: string;
    claimNumber: string | null;
    payerClaimControlNumber: string | null;
    totalCharge: number;
    dateOfServiceFrom: string | null;
    patientDisplayName: string | null;
    strategy: string;
    reasons: string[];
  } | null;
  duplicateCandidateCount: number;
  confidenceScore: number | null;
  candidates: Array<{
    professionalClaimId: string;
    claimNumber: string | null;
    patientDisplayName: string | null;
    dateOfServiceFrom: string | null;
    totalCharge: number;
    confidence: number;
    strategy: string;
    reasons: string[];
  }>;
  assignedTo: string | null;
  priority: string | null;
  followUpDue: string | null;
  status: string | null;
  notes: Array<{
    id: string;
    body: string;
    type: string;
    createdAt: string | null;
    createdBy: string | null;
  }>;
}

function text(v: unknown): string {
  return String(v ?? "").trim();
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function bucketMatch(age: number | null, bucket: string | null): boolean {
  if (!bucket) return true;
  const a = age ?? 0;
  switch (bucket) {
    case "0-7": return a <= 7;
    case "8-30": return a >= 8 && a <= 30;
    case "31-60": return a >= 31 && a <= 60;
    case "60+": return a > 60;
    default: return true;
  }
}

function ciContains(haystack: string | null, needle: string | null): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function firstServiceDate(serviceLines: unknown): string | null {
  if (!Array.isArray(serviceLines)) return null;
  for (const line of serviceLines as Array<Record<string, unknown>>) {
    const v = line?.serviceDate ?? line?.service_date;
    if (typeof v === "string" && /^\d{8}$/.test(v)) {
      return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function patientNameFromRawSegments(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  // Common shapes used elsewhere: nm1Qc { firstName, lastName, middleName }
  // or arrays of { tag, elements: [...] }.
  const obj = raw as Record<string, unknown>;
  const nm1 = (obj.nm1Qc ?? obj.client ?? obj.nm1_qc) as
    | Record<string, unknown>
    | undefined;
  if (nm1) {
    const first = text(nm1.firstName ?? nm1.first_name ?? nm1.given);
    const last = text(nm1.lastName ?? nm1.last_name ?? nm1.family);
    const joined = [first, last].filter(Boolean).join(" ").trim();
    if (joined) return joined;
  }
  if (Array.isArray(obj.segments)) {
    for (const s of obj.segments as Array<Record<string, unknown>>) {
      const tag = text(s.tag).toUpperCase();
      const els = (s.elements as string[] | undefined) ?? [];
      if (tag === "NM1" && els[0] === "QC") {
        const last = text(els[2]);
        const first = text(els[3]);
        const joined = [first, last].filter(Boolean).join(" ").trim();
        if (joined) return joined;
      }
    }
  }
  return null;
}

function classifyTab(args: {
  clientId: string | null;
  payerProfileId: string | null;
  postingStatus: string;
  matchStatus: string;
  duplicateCount: number;
}): UnmatchedEraTabId {
  if (args.duplicateCount > 1) return "duplicate_match";
  if (!args.payerProfileId) return "payer_mismatch";
  if (!args.clientId) return "client_match_needed";
  if (args.postingStatus === "blocked") return "manual_review";
  return "claim_number_mismatch";
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const filter = {
      payer: searchParams.get("payer"),
      client: searchParams.get("client"),
      status: searchParams.get("status"),
      dosFrom: searchParams.get("dosFrom"),
      dosTo: searchParams.get("dosTo"),
      minAmount: searchParams.get("minAmount"),
      maxAmount: searchParams.get("maxAmount"),
      agingBucket: searchParams.get("agingBucket"),
      practice: searchParams.get("practice"),
      clinician: searchParams.get("clinician"),
      assignedBiller: searchParams.get("assignedBiller"),
      carcRarc: searchParams.get("carcRarc"),
      priority: searchParams.get("priority"),
      followUpDue: searchParams.get("followUpDue"),
    };

    // ── 1. Pull unmatched / blocked ERA claim-payment rows ────────────────
    const { data: paymentsRaw, error: payErr } = await (supabase as any)
      .from("era_claim_payments")
      .select(
        "id, organization_id, era_import_batch_id, professional_claim_id, client_id, " +
          "clp01_claim_control_number, clp02_claim_status_code, clp03_total_charge, " +
          "clp04_payment_amount, clp05_patient_responsibility, payer_claim_control_number, " +
          "check_eft_number, check_issue_date, claim_match_status, posting_status, " +
          "service_lines, raw_segments, carc_codes, rarc_codes, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .or("claim_match_status.eq.unmatched,posting_status.eq.blocked")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (payErr) throw payErr;
    const payments = (paymentsRaw ?? []) as DbRow[];

    if (payments.length === 0) {
      return NextResponse.json({
        success: true,
        organizationId,
        generatedAt: new Date().toISOString(),
        items: [],
        count: 0,
      });
    }

    const batchIds = Array.from(
      new Set(payments.map((p) => text(p.era_import_batch_id)).filter(Boolean)),
    );
    const clientIds = Array.from(
      new Set(payments.map((p) => text(p.client_id)).filter(Boolean)),
    );

    // ── 2. Resolve parent batches → payer profile id ─────────────────────
    const { data: batches } = batchIds.length
      ? await (supabase as any)
          .from("era_import_batches")
          .select("id, parsed_summary, imported_at, file_name")
          .in("id", batchIds)
          .eq("organization_id", organizationId)
      : { data: [] as DbRow[] };

    const batchById = new Map<string, DbRow>(
      ((batches ?? []) as DbRow[]).map((b) => [text(b.id), b]),
    );

    const payerIdByBatch = new Map<string, string | null>();
    for (const [id, b] of batchById) {
      const sum = (b.parsed_summary as Record<string, unknown> | null) ?? null;
      payerIdByBatch.set(
        id,
        sum && typeof sum.payerProfileId === "string"
          ? (sum.payerProfileId as string)
          : null,
      );
    }

    const payerIds = Array.from(
      new Set(Array.from(payerIdByBatch.values()).filter((x): x is string => Boolean(x))),
    );

    const { data: payers } = payerIds.length
      ? await (supabase as any)
          .from("payer_profiles")
          .select("id, payer_name")
          .in("id", payerIds)
      : { data: [] as DbRow[] };
    const payerById = new Map<string, DbRow>(
      ((payers ?? []) as DbRow[]).map((p) => [text(p.id), p]),
    );

    const { data: clients } = clientIds.length
      ? await (supabase as any)
          .from("clients")
          .select("id, first_name, last_name, primary_provider_id, primary_clinician_user_id")
          .in("id", clientIds)
      : { data: [] as DbRow[] };
    const clientById = new Map<string, DbRow>(
      ((clients ?? []) as DbRow[]).map((c) => [text(c.id), c]),
    );

    // ── 3. Workqueue items + comments + assignees ─────────────────────────
    const paymentIds = payments.map((p) => text(p.id));
    const { data: wqItems } = paymentIds.length
      ? await (supabase as any)
          .from("workqueue_items")
          .select(
            "id, status, priority, assigned_to_user_id, deferred_until, source_object_id, context_payload, created_at",
          )
          .eq("organization_id", organizationId)
          .eq("work_type", "era_mismatch")
          .eq("source_object_type", "payment_posting")
          .in("source_object_id", paymentIds)
          .is("archived_at", null)
      : { data: [] as DbRow[] };

    const wqByPaymentId = new Map<string, DbRow>();
    for (const w of ((wqItems ?? []) as DbRow[])) {
      const pid = text(w.source_object_id);
      if (!pid) continue;
      // Prefer most recent if duplicates somehow exist.
      const existing = wqByPaymentId.get(pid);
      if (!existing) wqByPaymentId.set(pid, w);
    }

    const wqIds = Array.from(wqByPaymentId.values()).map((w) => text(w.id));
    const assignedIds = Array.from(
      new Set(
        Array.from(wqByPaymentId.values())
          .map((w) => text(w.assigned_to_user_id))
          .filter(Boolean),
      ),
    );

    const [{ data: comments }, { data: assignees }] = await Promise.all([
      wqIds.length
        ? (supabase as any)
            .from("workqueue_item_comments")
            .select(
              "id, workqueue_item_id, comment_body, comment_type, created_at, created_by_user_id",
            )
            .in("workqueue_item_id", wqIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] as DbRow[] }),
      assignedIds.length
        ? (supabase as any)
            .from("users")
            .select("id, full_name, email")
            .in("id", assignedIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);

    const commentsByItem = new Map<string, DbRow[]>();
    for (const c of ((comments ?? []) as DbRow[])) {
      const k = text(c.workqueue_item_id);
      const arr = commentsByItem.get(k) ?? [];
      arr.push(c);
      commentsByItem.set(k, arr);
    }
    const assigneeById = new Map<string, DbRow>(
      ((assignees ?? []) as DbRow[]).map((u) => [text(u.id), u]),
    );

    // ── 4. Run assisted matching in parallel for each payment ─────────────
    const suggestions = await Promise.all(
      payments.map(async (p) => {
        const batchId = text(p.era_import_batch_id);
        const payerProfileId = payerIdByBatch.get(batchId) ?? null;
        const dos = firstServiceDate(p.service_lines);
        try {
          const result = await findCandidatesForEraClaimPayment({
            organizationId,
            eraClaimPaymentId: text(p.id),
            clp01ClaimControlNumber: text(p.clp01_claim_control_number),
            payerClaimControlNumber:
              (p.payer_claim_control_number as string | null) ?? null,
            totalCharge: Number(p.clp03_total_charge ?? 0) || 0,
            payerProfileId,
            serviceDateFrom: dos,
            serviceDateTo: dos,
            patientLastName:
              ((): string | null => {
                const name = patientNameFromRawSegments(p.raw_segments);
                if (!name) return null;
                const parts = name.split(/\s+/);
                return parts[parts.length - 1] ?? null;
              })(),
          });
          const combined = [
            ...(result?.exact ? [result.exact] : []),
            ...(result?.probable ?? []),
          ];
          return combined;
        } catch {
          return [];
        }
      }),
    );

    // ── 5. Build rows ─────────────────────────────────────────────────────
    const rows: UnmatchedEraRow[] = payments.map((p, idx) => {
      const id = text(p.id);
      const batchId = text(p.era_import_batch_id);
      const batch = batchById.get(batchId);
      const payerProfileId = payerIdByBatch.get(batchId) ?? null;
      const payer = payerProfileId ? payerById.get(payerProfileId) : null;
      const clientId = text(p.client_id) || null;
      const client = clientId ? clientById.get(clientId) : null;
      const clientName = client
        ? [text(client.first_name), text(client.last_name)].filter(Boolean).join(" ").trim() ||
          "Unknown client"
        : "Unknown client";
      const patientName = patientNameFromRawSegments(p.raw_segments) ||
        (client ? clientName : "");
      const dos = firstServiceDate(p.service_lines);
      const paidAmount = Number(p.clp04_payment_amount ?? 0) || 0;
      const totalCharge = Number(p.clp03_total_charge ?? 0) || 0;
      const patientResponsibility = Number(p.clp05_patient_responsibility ?? 0) || 0;
      const matchStatus = text(p.claim_match_status) || "unmatched";
      const postingStatus = text(p.posting_status) || "blocked";

      const reasonParts: string[] = [];
      if (matchStatus === "unmatched") reasonParts.push("No matching claim found");
      if (postingStatus === "blocked") reasonParts.push("Posting blocked");
      if (!payerProfileId) reasonParts.push("Payer profile not mapped to batch");
      if (!clientId && matchStatus === "unmatched")
        reasonParts.push("No client linked");
      const carc = (p.carc_codes as string[] | null) ?? [];
      if (carc.length > 0) reasonParts.push(`CARC ${carc.join(", ")}`);
      const reasonUnmatched = reasonParts.join(" • ") || "Unmatched";

      const cands = (suggestions[idx] ?? []) as unknown as Array<Record<string, unknown>>;
      const topRaw = cands[0] ?? null;
      const top = topRaw
        ? {
            professionalClaimId: text(topRaw.professionalClaimId),
            claimNumber: (topRaw.claimNumber as string | null) ?? null,
            payerClaimControlNumber:
              (topRaw.payerClaimControlNumber as string | null) ?? null,
            totalCharge: Number(topRaw.totalCharge ?? 0) || 0,
            dateOfServiceFrom: (topRaw.dateOfServiceFrom as string | null) ?? null,
            patientDisplayName:
              (topRaw.patientDisplayName as string | null) ?? null,
            strategy: text(topRaw.strategy),
            reasons: ((topRaw.reasons as string[] | undefined) ?? []).map(text),
          }
        : null;

      const tab = classifyTab({
        clientId,
        payerProfileId,
        postingStatus,
        matchStatus,
        duplicateCount: cands.length,
      });

      const wq = wqByPaymentId.get(id) ?? null;
      const wqId = wq ? text(wq.id) : null;
      const itemComments = wqId
        ? (commentsByItem.get(wqId) ?? []).map((c) => ({
            id: text(c.id),
            body: text(c.comment_body),
            type: text(c.comment_type) || "note",
            createdAt: (c.created_at as string | null) ?? null,
            createdBy: text(c.created_by_user_id) || null,
          }))
        : [];
      const assignee = wq ? assigneeById.get(text(wq.assigned_to_user_id)) : null;
      const assignedTo = assignee
        ? text(assignee.full_name) || text(assignee.email) || null
        : null;

      return {
        id,
        eraClaimPaymentId: id,
        eraBatchId: batchId,
        workqueueItemId: wqId,
        payerProfileId,
        payerName: text(payer?.payer_name) || null,
        payerCheckEft: text(p.check_eft_number) || null,
        clientId,
        clientName,
        primaryProviderId: client
          ? (text(client.primary_provider_id) || text(client.primary_clinician_user_id) || null)
          : null,
        patientName: patientName || "Unknown client",
        claimNumberFromEra: text(p.clp01_claim_control_number),
        payerClaimControlNumber:
          (p.payer_claim_control_number as string | null) ?? null,
        dos,
        paidAmount,
        totalCharge,
        patientResponsibility,
        reasonUnmatched,
        postingStatus,
        matchStatus,
        receivedAt: (batch?.imported_at as string | null) ?? (p.created_at as string),
        agingDays: ageDays((batch?.imported_at as string | null) ?? (p.created_at as string)),
        tab,
        possibleMatch: top,
        duplicateCandidateCount: cands.length,
        confidenceScore: top ? Number(topRaw?.confidence ?? 0) || 0 : null,
        candidates: cands.map((c) => ({
          professionalClaimId: text(c.professionalClaimId),
          claimNumber: (c.claimNumber as string | null) ?? null,
          patientDisplayName: (c.patientDisplayName as string | null) ?? null,
          dateOfServiceFrom: (c.dateOfServiceFrom as string | null) ?? null,
          totalCharge: Number(c.totalCharge ?? 0) || 0,
          confidence: Number(c.confidence ?? 0) || 0,
          strategy: text(c.strategy),
          reasons: ((c.reasons as string[] | undefined) ?? []).map(text),
        })),
        assignedTo,
        priority: wq ? text(wq.priority) || null : null,
        followUpDue: wq ? (wq.deferred_until as string | null) ?? null : null,
        status: wq ? text(wq.status) || null : null,
        notes: itemComments,
      };
    });

    // ── 6. Apply universal filter rail (in-memory) ────────────────────────
    const filtered = rows.filter((r) => {
      if (filter.payer && r.payerProfileId !== filter.payer) return false;
      if (filter.client && r.clientId !== filter.client) return false;
      if (filter.status && r.status !== filter.status) return false;
      if (filter.dosFrom && (!r.dos || r.dos < filter.dosFrom)) return false;
      if (filter.dosTo && (!r.dos || r.dos > filter.dosTo)) return false;
      if (filter.minAmount) {
        const n = Number(filter.minAmount);
        if (Number.isFinite(n) && r.paidAmount < n) return false;
      }
      if (filter.maxAmount) {
        const n = Number(filter.maxAmount);
        if (Number.isFinite(n) && r.paidAmount > n) return false;
      }
      if (!bucketMatch(r.agingDays, filter.agingBucket)) return false;
      if (filter.assignedBiller) {
        const needle = filter.assignedBiller.trim().toLowerCase();
        const unassigned = ["unassigned", "—", "-", "none"].includes(needle);
        if (unassigned) {
          if (r.assignedTo) return false;
        } else if (!ciContains(r.assignedTo, filter.assignedBiller)) return false;
      }
      if (filter.carcRarc) {
        if (
          !ciContains(r.reasonUnmatched, filter.carcRarc) &&
          !ciContains(r.payerName, filter.carcRarc)
        )
          return false;
      }
      if (filter.priority) {
        const p = (r.priority ?? "").toLowerCase();
        if (filter.priority === "urgent") {
          if (p !== "urgent" && (r.agingDays ?? 0) <= 14) return false;
        } else if (p !== filter.priority) return false;
      }
      if (filter.followUpDue) {
        if (!r.followUpDue || !r.followUpDue.startsWith(filter.followUpDue))
          return false;
      }
      // Clinician filter accepts either a provider id (exact match against the
      // client's assigned provider) or a free-text name fragment.
      if (filter.clinician) {
        const needle = filter.clinician.trim();
        if (needle) {
          const idMatch = r.primaryProviderId === needle;
          const textMatch =
            ciContains(r.clientName, needle) || ciContains(r.assignedTo, needle);
          if (!idMatch && !textMatch) return false;
        }
      }
      // Practice has no canonical column on the ERA line, so we treat it as
      // a text search across the payer + client name (effectively a
      // service-context filter) — keeps the universal rail functional
      // until a structured practice/service-location field exists.
      if (filter.practice) {
        const needle = filter.practice.trim();
        if (needle) {
          const hit =
            ciContains(r.payerName, needle) || ciContains(r.clientName, needle);
          if (!hit) return false;
        }
      }
      return true;
    });

    return NextResponse.json({
      success: true,
      organizationId,
      generatedAt: new Date().toISOString(),
      items: filtered,
      count: filtered.length,
    });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed to load unmatched ERA claims",
      },
      { status: 500 },
    );
  }
}
