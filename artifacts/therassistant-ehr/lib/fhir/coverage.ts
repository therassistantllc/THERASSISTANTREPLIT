import type { FhirCoding, FhirPeriod, FhirReference } from "./common";
import { s } from "./common";

export interface FhirCoverage {
  resourceType: "Coverage";
  id: string;
  meta?: { lastUpdated?: string };
  status: "active" | "cancelled" | "draft" | "entered-in-error";
  type?: { coding?: FhirCoding[]; text?: string };
  subscriberId?: string;
  beneficiary: FhirReference;
  relationship?: { coding?: FhirCoding[]; text?: string };
  period?: FhirPeriod;
  payor: FhirReference[];
  class?: Array<{
    type: { coding?: FhirCoding[]; text?: string };
    value: string;
    name?: string;
  }>;
}

export type IntakeSubmissionRow = {
  id: string;
  organization_id?: string | null;
  client_id: string;
  status?: string | null;
  // intake_submissions.insurance is a free-form jsonb captured during intake.
  // We extract a small set of well-known keys when present.
  insurance?: Record<string, unknown> | null;
  submitted_at?: string | null;
  created_at?: string | null;
};

export const COVERAGE_DB_COLUMNS =
  "id, organization_id, client_id, status, insurance, submitted_at, created_at";

function pickStr(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function intakeRowToCoverage(row: IntakeSubmissionRow, baseUrl: string): FhirCoverage {
  const ins = row.insurance ?? {};
  const payerName = pickStr(ins, "payerName", "payer_name", "carrier", "insuranceName");
  const memberId = pickStr(ins, "memberId", "member_id", "policyNumber", "policy_number", "subscriberId");
  const planName = pickStr(ins, "planName", "plan_name", "group", "groupName");
  const relationship = pickStr(ins, "relationship", "relationshipToInsured");
  const effective = pickStr(ins, "effectiveDate", "effective_date", "startDate");
  const termination = pickStr(ins, "terminationDate", "termination_date", "endDate");

  const hasData = Boolean(payerName || memberId || planName);

  return {
    resourceType: "Coverage",
    id: String(row.id),
    meta: { lastUpdated: s(row.submitted_at) ?? s(row.created_at) },
    status: hasData ? "active" : "draft",
    type: { text: "Health insurance" },
    subscriberId: memberId,
    beneficiary: { reference: `${baseUrl}/Patient/${row.client_id}`, type: "Patient" },
    relationship: relationship ? { text: relationship } : undefined,
    period: effective || termination
      ? { start: effective, end: termination }
      : undefined,
    payor: [{ display: payerName ?? "Unknown payer" }],
    class: planName
      ? [{ type: { text: "Plan" }, value: planName, name: planName }]
      : undefined,
  };
}
