export const CLIENT_IMPORT_CANONICAL_FIELDS = [
  "source_client_id",
  "first_name",
  "last_name",
  "date_of_birth",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "primary_insurance_name",
  "primary_member_id",
  "primary_group_id",
  "primary_policy_number",
  "secondary_insurance_name",
  "secondary_member_id",
  "secondary_policy_number",
  "responsible_party_name",
  "emergency_contact_name",
  "emergency_contact_phone",
  "assigned_clinician_name",
  "status",
] as const;

export type CanonicalClientImportField = (typeof CLIENT_IMPORT_CANONICAL_FIELDS)[number];
export type ClientImportMapping = Record<CanonicalClientImportField, string | null>;

const HEADER_MATCHERS: Record<CanonicalClientImportField, string[]> = {
  source_client_id: [
    "source client id",
    "source client id",
    "ehr client id",
    "external client id",
    "external id",
    "client id",
    "client id",
    "mrn",
  ],
  first_name: ["first name", "client first name", "client first name", "fname", "given name"],
  last_name: ["last name", "client last name", "client last name", "lname", "surname", "family name"],
  date_of_birth: ["dob", "date of birth", "birth date", "birthday"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "mobile phone", "primary phone", "cell", "cell phone", "phone number"],
  address_line1: ["address", "street", "address line 1", "street address", "address1"],
  address_line2: ["address line 2", "suite", "apt", "apartment", "address2"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  postal_code: ["zip", "zip code", "postal code", "postcode"],
  primary_insurance_name: ["insurance", "primary insurance", "payer", "primary payer", "insurance company"],
  primary_member_id: ["member id", "subscriber id", "policy number", "primary member id"],
  primary_group_id: ["group id", "group number", "primary group id"],
  primary_policy_number: ["primary policy number", "primary policy", "policy id"],
  secondary_insurance_name: ["secondary insurance", "secondary payer"],
  secondary_member_id: ["secondary member id", "secondary subscriber id", "secondary policy number"],
  secondary_policy_number: ["secondary policy number", "secondary policy"],
  responsible_party_name: ["responsible party", "guarantor", "responsible party name"],
  emergency_contact_name: ["emergency contact", "emergency contact name"],
  emergency_contact_phone: ["emergency contact phone", "emergency phone"],
  assigned_clinician_name: ["assigned clinician", "clinician", "provider", "therapist"],
  status: ["status", "client status", "client status", "active"],
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function proposeClientImportMapping(headers: string[]): ClientImportMapping {
  const normalizedHeaders = headers.map((header) => ({
    header,
    normalized: normalizeHeader(header),
  }));

  const mapping = {} as ClientImportMapping;

  for (const field of CLIENT_IMPORT_CANONICAL_FIELDS) {
    const aliases = HEADER_MATCHERS[field].map(normalizeHeader);
    const exact = normalizedHeaders.find((entry) => aliases.includes(entry.normalized));

    if (exact) {
      mapping[field] = exact.header;
      continue;
    }

    const partial = normalizedHeaders.find((entry) => aliases.some((alias) => entry.normalized.includes(alias)));
    mapping[field] = partial?.header ?? null;
  }

  return mapping;
}

export function applyClientImportMapping(
  rawData: Record<string, unknown>,
  mapping: ClientImportMapping
): Record<CanonicalClientImportField, string | null> {
  const mapped = {} as Record<CanonicalClientImportField, string | null>;

  for (const field of CLIENT_IMPORT_CANONICAL_FIELDS) {
    const sourceHeader = mapping[field];
    if (!sourceHeader) {
      mapped[field] = null;
      continue;
    }

    const value = rawData[sourceHeader];
    if (value === null || value === undefined) {
      mapped[field] = null;
      continue;
    }

    const asText = String(value).trim();
    mapped[field] = asText.length > 0 ? asText : null;
  }

  return mapped;
}
