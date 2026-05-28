/**
 * POST /api/payments/parse-835-preview
 *
 * Parses an 835 ERA file and returns structured preview data
 * (header fields + service-line rows with client-match status).
 * Does NOT write anything to the database — use /api/payments/import-835
 * to commit.
 */
import { NextResponse } from "next/server";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { parse835 } from "@/lib/clearinghouse/parsers/parse835";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function money(v: number | null | undefined): number {
  return Number(v ?? 0);
}

export interface PreviewRow {
  rowId: string;
  claimControlNumber: string | null;
  // Client info
  patientName: string | null;
  patientId: string | null;
  patientFound: boolean;
  patientFirstName: string | null;
  patientLastName: string | null;
  patientMemberId: string | null;
  payerName: string | null;
  // Service line fields
  dateOfService: string | null;
  providerName: string | null;
  cptCode: string | null;
  chargeAmount: number;
  allowedAmount: number;
  adjustmentAmount: number;
  carcRarc: string;
  patientResponsibility: number;
  amountPaid: number;
  // Original amounts for balance tracking
  claimPaidAmount: number;
  claimTotalCharge: number;
  claimPatientResponsibility: number;
}

export interface PreviewResponse {
  ok: true;
  header: {
    organizationName: string | null;
    payerName: string | null;
    eraDate: string | null;
    paymentNumber: string | null;
    totalPaid: number;
    totalAdjustment: number;
    totalPatientResponsibility: number;
  };
  rows: PreviewRow[];
  claimsCount: number;
  unmatchedCount: number;
}

let rowCounter = 0;
function nextRowId(): string {
  return `row-${++rowCounter}-${Date.now()}`;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const submittedOrgId = String(formData.get("organizationId") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "835 file is required" }, { status: 400 });
    }

    const guard = await requireOrgAccess({ requestedOrganizationId: submittedOrgId || null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const raw835 = await file.text();

    if (!raw835.includes("ISA")) {
      return NextResponse.json(
        { ok: false, error: "File does not appear to be a valid 835 ERA" },
        { status: 422 },
      );
    }

    const parsed = parse835(raw835);

    // Look up organization name
    const supabase = createServerSupabaseAdminClient();
    let organizationName: string | null = null;
    if (supabase) {
      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", organizationId)
        .maybeSingle();
      organizationName = org?.name ?? null;
    }

    // Build rows: one per service line per claim
    const rows: PreviewRow[] = [];
    let totalAdjustment = 0;
    let totalPatientResponsibility = 0;

    // Gather claim control numbers for batch client matching
    const claimControlNumbers = parsed.claims
      .map((c) => c.patientControlNumber)
      .filter((n): n is string => Boolean(n));

    // Match claims to DB clients
    const claimMatchMap = new Map<string, { clientId: string; clientName: string } | null>();

    if (supabase && claimControlNumbers.length > 0) {
      // Try claim_number match
      const { data: byNumber } = await supabase
        .from("claims")
        .select("id, claim_number, client_id, clients(first_name, last_name)")
        .eq("organization_id", organizationId)
        .in("claim_number", claimControlNumbers);

      for (const row of byNumber ?? []) {
        if (row.claim_number && row.client_id) {
          const c = row.clients as unknown as { first_name: string | null; last_name: string | null } | null;
          claimMatchMap.set(row.claim_number, {
            clientId: row.client_id,
            clientName: c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Unknown",
          });
        }
      }

      // Try UUID-based claim ID match for any unmatched UUIDs
      const uuidNumbers = claimControlNumbers.filter(
        (n) => isUuid(n) && !claimMatchMap.has(n),
      );
      if (uuidNumbers.length > 0) {
        const { data: byId } = await supabase
          .from("claims")
          .select("id, client_id, clients(first_name, last_name)")
          .eq("organization_id", organizationId)
          .in("id", uuidNumbers);

        for (const row of byId ?? []) {
          if (row.client_id) {
            const c = row.clients as unknown as { first_name: string | null; last_name: string | null } | null;
            claimMatchMap.set(row.id, {
              clientId: row.client_id,
              clientName: c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "Unknown",
            });
          }
        }
      }
    }

    for (const claim of parsed.claims) {
      const match = claim.patientControlNumber
        ? (claimMatchMap.get(claim.patientControlNumber) ?? null)
        : null;

      const claimPR = money(claim.patientResponsibilityAmount);
      totalPatientResponsibility += claimPR;

      // Build client name from ERA data or matched client
      const patientFirstName = claim.patientFirstName ?? null;
      const patientLastName = claim.patientLastName ?? null;
      const patientName = match?.clientName ?? 
        (patientFirstName && patientLastName ? `${patientFirstName} ${patientLastName}`.trim() : null);

      // Client responsibility: use service line PR adjustments, not proportional distribution
      const numLines = claim.serviceLines.length || 1;

      for (const sl of claim.serviceLines) {
        const chargeAmt = money(sl.chargeAmount);
        const paidAmt = money(sl.paidAmount);

        // Sum all adjustments for this service line
        const adjAmt = sl.adjustments.reduce((sum, a) => sum + money(a.amount), 0);
        totalAdjustment += adjAmt;

        // Allowed = charge - contractual (CO) adjustments
        const coAdj = sl.adjustments
          .filter((a) => a.groupCode === "CO")
          .reduce((sum, a) => sum + money(a.amount), 0);
        const allowedAmt = chargeAmt - coAdj;

        // Client Responsibility (PR) = sum of PR group adjustments
        const prAdj = sl.adjustments
          .filter((a) => a.groupCode === "PR")
          .reduce((sum, a) => sum + money(a.amount), 0);
        
        // If no PR adjustments at service line level, distribute claim PR
        const servicePR = prAdj > 0 ? prAdj : (claimPR / numLines);

        // CARC/RARC: comma-list of groupCode-reasonCode pairs
        const carcParts = sl.adjustments
          .filter((a) => a.reasonCode)
          .map((a) => [a.groupCode, a.reasonCode].filter(Boolean).join("-"));
        const carcRarc = [...new Set(carcParts)].join(", ");

        rows.push({
          rowId: nextRowId(),
          claimControlNumber: claim.patientControlNumber,
          patientName,
          patientId: match?.clientId ?? null,
          patientFound: Boolean(match),
          patientFirstName,
          patientLastName,
          patientMemberId: claim.patientMemberId,
          payerName: claim.payerName,
          dateOfService: sl.serviceDate,
          providerName: claim.payeeName,
          cptCode: sl.procedureCode,
          chargeAmount: chargeAmt,
          allowedAmount: allowedAmt,
          adjustmentAmount: adjAmt,
          carcRarc,
          patientResponsibility: servicePR,
          amountPaid: paidAmt,
          claimPaidAmount: money(claim.paidAmount),
          claimTotalCharge: money(claim.totalChargeAmount),
          claimPatientResponsibility: claimPR,
        });
      }

      // Claims with no service lines still need a row
      if (claim.serviceLines.length === 0) {
        const adjAmt = claim.adjustments.reduce((sum, a) => sum + money(a.amount), 0);
        totalAdjustment += adjAmt;
        const carcParts = claim.adjustments
          .filter((a) => a.reasonCode)
          .map((a) => [a.groupCode, a.reasonCode].filter(Boolean).join("-"));

        rows.push({
          rowId: nextRowId(),
          claimControlNumber: claim.patientControlNumber,
          patientName,
          patientId: match?.clientId ?? null,
          patientFound: Boolean(match),
          patientFirstName,
          patientLastName,
          patientMemberId: claim.patientMemberId,
          payerName: claim.payerName,
          dateOfService: null,
          providerName: claim.payeeName,
          cptCode: null,
          chargeAmount: money(claim.totalChargeAmount),
          allowedAmount: money(claim.paidAmount),
          adjustmentAmount: adjAmt,
          carcRarc: carcParts.join(", "),
          patientResponsibility: claimPR,
          amountPaid: money(claim.paidAmount),
          claimPaidAmount: money(claim.paidAmount),
          claimTotalCharge: money(claim.totalChargeAmount),
          claimPatientResponsibility: claimPR,
        });
      }
    }

    const unmatchedCount = parsed.claims.filter(
      (c) => c.patientControlNumber && !claimMatchMap.has(c.patientControlNumber),
    ).length;

    return NextResponse.json({
      ok: true,
      header: {
        organizationName,
        payerName: parsed.payerName,
        eraDate: parsed.paymentDate,
        paymentNumber: parsed.checkOrEftNumber,
        totalPaid: money(parsed.totalPaymentAmount),
        totalAdjustment,
        totalPatientResponsibility,
      },
      rows,
      claimsCount: parsed.claims.length,
      unmatchedCount,
    } satisfies PreviewResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Preview failed";
    console.error("[parse-835-preview]", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
