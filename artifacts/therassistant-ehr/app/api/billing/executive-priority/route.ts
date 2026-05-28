/**
 * /api/billing/executive-priority
 *
 * Lists the highest-impact claims across every billing stage, scoped by
 * the seven Executive / Priority tabs:
 *   high_dollar | urgent_follow_up | appeal_deadlines | oldest_claims |
 *   vip_practices | unassigned_work | staff_workload
 *
 * Returns rows with the spec's 11 columns (Priority, Practice, Client,
 * Payer, Claim ID, Balance, Age, Issue type, Assigned to, Due date,
 * Financial risk) plus the bits needed for the right-side detail panel
 * (timeline, notes, recommended action).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const toDays = (iso: string | null): number | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
};

export type ExecutiveTab =
  | "high_dollar"
  | "urgent_follow_up"
  | "appeal_deadlines"
  | "oldest_claims"
  | "vip_practices"
  | "unassigned_work"
  | "staff_workload";

const VALID_TABS: ExecutiveTab[] = [
  "high_dollar",
  "urgent_follow_up",
  "appeal_deadlines",
  "oldest_claims",
  "vip_practices",
  "unassigned_work",
  "staff_workload",
];

export interface ExecutiveRow {
  id: string;
  claimId: string;
  claimNumber: string;
  practiceName: string;
  clientId: string;
  clientName: string;
  payerName: string;
  serviceDateFrom: string | null;
  balance: number;
  ageDays: number | null;
  issueType: string;
  reasonForPriority: string;
  recommendedAction: string;
  priority: "low" | "normal" | "high" | "urgent";
  assignedToId: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  appealDeadline: string | null;
  financialRisk: "low" | "medium" | "high" | "critical";
  claimStatus: string;
  carcCode: string | null;
  rarcCode: string | null;
  denialReason: string;
  workqueueItemId: string | null;
  updatedAt: string | null;
  timeline: Array<{ id: string; at: string; label: string; detail: string }>;
  notes: Array<{
    id: string;
    body: string;
    author: string;
    createdAt: string;
    isExecutive: boolean;
  }>;
}

function deriveIssueType(claim: DbRow, wq: DbRow | undefined): string {
  const status = text(claim.claim_status);
  if (wq?.item_status) {
    const s = text(wq.item_status);
    if (s && s !== "no_response") return s.replace(/_/g, " ");
  }
  switch (status) {
    case "denied": return "Denied";
    case "rejected_oa": return "Clearinghouse rejection";
    case "rejected_payer": return "Payer rejection";
    case "submitted": return "Awaiting response";
    case "accepted_oa": return "Accepted at clearinghouse";
    case "accepted_payer": return "Accepted by payer";
    case "validation_failed": return "Validation failed";
    case "batched": return "Awaiting transmission";
    default: return status.replace(/_/g, " ") || "Open";
  }
}

function derivePriority(
  claim: DbRow,
  wq: DbRow | undefined,
  ageDays: number | null,
  appealDeadlineDays: number | null,
  balance: number,
): "low" | "normal" | "high" | "urgent" {
  if (wq?.priority && ["low", "normal", "high", "urgent"].includes(text(wq.priority))) {
    return text(wq.priority) as any;
  }
  if (appealDeadlineDays !== null && appealDeadlineDays <= 7) return "urgent";
  if (ageDays !== null && ageDays > 120) return "urgent";
  if (balance >= 1000) return "high";
  if (ageDays !== null && ageDays > 60) return "high";
  return "normal";
}

function deriveFinancialRisk(
  balance: number,
  appealDeadlineDays: number | null,
  ageDays: number | null,
): "low" | "medium" | "high" | "critical" {
  if (appealDeadlineDays !== null && appealDeadlineDays <= 3 && balance > 0) return "critical";
  if (balance >= 2000 || (ageDays !== null && ageDays > 180)) return "critical";
  if (balance >= 1000 || (ageDays !== null && ageDays > 120)) return "high";
  if (balance >= 250 || (ageDays !== null && ageDays > 60)) return "medium";
  return "low";
}

function deriveReason(
  claim: DbRow,
  wq: DbRow | undefined,
  ageDays: number | null,
  appealDeadlineDays: number | null,
  balance: number,
): string {
  const bits: string[] = [];
  if (balance >= 1000) bits.push(`High-dollar balance ($${balance.toFixed(2)})`);
  if (appealDeadlineDays !== null && appealDeadlineDays <= 14) {
    bits.push(`Appeal deadline in ${Math.max(0, appealDeadlineDays)} day(s)`);
  }
  if (ageDays !== null && ageDays > 90) bits.push(`Claim is ${ageDays} days old`);
  if (text(claim.claim_status) === "denied") bits.push("Payer denial on file");
  if (!wq?.assigned_to_user_id) bits.push("No one assigned");
  if (bits.length === 0) bits.push("Routine priority — under monitoring");
  return bits.join(" · ");
}

function deriveRecommendedAction(claim: DbRow, wq: DbRow | undefined): string {
  const status = text(claim.claim_status);
  if (wq?.item_status === "appeal_needed") return "Draft and submit appeal before the timely-filing deadline.";
  if (status === "denied") return "Review denial reason, gather supporting docs, and either appeal or write off.";
  if (status === "rejected_oa" || status === "rejected_payer") {
    return "Correct the rejection edits flagged by the clearinghouse/payer and resubmit.";
  }
  if (status === "submitted" || status === "accepted_oa" || status === "accepted_payer") {
    return "Call the payer for a status update — the claim has aged past the response window.";
  }
  if (status === "batched" || status === "ready_for_batch") {
    return "Confirm the batch transmitted; release if held.";
  }
  return "Assign to a biller and add an executive note with the next concrete step.";
}

interface ServerFilters {
  practice?: string;
  clinician?: string;
  payer?: string;
  client?: string;
  dosFrom?: string;
  dosTo?: string;
  status?: string;
  assignedBiller?: string; // staff_profiles.id OR "__unassigned__"
  minAmount?: number;
  maxAmount?: number;
  agingBucket?: "0_30" | "31_60" | "61_90" | "91_120" | "120_plus";
  carcRarc?: string;
  priority?: Priority;
  followUpDue?: string; // ISO date — keep rows with due_date <= followUpDue
}

type Priority = "low" | "normal" | "high" | "urgent";

function applyFilters(rows: ExecutiveRow[], f: ServerFilters): ExecutiveRow[] {
  return rows.filter((r) => {
    if (f.practice && !r.practiceName.toLowerCase().includes(f.practice.toLowerCase())) return false;
    if (f.clinician) {
      const name = (r.assignedToName ?? "").toLowerCase();
      if (!name || !name.includes(f.clinician.toLowerCase())) return false;
    }
    if (f.payer && r.payerName !== f.payer) return false;
    if (f.client && r.clientName !== f.client) return false;
    if (f.dosFrom && (!r.serviceDateFrom || r.serviceDateFrom < f.dosFrom)) return false;
    if (f.dosTo && (!r.serviceDateFrom || r.serviceDateFrom > f.dosTo)) return false;
    if (f.status && r.claimStatus !== f.status) return false;
    if (f.assignedBiller) {
      if (f.assignedBiller === "__unassigned__") {
        if (r.assignedToId) return false;
      } else if (r.assignedToId !== f.assignedBiller) return false;
    }
    if (typeof f.minAmount === "number" && r.balance < f.minAmount) return false;
    if (typeof f.maxAmount === "number" && r.balance > f.maxAmount) return false;
    if (f.agingBucket) {
      const a = r.ageDays ?? 0;
      const ok =
        (f.agingBucket === "0_30" && a <= 30) ||
        (f.agingBucket === "31_60" && a > 30 && a <= 60) ||
        (f.agingBucket === "61_90" && a > 60 && a <= 90) ||
        (f.agingBucket === "91_120" && a > 90 && a <= 120) ||
        (f.agingBucket === "120_plus" && a > 120);
      if (!ok) return false;
    }
    if (f.carcRarc) {
      const needle = f.carcRarc.toUpperCase();
      const hay = `${r.carcCode ?? ""} ${r.rarcCode ?? ""}`.toUpperCase();
      if (!hay.includes(needle)) return false;
    }
    if (f.priority && r.priority !== f.priority) return false;
    if (f.followUpDue) {
      if (!r.dueDate || r.dueDate > f.followUpDue) return false;
    }
    return true;
  });
}

function parseServerFilters(sp: URLSearchParams): ServerFilters {
  const out: ServerFilters = {};
  const s = (k: string) => {
    const v = sp.get(k);
    return v ? text(v) : undefined;
  };
  const n = (k: string) => {
    const v = sp.get(k);
    if (!v) return undefined;
    const num = Number(v);
    return Number.isFinite(num) ? num : undefined;
  };
  out.practice = s("practice");
  out.clinician = s("clinician");
  out.payer = s("payer");
  out.client = s("client");
  out.dosFrom = s("dosFrom");
  out.dosTo = s("dosTo");
  out.status = s("status");
  out.assignedBiller = s("assignedBiller");
  out.minAmount = n("minAmount");
  out.maxAmount = n("maxAmount");
  const ab = s("agingBucket");
  if (ab && ["0_30", "31_60", "61_90", "91_120", "120_plus"].includes(ab)) {
    out.agingBucket = ab as ServerFilters["agingBucket"];
  }
  out.carcRarc = s("carcRarc");
  const pr = s("priority");
  if (pr && ["low", "normal", "high", "urgent"].includes(pr)) {
    out.priority = pr as Priority;
  }
  out.followUpDue = s("followUpDue");
  return out;
}

function applyTab(rows: ExecutiveRow[], tab: ExecutiveTab): ExecutiveRow[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  switch (tab) {
    case "high_dollar":
      return [...rows]
        .filter((r) => r.balance >= 500)
        .sort((a, b) => b.balance - a.balance);
    case "urgent_follow_up":
      return [...rows]
        .filter((r) => r.priority === "urgent" || r.financialRisk === "critical")
        .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
    case "appeal_deadlines":
      return [...rows]
        .filter((r) => !!r.appealDeadline)
        .sort((a, b) => (a.appealDeadline ?? "").localeCompare(b.appealDeadline ?? ""));
    case "oldest_claims":
      return [...rows].sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
    case "vip_practices":
      // VIP practices flag isn't modeled yet — show every row sorted by balance
      // so admins can still scan their highest-impact accounts. Surfaced as a
      // gap if dedicated VIP-flag data lands later.
      return [...rows].sort((a, b) => b.balance - a.balance);
    case "unassigned_work":
      return [...rows]
        .filter((r) => !r.assignedToId)
        .sort((a, b) => b.balance - a.balance);
    case "staff_workload":
      return [...rows]
        .filter((r) => !!r.assignedToId)
        .sort((a, b) => {
          const an = (a.assignedToName ?? "").localeCompare(b.assignedToName ?? "");
          if (an !== 0) return an;
          return b.balance - a.balance;
        });
    default:
      return rows;
  }
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

    const rawTab = text(searchParams.get("tab"));
    const tab: ExecutiveTab = (VALID_TABS as string[]).includes(rawTab)
      ? (rawTab as ExecutiveTab)
      : "high_dollar";
    const serverFilters = parseServerFilters(searchParams);

    // Pull every claim that could plausibly need executive attention. We
    // exclude already-closed claims (paid, voided) and drafts, plus
    // anything that's been deferred past today.
    const today = new Date().toISOString().slice(0, 10);

    const { data: claims, error: claimsErr } = await (supabase as any)
      .from("professional_claims")
      .select(
        "id, claim_number, patient_id, payer_profile_id, claim_status, total_charge, write_off_amount, appeal_deadline_date, denial_reason_code, denial_reason_description, days_in_ar, first_billed_date, defer_until, deferred_reason, billing_notes, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .not("claim_status", "in", "(paid,voided,draft)")
      .or(`defer_until.is.null,defer_until.lte.${today}`)
      .order("updated_at", { ascending: false })
      .limit(5000);

    if (claimsErr) throw claimsErr;

    const claimRows: DbRow[] = (claims as DbRow[]) ?? [];
    const claimIds = claimRows.map((c) => text(c.id)).filter(Boolean);
    const patientIds = [...new Set(claimRows.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerProfileIds = [
      ...new Set(claimRows.map((c) => text(c.payer_profile_id)).filter(Boolean)),
    ];

    const [
      { data: clients },
      { data: payerProfiles },
      { data: serviceLines },
      { data: wqItems },
      { data: notes },
      { data: events },
      { data: org },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any)
            .from("clients")
            .select("id, first_name, last_name")
            .in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerProfileIds.length
        ? (supabase as any)
            .from("payer_profiles")
            .select("id, payer_name")
            .in("id", payerProfileIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("professional_claim_service_lines")
            .select("claim_id, service_date_from, line_number")
            .in("claim_id", claimIds)
            .order("line_number", { ascending: true })
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_workqueue_items")
            .select(
              "id, claim_id, item_status, priority, assigned_to_user_id, defer_until, denial_reason, carc_code, rarc_code, days_in_ar, action_taken, updated_at",
            )
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_notes")
            .select("id, claim_id, body, author_display_name, created_at")
            .eq("organization_id", organizationId)
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
            .limit(2000)
        : Promise.resolve({ data: [] as DbRow[] }),
      claimIds.length
        ? (supabase as any)
            .from("claim_status_events")
            .select("id, claim_id, status, status_message, created_at")
            .in("claim_id", claimIds)
            .order("created_at", { ascending: false })
            .limit(2000)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("organizations")
        .select("id, name")
        .eq("id", organizationId)
        .maybeSingle(),
    ]);

    const practiceName = text((org as DbRow | null)?.name) || "Practice";

    const patientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payerProfiles as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const firstLineByClaim = new Map<string, DbRow>();
    for (const sl of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(sl.claim_id);
      if (!firstLineByClaim.has(cid)) firstLineByClaim.set(cid, sl);
    }
    const wqByClaim = new Map<string, DbRow>();
    for (const wq of ((wqItems as DbRow[]) ?? [])) {
      const cid = text(wq.claim_id);
      // If multiple, keep highest-priority/most recent
      const existing = wqByClaim.get(cid);
      if (!existing) wqByClaim.set(cid, wq);
    }

    // Resolve assignee names from staff_profiles (we store staff_profiles.id
    // in claim_workqueue_items.assigned_to_user_id for this queue).
    const assigneeIds = [
      ...new Set(
        ((wqItems as DbRow[]) ?? [])
          .map((w) => text(w.assigned_to_user_id))
          .filter(Boolean),
      ),
    ];
    const { data: staff } = assigneeIds.length
      ? await (supabase as any)
          .from("staff_profiles")
          .select("id, first_name, last_name, email")
          .in("id", assigneeIds)
      : { data: [] as DbRow[] };
    const staffById = new Map<string, DbRow>(
      ((staff as DbRow[]) ?? []).map((s) => [text(s.id), s]),
    );

    const notesByClaim = new Map<string, DbRow[]>();
    for (const n of ((notes as DbRow[]) ?? [])) {
      const cid = text(n.claim_id);
      if (!notesByClaim.has(cid)) notesByClaim.set(cid, []);
      notesByClaim.get(cid)!.push(n);
    }
    const eventsByClaim = new Map<string, DbRow[]>();
    for (const e of ((events as DbRow[]) ?? [])) {
      const cid = text(e.claim_id);
      if (!eventsByClaim.has(cid)) eventsByClaim.set(cid, []);
      eventsByClaim.get(cid)!.push(e);
    }

    const allRows: ExecutiveRow[] = claimRows.map((claim) => {
      const claimId = text(claim.id);
      const wq = wqByClaim.get(claimId);
      const client = patientById.get(text(claim.patient_id));
      const payer = payerById.get(text(claim.payer_profile_id));
      const line = firstLineByClaim.get(claimId);
      const balance = Math.max(
        0,
        Math.round((money(claim.total_charge) - money(claim.write_off_amount)) * 100) / 100,
      );
      const billedDate = text(claim.first_billed_date) || text(claim.created_at);
      const ageDays = toDays(billedDate || null);
      const appealDeadline = text(claim.appeal_deadline_date) || null;
      const appealDeadlineDays = appealDeadline
        ? Math.floor(
            (new Date(appealDeadline).getTime() - Date.now()) / (24 * 3600 * 1000),
          )
        : null;

      const assigneeId = wq?.assigned_to_user_id ? text(wq.assigned_to_user_id) : null;
      const assignee = assigneeId ? staffById.get(assigneeId) : undefined;
      const assigneeName = assignee
        ? [assignee.first_name, assignee.last_name].map(text).filter(Boolean).join(" ") ||
          text(assignee.email) ||
          "Unknown"
        : null;

      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ") ||
          "Unknown client"
        : "Unknown client";

      const claimNotes = (notesByClaim.get(claimId) ?? []).map((n) => ({
        id: text(n.id),
        body: text(n.body),
        author: text(n.author_display_name) || "Staff",
        createdAt: text(n.created_at),
        isExecutive: text(n.body).startsWith("[Executive]"),
      }));
      const claimEvents = (eventsByClaim.get(claimId) ?? []).map((e) => ({
        id: text(e.id),
        at: text(e.created_at),
        label: text(e.status).replace(/_/g, " ") || "status update",
        detail: text(e.status_message),
      }));
      // Merge claim creation as the earliest timeline entry.
      const timeline = [
        ...claimEvents,
        {
          id: `created-${claimId}`,
          at: text(claim.created_at),
          label: "claim created",
          detail: text(claim.claim_number) ? `Claim ${claim.claim_number}` : "",
        },
      ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

      return {
        id: claimId,
        claimId,
        claimNumber: text(claim.claim_number) || claimId.slice(0, 8),
        practiceName,
        clientId: text(claim.patient_id),
        clientName: patientName,
        payerName: text(payer?.payer_name) || "Unknown payer",
        serviceDateFrom: text(line?.service_date_from) || null,
        balance,
        ageDays,
        issueType: deriveIssueType(claim, wq),
        reasonForPriority: deriveReason(claim, wq, ageDays, appealDeadlineDays, balance),
        recommendedAction: deriveRecommendedAction(claim, wq),
        priority: derivePriority(claim, wq, ageDays, appealDeadlineDays, balance),
        assignedToId: assigneeId,
        assignedToName: assigneeName,
        dueDate:
          (wq?.defer_until ? text(wq.defer_until) : null) ||
          (claim.defer_until ? text(claim.defer_until) : null) ||
          appealDeadline,
        appealDeadline,
        financialRisk: deriveFinancialRisk(balance, appealDeadlineDays, ageDays),
        claimStatus: text(claim.claim_status),
        carcCode: text(wq?.carc_code) || text(claim.denial_reason_code) || null,
        rarcCode: text(wq?.rarc_code) || null,
        denialReason:
          text(wq?.denial_reason) || text(claim.denial_reason_description) || "",
        workqueueItemId: wq?.id ? text(wq.id) : null,
        updatedAt: text(claim.updated_at) || null,
        timeline,
        notes: claimNotes,
      };
    });

    // Apply the universal filter rail server-side BEFORE the tab cut so
    // the user sees a complete, trustworthy result set (no client-side
    // filtering of a truncated window).
    const filteredRows = applyFilters(allRows, serverFilters);
    const tabRows = applyTab(filteredRows, tab);

    // Header metrics — over the active tab so the strip reflects what
    // the user is looking at.
    const totalCount = tabRows.length;
    const totalDollars = tabRows.reduce((s, r) => s + r.balance, 0);
    const oldestAge = tabRows.reduce<number>(
      (m, r) => Math.max(m, r.ageDays ?? 0),
      0,
    );
    const urgentCount = tabRows.filter(
      (r) => r.priority === "urgent" || r.financialRisk === "critical",
    ).length;

    // Filter dropdown options
    const payerSet = new Set<string>();
    const clientSet = new Set<string>();
    for (const r of allRows) {
      if (r.payerName) payerSet.add(r.payerName);
      if (r.clientName) clientSet.add(r.clientName);
    }
    const assigneeOptions = ((staff as DbRow[]) ?? []).map((s) => ({
      value: text(s.id),
      label:
        [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
        text(s.email) ||
        text(s.id),
    }));

    return NextResponse.json({
      success: true,
      organizationId,
      tab,
      rows: tabRows,
      metrics: {
        totalCount,
        totalDollars: Math.round(totalDollars * 100) / 100,
        oldestAgeDays: oldestAge,
        urgentCount,
      },
      filterOptions: {
        payers: [...payerSet].sort().map((v) => ({ value: v, label: v })),
        clients: [...clientSet].sort().map((v) => ({ value: v, label: v })),
        assignees: assigneeOptions,
      },
      practiceName,
    });
  } catch (error) {
    console.error("Executive priority API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Executive priority API failed",
      },
      { status: 500 },
    );
  }
}
