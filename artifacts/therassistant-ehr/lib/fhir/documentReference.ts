import type { FhirAttachment, FhirCodeableConcept, FhirReference } from "./common";
import { s } from "./common";

export interface FhirDocumentReference {
  resourceType: "DocumentReference";
  id: string;
  meta?: { lastUpdated?: string };
  status: "current" | "superseded" | "entered-in-error";
  type?: FhirCodeableConcept;
  category?: FhirCodeableConcept[];
  subject?: FhirReference;
  date?: string;
  description?: string;
  content: Array<{ attachment: FhirAttachment }>;
  context?: { encounter?: FhirReference[] };
}

export type DocumentRow = {
  id: string;
  organization_id?: string | null;
  client_id?: string | null;
  encounter_id?: string | null;
  document_scope?: string | null;
  document_type?: string | null;
  title?: string | null;
  file_name?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
};

export const DOCUMENT_DB_COLUMNS =
  "id, organization_id, client_id, encounter_id, document_scope, document_type, title, file_name, storage_bucket, storage_path, mime_type, file_size_bytes, notes, created_at, updated_at, archived_at";

export function documentRowToFhir(row: DocumentRow, baseUrl: string): FhirDocumentReference {
  const archived = s(row.archived_at);
  // Admin-set title only — file_name and notes can contain identifying
  // information (e.g. "<client-name>-intake.pdf" or free-text PHI), so we
  // deliberately do NOT pass them through to partner-facing FHIR output.
  const title = s(row.title);
  // Truly opaque URN keyed only on the DocumentReference id. Raw storage
  // bucket/path are NEVER surfaced — a future signed-URL download endpoint
  // can resolve this back to a fetchable URL after re-checking auth/scopes.
  const url = `urn:ehr:document:${row.id}`;
  const docType = s(row.document_type);

  return {
    resourceType: "DocumentReference",
    id: String(row.id),
    meta: { lastUpdated: s(row.updated_at) },
    status: archived ? "entered-in-error" : "current",
    type: docType
      ? { text: docType, coding: [{ system: "urn:ehr:document-type", code: docType, display: docType }] }
      : undefined,
    category: row.document_scope ? [{ text: row.document_scope }] : undefined,
    subject: row.client_id
      ? { reference: `${baseUrl}/Patient/${row.client_id}`, type: "Client" }
      : undefined,
    date: s(row.created_at),
    description: title,
    content: [{
      attachment: {
        contentType: s(row.mime_type) ?? "application/octet-stream",
        url,
        title,
        size: typeof row.file_size_bytes === "number" ? row.file_size_bytes : undefined,
        creation: s(row.created_at),
      },
    }],
    context: row.encounter_id
      ? { encounter: [{ reference: `${baseUrl}/Encounter/${row.encounter_id}`, type: "Encounter" }] }
      : undefined,
  };
}
