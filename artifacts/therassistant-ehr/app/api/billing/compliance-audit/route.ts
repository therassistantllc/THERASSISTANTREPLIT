/**
 * GET /api/billing/compliance-audit
 *
 * Returns compliance / audit findings derived from existing claim,
 * encounter, clinical-note, and service-line data. No new tables are
 * required — each finding is computed from the underlying records and
 * grouped into one of six tabs:
 *
 *   missing_signature, modifier_audit, diagnosis_audit,
 *   late_documentation, overlapping_services, high_risk_patterns
 *
 * Honours the universal workqueue filter rail (practice, clinician,
 * payer, client, dosFrom, dosTo, status, assignedBiller, minAmount,
 * maxAmount, agingBucket, carcRarc, priority, followUpDue) where the
 * filter is meaningful for compliance findings.
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

// ─── Risk taxonomy ─────────────────────────────────────────────────────
export type ComplianceTab =
  | "missing_signature"
  | "modifier_audit"
  | "diagnosis_audit"
  | "late_documentation"
  | "overlapping_services"
  | "high_risk_patterns";

const TABS: ComplianceTab[] = [
  "missing_signature",
  "modifier_audit",
  "diagnosis_audit",
  "late_documentation",
  "overlapping_services",
  "high_risk_patterns",
];

// Heuristic constants — kept conservative; production tuning lives in
// payer-rule tables in a later iteration.
const HIGH_RISK_MODIFIERS = new Set(["59", "25", "22", "KX", "XE", "XS", "XP", "XU"]);
const LATE_DOC_DAYS = 7;
const HIGH_DOLLAR = 500;
const NONSPECIFIC_DX_PREFIXES = ["Z00", "Z71", "Z76"];

interface FindingRow {
  id: string;            // `${claimId}:${tab}:${seq}`
  tab: ComplianceTab;
  claimId: string;
  claimNumber: string;
  patientId: string | null;
  patientName: string;
  clinicianId: string | null;
  clinicianName: string | null;
  practiceLocationId: string | null;
  payerName: string | null;
  serviceDate: string | null;
  riskType: string;       // human-readable tab label
  code: string;           // CPT / modifier / DX / rule code
  issue: string;          // one-line explanation
  severity: "low" | "medium" | "high" | "urgent";
  financialImpact: number;
  status: string;         // workqueue item status (or claim_status)
  workqueueItemId: string | null;
  workqueueStatus: string | null;
  workqueuePriority: string | null;
  assignedToUserId: string | null;
  assignedToDisplayName: string | null;
  followUpDueDate: string | null;
  totalCharge: number;
  ruleId: string;         // for "Audit rule triggered" panel
  ruleName: string;
  suggestedCorrection: string;
}

const TAB_LABEL: Record<ComplianceTab, string> = {
  missing_signature: "Missing Signature",
  modifier_audit: "Modifier Audit",
  diagnosis_audit: "Diagnosis Audit",
  late_documentation: "Late Documentation",
  overlapping_services: "Overlapping Services",
  high_risk_patterns: "High-Risk Patterns",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function isoPlusDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function severityForCharge(amount: number): FindingRow["severity"] {
  if (amount >= 1000) return "urgent";
  if (amount >= 500) return "high";
  if (amount >= 100) return "medium";
  return "low";
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

    const tabParam = text(searchParams.get("tab")) as ComplianceTab;
    const activeTab: ComplianceTab = TABS.includes(tabParam)
      ? tabParam
      : "missing_signature";

    const filter = {
      practice: text(searchParams.get("practice")),
      clinician: text(searchParams.get("clinician")),
      payer: text(searchParams.get("payer")),
      client: text(searchParams.get("client")),
      dosFrom: text(searchParams.get("dosFrom")),
      dosTo: text(searchParams.get("dosTo")),
      status: text(searchParams.get("status")),
      assignedBiller: text(searchParams.get("assignedBiller")),
      minAmount: text(searchParams.get("minAmount")),
      maxAmount: text(searchParams.get("maxAmount")),
      agingBucket: text(searchParams.get("agingBucket")),
      carcRarc: text(searchParams.get("carcRarc")),
      priority: text(searchParams.get("priority")),
      followUpDue: text(searchParams.get("followUpDue")),
    };

    // ── Load candidate claims (last 365 days) ──
    const since = new Date();
    since.setDate(since.getDate() - 365);

    let cq: any = (supabase as any)
      .from("professional_claims")
      .select(
        [
          "id",
          "claim_number",
          "claim_status",
          "patient_id",
          "payer_profile_id",
          "appointment_id",
          "encounter_id",
          "total_charge",
          "diagnosis_codes",
          "created_at",
          "submitted_at",
          "hold_category",
          "hold_priority",
        ].join(", "),
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .gte("created_at", since.toISOString())
      .limit(2000);

    const minAmount = Number(filter.minAmount);
    if (filter.minAmount && Number.isFinite(minAmount)) cq = cq.gte("total_charge", minAmount);
    const maxAmount = Number(filter.maxAmount);
    if (filter.maxAmount && Number.isFinite(maxAmount)) cq = cq.lte("total_charge", maxAmount);

    const { data: claimsRaw, error: claimsErr } = await cq;
    if (claimsErr) throw claimsErr;
    const claims: DbRow[] = (claimsRaw as DbRow[]) ?? [];
    const claimIds = claims.map((c) => text(c.id)).filter(Boolean);
    if (claimIds.length === 0) {
      return await emptyResponse(supabase, organizationId, activeTab);
    }

    const patientIds = [...new Set(claims.map((c) => text(c.patient_id)).filter(Boolean))];
    const payerIds = [...new Set(claims.map((c) => text(c.payer_profile_id)).filter(Boolean))];
    const apptIds = [...new Set(claims.map((c) => text(c.appointment_id)).filter(Boolean))];
    const encIds = [...new Set(claims.map((c) => text(c.encounter_id)).filter(Boolean))];

    const [
      { data: clients },
      { data: payers },
      { data: serviceLines },
      { data: appointments },
      { data: encounters },
      { data: clinicalNotes },
      { data: wqItems },
    ] = await Promise.all([
      patientIds.length
        ? (supabase as any).from("clients").select("id, first_name, last_name").in("id", patientIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      payerIds.length
        ? (supabase as any).from("payer_profiles").select("id, payer_name").in("id", payerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("professional_claim_service_lines")
        .select(
          "claim_id, line_number, procedure_code, modifiers, charge_amount, service_date_from, service_date_to",
        )
        .in("claim_id", claimIds)
        .order("line_number", { ascending: true }),
      apptIds.length
        ? (supabase as any)
            .from("appointments")
            .select("id, location_id, provider_id")
            .in("id", apptIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encIds.length
        ? (supabase as any)
            .from("encounters")
            .select("id, provider_id, service_date")
            .in("id", encIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      encIds.length
        ? (supabase as any)
            .from("encounter_clinical_notes")
            .select("encounter_id, note_status, signed_at")
            .in("encounter_id", encIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as DbRow[] }),
      (supabase as any)
        .from("claim_workqueue_items")
        .select(
          "id, claim_id, item_status, priority, assigned_to_user_id, defer_until, action_taken",
        )
        .eq("organization_id", organizationId)
        .in("claim_id", claimIds)
        .is("archived_at", null),
    ]);

    const patientById = new Map<string, DbRow>(
      ((clients as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const payerById = new Map<string, DbRow>(
      ((payers as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const apptById = new Map<string, DbRow>(
      ((appointments as DbRow[]) ?? []).map((a) => [text(a.id), a]),
    );
    const encById = new Map<string, DbRow>(
      ((encounters as DbRow[]) ?? []).map((e) => [text(e.id), e]),
    );
    const noteByEnc = new Map<string, DbRow>(
      ((clinicalNotes as DbRow[]) ?? []).map((n) => [text(n.encounter_id), n]),
    );
    const wqByClaim = new Map<string, DbRow>(
      ((wqItems as DbRow[]) ?? []).map((w) => [text(w.claim_id), w]),
    );

    const linesByClaim = new Map<string, DbRow[]>();
    for (const sl of ((serviceLines as DbRow[]) ?? [])) {
      const cid = text(sl.claim_id);
      if (!linesByClaim.has(cid)) linesByClaim.set(cid, []);
      linesByClaim.get(cid)!.push(sl);
    }

    // Pull staff + locations for filter labels.
    const providerIds = [
      ...new Set(
        [
          ...((encounters as DbRow[]) ?? []).map((e) => text(e.provider_id)),
          ...((appointments as DbRow[]) ?? []).map((a) => text(a.provider_id)),
        ].filter(Boolean),
      ),
    ];
    const locationIds = [
      ...new Set(((appointments as DbRow[]) ?? []).map((a) => text(a.location_id)).filter(Boolean)),
    ];
    const [{ data: providers }, { data: locations }] = await Promise.all([
      providerIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("id, first_name, last_name, email")
            .in("id", providerIds)
        : Promise.resolve({ data: [] as DbRow[] }),
      locationIds.length
        ? (supabase as any).from("practice_locations").select("id, name").in("id", locationIds)
        : Promise.resolve({ data: [] as DbRow[] }),
    ]);
    const providerById = new Map<string, DbRow>(
      ((providers as DbRow[]) ?? []).map((p) => [text(p.id), p]),
    );
    const locationById = new Map<string, DbRow>(
      ((locations as DbRow[]) ?? []).map((l) => [text(l.id), l]),
    );

    const providerLabel = (id: string | null) => {
      if (!id) return null;
      const p = providerById.get(id);
      if (!p) return null;
      const composed = [p.first_name, p.last_name].map(text).filter(Boolean).join(" ");
      return composed || text(p.email) || null;
    };

    // ── Build all findings, then filter by active tab + universal rail ──
    const findings: FindingRow[] = [];

    // For "overlapping_services" we need a (clientId|DOS|procedure) bucket.
    const overlapBuckets = new Map<string, Array<{ claimId: string; lineNo: number }>>();
    for (const claim of claims) {
      const claimId = text(claim.id);
      const lines = linesByClaim.get(claimId) ?? [];
      for (const ln of lines) {
        const key = `${text(claim.patient_id)}|${text(ln.service_date_from)}|${text(ln.procedure_code)}`;
        if (!overlapBuckets.has(key)) overlapBuckets.set(key, []);
        overlapBuckets.get(key)!.push({ claimId, lineNo: Number(ln.line_number) || 0 });
      }
    }

    for (const claim of claims) {
      const claimId = text(claim.id);
      const lines = linesByClaim.get(claimId) ?? [];
      const client = patientById.get(text(claim.patient_id));
      const payer = payerById.get(text(claim.payer_profile_id));
      const appt = apptById.get(text(claim.appointment_id));
      const enc = encById.get(text(claim.encounter_id));
      const note = enc ? noteByEnc.get(text(enc.id)) : undefined;
      const wq = wqByClaim.get(claimId);

      const patientName = client
        ? [client.first_name, client.last_name].map(text).filter(Boolean).join(" ")
        : "Unknown client";
      const providerId = text(enc?.provider_id) || text(appt?.provider_id) || null;
      const practiceLocationId = text(appt?.location_id) || null;
      const serviceDate =
        text(enc?.service_date) ||
        (lines[0] ? text(lines[0].service_date_from) : "") ||
        null;
      const totalCharge = money(claim.total_charge);

      const base = {
        claimId,
        claimNumber: text(claim.claim_number) || claimId.slice(0, 8),
        patientId: text(claim.patient_id) || null,
        patientName: patientName || "Unknown client",
        clinicianId: providerId,
        clinicianName: providerLabel(providerId),
        practiceLocationId,
        payerName: text(payer?.payer_name) || null,
        serviceDate,
        totalCharge,
        workqueueItemId: wq ? text(wq.id) : null,
        workqueueStatus: wq ? text(wq.item_status) : null,
        workqueuePriority: wq ? text(wq.priority) : null,
        assignedToUserId: wq ? text(wq.assigned_to_user_id) || null : null,
        assignedToDisplayName: wq?.assigned_to_user_id
          ? providerLabel(text(wq.assigned_to_user_id))
          : null,
        followUpDueDate: wq ? (wq.defer_until as string | null) ?? null : null,
        status: text(wq?.item_status) || text(claim.claim_status) || "open",
      };

      // Missing Signature
      const noteStatus = text(note?.note_status);
      if (!note || noteStatus !== "signed" || !note.signed_at) {
        findings.push({
          ...base,
          id: `${claimId}:missing_signature:0`,
          tab: "missing_signature",
          riskType: TAB_LABEL.missing_signature,
          code: "NOTE-UNSIGNED",
          issue: !note
            ? "No clinical note attached to the encounter"
            : `Note status is "${noteStatus || "draft"}" — not yet signed`,
          severity: totalCharge >= HIGH_DOLLAR ? "high" : "medium",
          financialImpact: totalCharge,
          ruleId: "compliance.missing_signature",
          ruleName: "Signed clinical note required before submission",
          suggestedCorrection:
            "Route to the rendering clinician and request the signed note for this encounter, then release the claim.",
        });
      }

      // Modifier Audit
      for (const ln of lines) {
        const mods: string[] = Array.isArray(ln.modifiers) ? ln.modifiers : [];
        const flagged = mods.filter((m) => HIGH_RISK_MODIFIERS.has(text(m).toUpperCase()));
        if (flagged.length === 0) continue;
        findings.push({
          ...base,
          id: `${claimId}:modifier_audit:${ln.line_number}`,
          tab: "modifier_audit",
          riskType: TAB_LABEL.modifier_audit,
          code: `${text(ln.procedure_code)}${flagged.length ? "-" + flagged.join("/") : ""}`,
          issue: `Line ${ln.line_number}: high-audit modifier${flagged.length > 1 ? "s" : ""} ${flagged.join(", ")} on ${text(ln.procedure_code)}`,
          severity: flagged.includes("59") ? "high" : "medium",
          financialImpact: money(ln.charge_amount),
          ruleId: `modifier.${flagged[0].toLowerCase()}`,
          ruleName: "High-audit modifier appended to procedure",
          suggestedCorrection:
            "Verify the documentation supports the modifier (distinct procedural service or significant separately-identifiable E/M). Remove or document override.",
        });
      }

      // Diagnosis Audit
      const dx: string[] = Array.isArray(claim.diagnosis_codes) ? claim.diagnosis_codes : [];
      if (dx.length === 0) {
        findings.push({
          ...base,
          id: `${claimId}:diagnosis_audit:0`,
          tab: "diagnosis_audit",
          riskType: TAB_LABEL.diagnosis_audit,
          code: "DX-MISSING",
          issue: "Claim has no diagnosis codes",
          severity: "urgent",
          financialImpact: totalCharge,
          ruleId: "diagnosis.missing",
          ruleName: "At least one ICD-10 diagnosis required",
          suggestedCorrection:
            "Add the primary ICD-10 diagnosis from the clinical note before submission.",
        });
      } else {
        const nonspecific = dx.filter((d) =>
          NONSPECIFIC_DX_PREFIXES.some((p) => text(d).toUpperCase().startsWith(p)),
        );
        if (nonspecific.length === dx.length) {
          findings.push({
            ...base,
            id: `${claimId}:diagnosis_audit:1`,
            tab: "diagnosis_audit",
            riskType: TAB_LABEL.diagnosis_audit,
            code: nonspecific.join(", "),
            issue: "All diagnosis codes are non-specific (encounter / counselling Z-codes)",
            severity: "medium",
            financialImpact: totalCharge,
            ruleId: "diagnosis.nonspecific",
            ruleName: "Non-specific diagnosis on billable claim",
            suggestedCorrection:
              "Replace with a specific ICD-10 from the clinical note that supports medical necessity for the billed services.",
          });
        }
      }

      // Late Documentation
      if (note?.signed_at && serviceDate) {
        const signed = new Date(note.signed_at as string);
        const dos = new Date(serviceDate);
        if (!Number.isNaN(signed.getTime()) && !Number.isNaN(dos.getTime())) {
          const diffDays = Math.floor((signed.getTime() - dos.getTime()) / 86_400_000);
          if (diffDays > LATE_DOC_DAYS) {
            findings.push({
              ...base,
              id: `${claimId}:late_documentation:0`,
              tab: "late_documentation",
              riskType: TAB_LABEL.late_documentation,
              code: `LATE-${diffDays}d`,
              issue: `Clinical note signed ${diffDays} days after date of service (threshold ${LATE_DOC_DAYS}d)`,
              severity: diffDays > 30 ? "high" : "medium",
              financialImpact: totalCharge,
              ruleId: "documentation.late",
              ruleName: `Clinical note signature within ${LATE_DOC_DAYS} days of DOS`,
              suggestedCorrection:
                "Add a late-entry attestation to the chart and document a supervisor override before submission.",
            });
          }
        }
      }

      // Overlapping Services
      for (const ln of lines) {
        const key = `${text(claim.patient_id)}|${text(ln.service_date_from)}|${text(ln.procedure_code)}`;
        const bucket = overlapBuckets.get(key) ?? [];
        const others = bucket.filter((b) => b.claimId !== claimId);
        if (others.length === 0) continue;
        findings.push({
          ...base,
          id: `${claimId}:overlapping_services:${ln.line_number}`,
          tab: "overlapping_services",
          riskType: TAB_LABEL.overlapping_services,
          code: text(ln.procedure_code),
          issue: `${text(ln.procedure_code)} on ${text(ln.service_date_from)} also appears on ${others.length} other claim${others.length > 1 ? "s" : ""} for this client`,
          severity: "high",
          financialImpact: money(ln.charge_amount),
          ruleId: "overlap.duplicate_service",
          ruleName: "Same procedure / DOS billed on multiple claims",
          suggestedCorrection:
            "Confirm both encounters happened (different sessions) and bill with appropriate modifier 59 / XE, or void one of the duplicate claims.",
        });
        break; // one overlap finding per claim is enough for the queue
      }

      // High-Risk Patterns: high-dollar AND ≥2 high-risk modifiers anywhere
      const allMods = lines.flatMap((ln) =>
        (Array.isArray(ln.modifiers) ? ln.modifiers : []).map((m: string) => text(m).toUpperCase()),
      );
      const flaggedMods = allMods.filter((m) => HIGH_RISK_MODIFIERS.has(m));
      if (totalCharge >= HIGH_DOLLAR && flaggedMods.length >= 2) {
        findings.push({
          ...base,
          id: `${claimId}:high_risk_patterns:0`,
          tab: "high_risk_patterns",
          riskType: TAB_LABEL.high_risk_patterns,
          code: `HRP-${flaggedMods.length}M`,
          issue: `High-dollar claim ($${totalCharge.toFixed(0)}) with ${flaggedMods.length} audit modifiers across the lines`,
          severity: "urgent",
          financialImpact: totalCharge,
          ruleId: "pattern.high_dollar_modifiers",
          ruleName: "High-dollar claim with multiple high-audit modifiers",
          suggestedCorrection:
            "Send to supervisor review before submission. Confirm each modifier is documented and that overall reimbursement is supported.",
        });
      }
    }

    // ── Apply universal-rail filters across all tabs ──
    let filtered = findings;
    if (filter.client) {
      const q = filter.client.toLowerCase();
      filtered = filtered.filter((f) => f.patientName.toLowerCase().includes(q));
    }
    if (filter.payer) filtered = filtered.filter((f) => f.payerName === filter.payer);
    if (filter.practice) filtered = filtered.filter((f) => f.practiceLocationId === filter.practice);
    if (filter.clinician) filtered = filtered.filter((f) => f.clinicianId === filter.clinician);
    if (filter.dosFrom) filtered = filtered.filter((f) => (f.serviceDate ?? "") >= filter.dosFrom);
    if (filter.dosTo) filtered = filtered.filter((f) => (f.serviceDate ?? "") <= filter.dosTo);
    if (filter.status) filtered = filtered.filter((f) => f.status === filter.status);
    if (filter.assignedBiller) {
      if (filter.assignedBiller === "__unassigned__") {
        filtered = filtered.filter((f) => !f.assignedToUserId);
      } else {
        filtered = filtered.filter((f) => f.assignedToUserId === filter.assignedBiller);
      }
    }
    if (filter.priority) filtered = filtered.filter((f) => f.workqueuePriority === filter.priority);
    if (filter.carcRarc) {
      const q = filter.carcRarc.toLowerCase();
      filtered = filtered.filter(
        (f) => f.code.toLowerCase().includes(q) || f.ruleId.toLowerCase().includes(q),
      );
    }
    if (filter.followUpDue === "overdue") {
      filtered = filtered.filter((f) => f.followUpDueDate && f.followUpDueDate < todayIso());
    } else if (filter.followUpDue === "today") {
      filtered = filtered.filter((f) => f.followUpDueDate === todayIso());
    } else if (filter.followUpDue === "week") {
      filtered = filtered.filter(
        (f) =>
          f.followUpDueDate &&
          f.followUpDueDate >= todayIso() &&
          f.followUpDueDate <= isoPlusDays(7),
      );
    }
    if (filter.agingBucket && filter.agingBucket !== "all") {
      const now = Date.now();
      filtered = filtered.filter((f) => {
        if (!f.serviceDate) return false;
        const ageDays = Math.floor((now - new Date(f.serviceDate).getTime()) / 86_400_000);
        switch (filter.agingBucket) {
          case "0-7":
            return ageDays <= 7;
          case "8-30":
            return ageDays > 7 && ageDays <= 30;
          case "31-60":
            return ageDays > 30 && ageDays <= 60;
          case "60+":
            return ageDays > 60;
          default:
            return true;
        }
      });
    }

    // Counts per tab (after universal filters, before the active-tab cut)
    const tabCounts: Record<ComplianceTab, number> = {
      missing_signature: 0,
      modifier_audit: 0,
      diagnosis_audit: 0,
      late_documentation: 0,
      overlapping_services: 0,
      high_risk_patterns: 0,
    };
    for (const f of filtered) tabCounts[f.tab] += 1;

    const rows = filtered
      .filter((f) => f.tab === activeTab)
      .sort((a, b) => b.financialImpact - a.financialImpact)
      .slice(0, 500);

    // Header summary — for the active tab.
    const totalDollar = rows.reduce((sum, r) => sum + (r.financialImpact || 0), 0);
    const now = Date.now();
    const ages = rows
      .map((r) =>
        r.serviceDate
          ? Math.floor((now - new Date(r.serviceDate).getTime()) / 86_400_000)
          : null,
      )
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const oldestAge = ages.length ? Math.max(...ages) : 0;
    const urgentCount = rows.filter((r) => r.severity === "urgent" || r.severity === "high").length;

    // Filter-rail option lists (assignees + practices + clinicians).
    const [{ data: billers }, { data: allLocations }] = await Promise.all([
      (supabase as any)
        .from("staff_profiles")
        .select("id, first_name, last_name, email")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .limit(200),
      (supabase as any)
        .from("practice_locations")
        .select("id, name")
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
    ]);
    const assignees = ((billers as DbRow[]) ?? []).map((s) => ({
      id: text(s.id),
      displayName:
        [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
        text(s.email) ||
        "Unknown",
    }));
    const practices = ((allLocations as DbRow[]) ?? []).map((p) => ({
      id: text(p.id),
      name: text(p.name) || "Unnamed practice",
    }));

    return NextResponse.json({
      success: true,
      organizationId,
      activeTab,
      rows,
      tabCounts,
      summary: {
        totalCount: rows.length,
        totalDollar: Math.round(totalDollar * 100) / 100,
        oldestAgeDays: oldestAge,
        urgentCount,
      },
      assignees,
      practices,
      clinicians: assignees, // staff doubles as clinician picker
    });
  } catch (error) {
    console.error("Compliance & Audit API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Compliance & Audit API failed",
      },
      { status: 500 },
    );
  }
}

async function emptyResponse(
  supabase: any,
  organizationId: string,
  activeTab: ComplianceTab,
) {
  const [{ data: billers }, { data: allLocations }] = await Promise.all([
    supabase
      .from("staff_profiles")
      .select("id, first_name, last_name, email")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .limit(200),
    supabase
      .from("practice_locations")
      .select("id, name")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("name", { ascending: true }),
  ]);
  const text = (v: unknown) => String(v ?? "").trim();
  const assignees = ((billers as DbRow[]) ?? []).map((s) => ({
    id: text(s.id),
    displayName:
      [s.first_name, s.last_name].map(text).filter(Boolean).join(" ") ||
      text(s.email) ||
      "Unknown",
  }));
  const practices = ((allLocations as DbRow[]) ?? []).map((p) => ({
    id: text(p.id),
    name: text(p.name) || "Unnamed practice",
  }));
  return NextResponse.json({
    success: true,
    organizationId,
    activeTab,
    rows: [],
    tabCounts: {
      missing_signature: 0,
      modifier_audit: 0,
      diagnosis_audit: 0,
      late_documentation: 0,
      overlapping_services: 0,
      high_risk_patterns: 0,
    },
    summary: { totalCount: 0, totalDollar: 0, oldestAgeDays: 0, urgentCount: 0 },
    assignees,
    practices,
    clinicians: assignees,
  });
}
