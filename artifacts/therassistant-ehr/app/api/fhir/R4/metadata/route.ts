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
        ],
      },
    ],
  });
}
