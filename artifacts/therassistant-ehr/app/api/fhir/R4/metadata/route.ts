import { fhirJson } from "@/lib/fhir/patient";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = `${url.protocol}//${url.host}/api/fhir/R4`;

  return fhirJson({
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    publisher: "TherassistantEHR",
    software: { name: "TherassistantEHR", version: "0.1.0" },
    implementation: { description: "TherassistantEHR FHIR R4 (minimal)", url: base },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json", "json"],
    rest: [
      {
        mode: "server",
        security: {
          description:
            "Behind the same application auth as the rest of the EHR for the first cut. Public/partner access (SMART-on-FHIR, Bulk Data) is a follow-up.",
        },
        resource: [
          {
            type: "Patient",
            profile: "http://hl7.org/fhir/StructureDefinition/Patient",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "identifier", type: "token", documentation: "Match clients by MRN or external client reference." },
              { name: "name", type: "string", documentation: "Case-insensitive match against given, family, or preferred name." },
              { name: "family", type: "string" },
              { name: "given", type: "string" },
              { name: "birthdate", type: "date", documentation: "Exact YYYY-MM-DD match against date_of_birth." },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "Practitioner",
            profile: "http://hl7.org/fhir/StructureDefinition/Practitioner",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "identifier", type: "token", documentation: "Match by NPI." },
              { name: "name", type: "string", documentation: "Case-insensitive match against given or family name." },
              { name: "family", type: "string" },
              { name: "given", type: "string" },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "Encounter",
            profile: "http://hl7.org/fhir/StructureDefinition/Encounter",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference", documentation: "Patient/{id} or bare {id}." },
              { name: "date", type: "date", documentation: "Exact YYYY-MM-DD match against service_date." },
              { name: "status", type: "token", documentation: "Filter by raw encounter_status." },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "Observation",
            profile: "http://hl7.org/fhir/StructureDefinition/Observation",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference", documentation: "Patient/{id} or bare {id}." },
              { name: "date", type: "date", documentation: "Exact YYYY-MM-DD match against submitted_at::date." },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "Appointment",
            profile: "http://hl7.org/fhir/StructureDefinition/Appointment",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference", documentation: "Patient/{id} or bare {id}." },
              { name: "practitioner", type: "reference", documentation: "Practitioner/{id} or bare {id}." },
              { name: "date", type: "date", documentation: "Exact YYYY-MM-DD match against scheduled_start_at::date." },
              { name: "status", type: "token" },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "Coverage",
            profile: "http://hl7.org/fhir/StructureDefinition/Coverage",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "beneficiary", type: "reference", documentation: "Patient/{id} or bare {id}." },
              { name: "patient", type: "reference", documentation: "Alias for beneficiary." },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
          {
            type: "DocumentReference",
            profile: "http://hl7.org/fhir/StructureDefinition/DocumentReference",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "patient", type: "reference", documentation: "Patient/{id} or bare {id}." },
              { name: "type", type: "token", documentation: "Filter by document_type." },
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          },
        ],
      },
    ],
  });
}
