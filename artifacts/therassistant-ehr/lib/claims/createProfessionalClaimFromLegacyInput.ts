export type LegacyClaimInput = {
  id?: string;
  organization_id: string;
  client_id?: string | null;
  encounter_id?: string | null;
  claim_number?: string | null;
  claim_status?: string | null;
  total_charge_amount?: number | string | null;
};

type ProfessionalClaimInput = {
  id?: string;
  organization_id: string;
  client_id: string | null;
  patient_id: string | null;
  encounter_id: string | null;
  claim_number: string | null;
  claim_status: string;
  total_charge: number;
};

const legacyToProfessionalStatus: Record<string, string> = {
  ready_to_submit: "ready_for_validation",
};

function normalizeClaimStatus(status: string | null | undefined): string {
  if (!status) return "draft";
  return legacyToProfessionalStatus[status] ?? status;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function mapLegacyClaimInputToProfessionalClaim(input: LegacyClaimInput): ProfessionalClaimInput {
  return {
    ...(input.id && { id: input.id }),
    organization_id: input.organization_id,
    client_id: input.client_id ?? null,
    patient_id: input.client_id ?? null,
    encounter_id: input.encounter_id ?? null,
    claim_number: input.claim_number ?? null,
    claim_status: normalizeClaimStatus(input.claim_status),
    total_charge: toNumber(input.total_charge_amount),
  };
}
