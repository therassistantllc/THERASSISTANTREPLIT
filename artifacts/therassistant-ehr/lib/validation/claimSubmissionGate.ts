import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { runConfigValidation } from "./runValidation";
import { runClaimContentValidation } from "./claim/runClaimContentValidation";
import type { ValidationFinding, ValidationReport, ValidationSummary } from "./types";

/**
 * A two-section readiness report: system configuration findings (from the
 * Configuration Validation Engine) plus per-claim content findings (from
 * the Claim Content Validation Engine). The combined summary is what the
 * gate actually enforces; the two reports stay grouped separately so the
 * UI can render them under distinct headings.
 */
interface CombinedReadinessReport {
  organizationId: string;
  claimId: string | null;
  generatedAt: string;
  systemReadiness: ValidationReport;
  claimContent: ValidationReport | null;
  combined: ValidationSummary;
}

export type GateResult =
  | { ok: true; report: ValidationReport; claimContentReport?: ValidationReport | null; combined?: CombinedReadinessReport }
  | {
      ok: false;
      reason: "missing_organization_id" | "missing_claim_id" | "database_unavailable" | "blocking_findings" | "engine_error";
      message: string;
      report?: ValidationReport;
      claimContentReport?: ValidationReport | null;
      combined?: CombinedReadinessReport;
      blockingFindings?: ValidationFinding[];
      findingsByCategory?: ValidationReport["findingsByCategory"];
      summary?: ValidationSummary;
    };

function combinedSummary(
  system: ValidationReport,
  claim: ValidationReport | null,
): ValidationSummary {
  const blocking = system.summary.blocking + (claim?.summary.blocking ?? 0);
  const warning = system.summary.warning + (claim?.summary.warning ?? 0);
  const info = system.summary.info + (claim?.summary.info ?? 0);
  const total = system.summary.total + (claim?.summary.total ?? 0);
  return { blocking, warning, info, total, ready: blocking === 0 };
}

/**
 * System-only gate. Use this for routes that operate at the organization
 * level (no specific claim yet) — e.g. raw 837 file transmission, batch
 * eligibility, or readiness queries that fan out across claims.
 *
 * Use {@link gateResponse} to convert a non-ok result into a NextResponse
 * with HTTP 422 and the standard gate body.
 */
export async function assertClaimSubmissionReady(
  organizationId: string | null | undefined,
): Promise<GateResult> {
  if (!organizationId) {
    return {
      ok: false,
      reason: "missing_organization_id",
      message: "organizationId is required to run the claim submission readiness gate.",
    };
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      reason: "database_unavailable",
      message: "Database connection not available; cannot evaluate claim submission readiness.",
    };
  }

  let report: ValidationReport;
  try {
    report = await runConfigValidation(supabase, organizationId);
  } catch (err) {
    return {
      ok: false,
      reason: "engine_error",
      message: err instanceof Error ? err.message : "Validation engine failed.",
    };
  }

  if (report.summary.blocking > 0) {
    const blockingFindings = report.findings.filter((f) => f.severity === "blocking");
    return {
      ok: false,
      reason: "blocking_findings",
      message:
        `Claim submission blocked by ${blockingFindings.length} configuration finding` +
        `${blockingFindings.length === 1 ? "" : "s"}. ` +
        "Resolve every blocking item in System Readiness before generating or transmitting claims.",
      report,
      blockingFindings,
      findingsByCategory: report.findingsByCategory,
      summary: report.summary,
    };
  }

  return { ok: true, report };
}

/**
 * Combined gate. Runs system readiness AND per-claim content validation
 * against the same canonical claim facts used by Phase 3 eligibility.
 * Blocks submission if EITHER section has any blocking finding.
 *
 * Use this in routes that operate on a specific claim id (e.g. 837P
 * single-claim generate, batch transmit, readiness panel).
 */
export async function assertClaimReadyForSubmission(args: {
  organizationId: string | null | undefined;
  claimId: string | null | undefined;
}): Promise<GateResult> {
  if (!args.organizationId) {
    return {
      ok: false,
      reason: "missing_organization_id",
      message: "organizationId is required to run the claim readiness gate.",
    };
  }
  if (!args.claimId) {
    return {
      ok: false,
      reason: "missing_claim_id",
      message: "claimId is required to run the per-claim readiness gate.",
    };
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return {
      ok: false,
      reason: "database_unavailable",
      message: "Database connection not available; cannot evaluate claim readiness.",
    };
  }

  let systemReport: ValidationReport;
  let claimReport: ValidationReport;
  try {
    const [sys, claim] = await Promise.all([
      runConfigValidation(supabase, args.organizationId),
      runClaimContentValidation(supabase, args.organizationId, args.claimId).then((r) => r.report),
    ]);
    systemReport = sys;
    claimReport = claim;
  } catch (err) {
    return {
      ok: false,
      reason: "engine_error",
      message: err instanceof Error ? err.message : "Validation engine failed.",
    };
  }

  const combined: CombinedReadinessReport = {
    organizationId: args.organizationId,
    claimId: args.claimId,
    generatedAt: new Date().toISOString(),
    systemReadiness: systemReport,
    claimContent: claimReport,
    combined: combinedSummary(systemReport, claimReport),
  };

  if (combined.combined.blocking > 0) {
    const blockingFindings = [
      ...systemReport.findings.filter((f) => f.severity === "blocking"),
      ...claimReport.findings.filter((f) => f.severity === "blocking"),
    ];
    return {
      ok: false,
      reason: "blocking_findings",
      message:
        `Claim submission blocked by ${blockingFindings.length} finding` +
        `${blockingFindings.length === 1 ? "" : "s"} ` +
        `(${systemReport.summary.blocking} system, ${claimReport.summary.blocking} claim-content). ` +
        "Resolve every blocking item before generating or transmitting this claim.",
      report: systemReport,
      claimContentReport: claimReport,
      combined,
      blockingFindings,
      findingsByCategory: systemReport.findingsByCategory,
      summary: combined.combined,
    };
  }

  return { ok: true, report: systemReport, claimContentReport: claimReport, combined };
}

/**
 * Build the standard NextResponse for a failed gate result. Returns null when
 * the gate passed (callers should continue normally in that case).
 */
export function gateResponse(gate: GateResult): NextResponse | null {
  if (gate.ok) return null;

  const status =
    gate.reason === "missing_organization_id" || gate.reason === "missing_claim_id"
      ? 400
      : gate.reason === "database_unavailable" || gate.reason === "engine_error"
        ? 503
        : 422; // blocking_findings

  return NextResponse.json(
    {
      success: false,
      error: gate.message,
      gate: {
        blocked: true,
        reason: gate.reason,
        summary: gate.summary,
        blockingFindings: gate.blockingFindings,
        findingsByCategory: gate.findingsByCategory,
        systemReadiness: gate.report
          ? { summary: gate.report.summary, findings: gate.report.findings }
          : undefined,
        claimContent: gate.claimContentReport
          ? { summary: gate.claimContentReport.summary, findings: gate.claimContentReport.findings }
          : undefined,
        combined: gate.combined?.combined,
        fixRoute: "/settings/system-readiness",
      },
    },
    { status },
  );
}
