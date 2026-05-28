// Minimal hand-rolled FHIR R4 typings sufficient for the Client surface we
// expose today. Avoids pulling in a heavy FHIR resource library.

type FhirGender = "male" | "female" | "other" | "unknown";

export interface FhirIdentifier {
  use?: "usual" | "official" | "temp" | "secondary" | "old";
  system?: string;
  value: string;
  type?: { coding: { system: string; code: string; display?: string }[]; text?: string };
}

export interface FhirHumanName {
  use?: "usual" | "official" | "temp" | "nickname" | "anonymous" | "old" | "maiden";
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirContactPoint {
  system: "phone" | "fax" | "email" | "pager" | "url" | "sms" | "other";
  value: string;
  use?: "home" | "work" | "temp" | "old" | "mobile";
}

interface FhirAddress {
  use?: "home" | "work" | "temp" | "old" | "billing";
  type?: "postal" | "physical" | "both";
  line?: string[];
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface FhirClient {
  resourceType: "Client";
  id: string;
  meta?: { lastUpdated?: string; profile?: string[] };
  identifier?: FhirIdentifier[];
  active: boolean;
  name?: FhirHumanName[];
  telecom?: FhirContactPoint[];
  gender?: FhirGender;
  birthDate?: string;
  deceasedDateTime?: string;
  deceasedBoolean?: boolean;
  address?: FhirAddress[];
}

export interface FhirOperationOutcomeIssue {
  severity: "fatal" | "error" | "warning" | "information";
  code: string;
  diagnostics?: string;
}

interface FhirOperationOutcome {
  resourceType: "OperationOutcome";
  issue: FhirOperationOutcomeIssue[];
}

interface FhirBundleEntry<T> {
  fullUrl: string;
  resource: T;
  search?: { mode: "match" | "include" | "outcome" };
}

export interface FhirBundle<T> {
  resourceType: "Bundle";
  type: "searchset";
  total: number;
  link?: { relation: string; url: string }[];
  entry: FhirBundleEntry<T>[];
}

export type ClientRow = {
  id: string;
  organization_id?: string | null;
  mrn?: string | null;
  external_client_ref?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  date_of_birth?: string | null;
  sex_at_birth?: string | null;
  gender_identity?: string | null;
  phone?: string | null;
  email?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  deceased_at?: string | null;
  archived_at?: string | null;
  updated_at?: string | null;
};

function s(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const out = String(value).trim();
  return out ? out : undefined;
}

function mapGender(sexAtBirth?: string | null, genderIdentity?: string | null): FhirGender {
  const v = (genderIdentity || sexAtBirth || "").toLowerCase().trim();
  if (v === "m" || v === "male") return "male";
  if (v === "f" || v === "female") return "female";
  if (v === "o" || v === "other" || v === "nonbinary" || v === "non-binary") return "other";
  return "unknown";
}

export function clientToFhirClient(row: ClientRow, baseUrl?: string): FhirClient {
  const identifiers: FhirIdentifier[] = [];
  const mrn = s(row.mrn);
  if (mrn) {
    identifiers.push({
      use: "usual",
      system: baseUrl ? `${baseUrl}/identifier/mrn` : "urn:ehr:mrn",
      value: mrn,
      type: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }],
        text: "MRN",
      },
    });
  }
  const externalRef = s(row.external_client_ref);
  if (externalRef) {
    identifiers.push({
      use: "secondary",
      system: baseUrl ? `${baseUrl}/identifier/external` : "urn:ehr:external",
      value: externalRef,
    });
  }

  const given: string[] = [];
  const first = s(row.first_name);
  const middle = s(row.middle_name);
  if (first) given.push(first);
  if (middle) given.push(middle);
  const family = s(row.last_name);
  const names: FhirHumanName[] = [];
  if (given.length || family) {
    names.push({
      use: "official",
      family,
      given: given.length ? given : undefined,
      text: [first, middle, family].filter(Boolean).join(" ") || undefined,
    });
  }
  const preferred = s(row.preferred_name);
  if (preferred && preferred !== first) {
    names.push({ use: "usual", given: [preferred], text: preferred });
  }

  const telecom: FhirContactPoint[] = [];
  const phone = s(row.phone);
  if (phone) telecom.push({ system: "phone", value: phone, use: "home" });
  const email = s(row.email);
  if (email) telecom.push({ system: "email", value: email });

  const addressLines = [s(row.address_line_1), s(row.address_line_2)].filter((x): x is string => Boolean(x));
  const city = s(row.city);
  const state = s(row.state);
  const postal = s(row.postal_code);
  const address: FhirAddress[] = [];
  if (addressLines.length || city || state || postal) {
    address.push({
      use: "home",
      type: "physical",
      line: addressLines.length ? addressLines : undefined,
      city,
      state,
      postalCode: postal,
    });
  }

  const archived = s(row.archived_at);
  const deceased = s(row.deceased_at);

  const client: FhirClient = {
    resourceType: "Client",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    identifier: identifiers.length ? identifiers : undefined,
    active: !archived && !deceased,
    name: names.length ? names : undefined,
    telecom: telecom.length ? telecom : undefined,
    gender: mapGender(row.sex_at_birth, row.gender_identity),
    birthDate: s(row.date_of_birth),
    address: address.length ? address : undefined,
  };
  if (deceased) client.deceasedDateTime = deceased;
  return client;
}

export const PATIENT_DB_COLUMNS =
  "id, organization_id, mrn, external_client_ref, first_name, middle_name, last_name, preferred_name, date_of_birth, sex_at_birth, gender_identity, phone, email, address_line_1, address_line_2, city, state, postal_code, deceased_at, archived_at, updated_at";

export function fhirJson<T>(body: T, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/fhir+json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export function operationOutcome(
  severity: FhirOperationOutcomeIssue["severity"],
  code: string,
  diagnostics: string,
  status = 400,
): Response {
  const body: FhirOperationOutcome = { resourceType: "OperationOutcome", issue: [{ severity, code, diagnostics }] };
  return fhirJson(body, { status });
}
