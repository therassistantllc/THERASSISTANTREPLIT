import { NextResponse } from "next/server";
import { CLIENT_IMPORT_CANONICAL_FIELDS } from "@/lib/imports/clientImportMappingService";

const SAMPLE_ROW: Record<string, string> = {
  source_client_id: "EXT-1001",
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: "1985-04-12",
  email: "jane.doe@example.com",
  phone: "555-123-4567",
  address_line1: "123 Main St",
  address_line2: "Apt 2B",
  city: "Springfield",
  state: "IL",
  postal_code: "62704",
  primary_insurance_name: "Blue Cross Blue Shield",
  primary_member_id: "BCBS123456",
  primary_group_id: "GRP-789",
  primary_policy_number: "POL-001",
  secondary_insurance_name: "",
  secondary_member_id: "",
  secondary_policy_number: "",
  responsible_party_name: "",
  emergency_contact_name: "John Doe",
  emergency_contact_phone: "555-987-6543",
  assigned_clinician_name: "",
  status: "active",
};

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function GET() {
  const headers = [...CLIENT_IMPORT_CANONICAL_FIELDS];
  const headerLine = headers.map(csvEscape).join(",");
  const sampleLine = headers
    .map((field) => csvEscape(SAMPLE_ROW[field] ?? ""))
    .join(",");
  const body = `${headerLine}\n${sampleLine}\n`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="client-import-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
