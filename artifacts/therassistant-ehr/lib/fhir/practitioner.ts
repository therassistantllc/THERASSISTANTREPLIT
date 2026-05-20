import type { FhirIdentifier, FhirHumanName, FhirContactPoint } from "./patient";
import type { FhirCodeableConcept } from "./common";
import { s } from "./common";

export interface FhirPractitioner {
  resourceType: "Practitioner";
  id: string;
  meta?: { lastUpdated?: string };
  identifier?: FhirIdentifier[];
  active: boolean;
  name?: FhirHumanName[];
  telecom?: FhirContactPoint[];
  qualification?: Array<{ code: FhirCodeableConcept; identifier?: FhirIdentifier[] }>;
}

export type StaffRow = {
  id: string;
  organization_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  job_title?: string | null;
  provider_npi?: string | null;
  is_active?: boolean | null;
  archived_at?: string | null;
  updated_at?: string | null;
};

export type ProviderProfileRow = {
  staff_id?: string | null;
  provider_npi?: string | null;
  specialty?: string | null;
  credentials?: string | null;
  license_number?: string | null;
  license_state?: string | null;
};

export const PRACTITIONER_STAFF_COLUMNS =
  "id, organization_id, first_name, last_name, email, phone, job_title, provider_npi, is_active, archived_at, updated_at";

export const PRACTITIONER_PROVIDER_COLUMNS =
  "staff_id, provider_npi, specialty, credentials, license_number, license_state";

export function staffToFhirPractitioner(
  row: StaffRow,
  provider?: ProviderProfileRow | null,
): FhirPractitioner {
  const identifiers: FhirIdentifier[] = [];
  const npi = s(provider?.provider_npi) ?? s(row.provider_npi);
  if (npi) {
    identifiers.push({
      use: "official",
      system: "http://hl7.org/fhir/sid/us-npi",
      value: npi,
      type: {
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v2-0203",
          code: "NPI",
          display: "National provider identifier",
        }],
        text: "NPI",
      },
    });
  }

  const first = s(row.first_name);
  const last = s(row.last_name);
  const names: FhirHumanName[] = [];
  if (first || last) {
    names.push({
      use: "official",
      given: first ? [first] : undefined,
      family: last,
      text: [first, last].filter(Boolean).join(" "),
    });
  }

  const telecom: FhirContactPoint[] = [];
  const email = s(row.email);
  if (email) telecom.push({ system: "email", value: email });
  const phone = s(row.phone);
  if (phone) telecom.push({ system: "phone", value: phone, use: "work" });

  const qualification: NonNullable<FhirPractitioner["qualification"]> = [];
  const credentials = s(provider?.credentials);
  const specialty = s(provider?.specialty);
  const jobTitle = s(row.job_title);
  const qualText = [credentials, specialty, jobTitle].filter(Boolean).join(" — ");
  if (qualText) qualification.push({ code: { text: qualText } });
  const licenseNumber = s(provider?.license_number);
  if (licenseNumber) {
    qualification.push({
      code: { text: `License${provider?.license_state ? ` (${provider.license_state})` : ""}` },
      identifier: [{ value: licenseNumber, system: "urn:ehr:license" }],
    });
  }

  const archived = s(row.archived_at);
  const active = !archived && row.is_active !== false;

  return {
    resourceType: "Practitioner",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    identifier: identifiers.length ? identifiers : undefined,
    active,
    name: names.length ? names : undefined,
    telecom: telecom.length ? telecom : undefined,
    qualification: qualification.length ? qualification : undefined,
  };
}
