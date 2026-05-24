"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import {
  buildFilePayload,
  canFileDocument,
  destinationRequiresTarget,
  getEntityTypeForDestination,
  type FilingDestination,
} from "@/lib/mailroom/filing";
import EntityPicker, { type EntityResult, type EntityType } from "./EntityPicker";

type MailroomItem = {
  id: string;
  organizationId: string;
  clientId: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
  status: string;
  documentType: string;
  source: string;
  notes: string;
  adminComments: string;
  createdAt: string;
};

type LinkedPatient = { id: string; name: string; dob: string; archived: boolean };
type LinkedEncounter = { id: string; serviceDate: string; providerName: string; archived: boolean };
type LinkedClaim = { id: string; claimNumber: string; serviceDateFrom: string; payerName: string; archived: boolean };

type DetailResponse = {
  success?: boolean;
  item?: MailroomItem;
  patient?: LinkedPatient | null;
  encounter?: LinkedEncounter | null;
  claim?: LinkedClaim | null;
  error?: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function MailroomItemClient({ itemId }: { itemId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [item, setItem] = useState<MailroomItem | null>(null);
  const [patient, setPatient] = useState<LinkedPatient | null>(null);
  const [encounter, setEncounter] = useState<LinkedEncounter | null>(null);
  const [claim, setClaim] = useState<LinkedClaim | null>(null);
  const [filingDestination, setFilingDestination] = useState<FilingDestination>("patient_chart");
  const [selectedEntity, setSelectedEntity] = useState<EntityResult | null>(null);
  const [adminComments, setAdminComments] = useState("");
  const [loading, setLoading] = useState(true);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [relinkDestination, setRelinkDestination] = useState<FilingDestination>("patient_chart");
  const [relinkEntity, setRelinkEntity] = useState<EntityResult | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [relinkMessage, setRelinkMessage] = useState<string | null>(null);

  const requiresTarget = destinationRequiresTarget(filingDestination);
  const entityType: EntityType | null = getEntityTypeForDestination(filingDestination);
  const relinkRequiresTarget = destinationRequiresTarget(relinkDestination);
  const relinkEntityType: EntityType | null = getEntityTypeForDestination(relinkDestination);

  async function loadItem() {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/mailroom/items/${itemId}?organizationId=${encodeURIComponent(organizationId)}`);
    const json = (await response.json()) as DetailResponse;
    if (!response.ok || !json.success || !json.item) {
      setError(json.error || "Unable to load mailroom item.");
    } else {
      setItem(json.item);
      setPatient(json.patient ?? null);
      setEncounter(json.encounter ?? null);
      setClaim(json.claim ?? null);
      setAdminComments(json.item.adminComments || "");
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (organizationId && itemId) void loadItem();
    else {
      setError("Missing organizationId or mailroom item ID.");
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, itemId]);

  // Clear the picked entity whenever the user switches filing destination —
  // a claim ID is not interchangeable with a patient or encounter ID.
  useEffect(() => {
    setSelectedEntity(null);
  }, [filingDestination]);

  useEffect(() => {
    setRelinkEntity(null);
  }, [relinkDestination]);

  async function relinkDocument() {
    setRelinking(true);
    setRelinkError(null);
    setRelinkMessage(null);

    const response = await fetch(`/api/mailroom/items/${itemId}/relink`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization_id: organizationId,
        filing_destination: relinkDestination,
        target_id: relinkRequiresTarget ? relinkEntity?.id ?? null : null,
      }),
    });

    const json = (await response.json()) as { success?: boolean; error?: string };
    if (!response.ok || !json.success) {
      setRelinkError(json.error || "Unable to re-link document.");
    } else {
      setRelinkMessage("Document re-linked successfully.");
      setRelinkEntity(null);
      await loadItem();
    }
    setRelinking(false);
  }

  const canRelink =
    !relinking &&
    item?.status === "filed" &&
    (!relinkRequiresTarget || Boolean(relinkEntity?.id));

  async function fileDocument() {
    setFiling(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/mailroom/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildFilePayload({
          organizationId,
          mailroomItemId: itemId,
          destination: filingDestination,
          selectedEntityId: selectedEntity?.id ?? null,
          adminComments,
        }),
      ),
    });

    const json = (await response.json()) as { success?: boolean; error?: string; document_id?: string; message?: string };
    if (!response.ok || !json.success) {
      setError(json.error || "Unable to file document.");
    } else {
      setMessage(json.message || "Document filed successfully.");
      setSelectedEntity(null);
      await loadItem();
    }
    setFiling(false);
  }

  const canFile = canFileDocument({
    filing,
    itemStatus: item?.status,
    destination: filingDestination,
    selectedEntityId: selectedEntity?.id ?? null,
  });

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Mailroom Filing</p>
          <h1>{item?.fileName || "Mailroom item"}</h1>
          <p className="hero-copy">Review payer mail or scanned documents and file them into the right system location.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/mailroom">Mailroom</Link>
        </div>
      </section>

      {loading ? <div className="empty-state">Loading mailroom item…</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}
      {message ? <div className="empty-state success-panel">{message}</div> : null}

      {item ? (
        <section className="two-column-panel">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Document details</h2>
                <p>{item.documentType || "document"} · {item.status || "needs_review"}</p>
              </div>
              <span className={`status ${item.status === "filed" ? "status-green" : "status-yellow"}`}>{item.status || "pending"}</span>
            </div>
            <div className="detail-list">
              <p><strong>File:</strong> {item.fileName || "—"}</p>
              <p><strong>Type:</strong> {item.mimeType || "—"}</p>
              <p><strong>Storage path:</strong> {item.storagePath || "—"}</p>
              <p><strong>Source:</strong> {item.source || "—"}</p>
              <p><strong>Created:</strong> {formatDate(item.createdAt)}</p>
              <p><strong>Notes:</strong> {item.notes || "—"}</p>
              <p>
                <strong>Linked patient:</strong>{" "}
                {patient ? (
                  patient.name ? (
                    <>
                      <Link href={`/clients/${patient.id}`}>{patient.name}</Link>
                      {patient.dob ? ` (DOB ${patient.dob})` : ""}
                      {patient.archived ? " — archived" : ""}
                    </>
                  ) : (
                    <span className="muted-text">Patient record unavailable (archived or deleted)</span>
                  )
                ) : (
                  "Not linked"
                )}
              </p>
              {encounter ? (
                <p>
                  <strong>Linked encounter:</strong>{" "}
                  {encounter.serviceDate || encounter.providerName ? (
                    <>
                      <Link href={`/encounters/${encounter.id}`}>
                        {encounter.serviceDate || "Encounter"}
                        {encounter.providerName ? ` · ${encounter.providerName}` : ""}
                      </Link>
                      {encounter.archived ? " — archived" : ""}
                    </>
                  ) : (
                    <span className="muted-text">Encounter unavailable (archived or deleted)</span>
                  )}
                </p>
              ) : null}
              {claim ? (
                <p>
                  <strong>Linked claim:</strong>{" "}
                  {claim.claimNumber || claim.payerName || claim.serviceDateFrom ? (
                    <>
                      {[claim.claimNumber, claim.payerName, claim.serviceDateFrom].filter(Boolean).join(" · ")}
                      {claim.archived ? " — archived" : ""}
                    </>
                  ) : (
                    <span className="muted-text">Claim unavailable (archived or deleted)</span>
                  )}
                </p>
              ) : null}
            </div>
            <div className="section-actions">
              {patient?.id ? <Link className="button button-secondary" href={`/clients/${patient.id}`}>Open Client Chart</Link> : null}
              {encounter?.id ? <Link className="button button-secondary" href={`/encounters/${encounter.id}`}>Open Encounter</Link> : null}
              {filingDestination === "encounter" && selectedEntity && selectedEntity.id !== encounter?.id ? (
                <Link className="button button-secondary" href={`/encounters/${selectedEntity.id}`}>Open Selected Encounter</Link>
              ) : null}
            </div>
          </div>

          <div className="panel form-panel">
            <h2>File document</h2>
            <label className="field-label">
              Filing destination
              <select
                value={filingDestination}
                onChange={(event) => setFilingDestination(event.target.value as FilingDestination)}
              >
                <option value="patient_chart">Patient chart</option>
                <option value="claim">Claim</option>
                <option value="encounter">Encounter</option>
                <option value="practice_documents">Practice-level documents</option>
              </select>
            </label>
            {requiresTarget && entityType ? (
              <div className="field-label">
                <span>
                  {entityType === "patient" ? "Patient" : entityType === "claim" ? "Claim" : "Encounter"}
                </span>
                <EntityPicker
                  entityType={entityType}
                  organizationId={organizationId}
                  value={selectedEntity}
                  onChange={setSelectedEntity}
                  disabled={filing}
                />
              </div>
            ) : (
              <p className="muted-text">No target needed — this document will be filed at the practice level.</p>
            )}
            <label className="field-label">
              Filing notes
              <textarea value={adminComments} onChange={(event) => setAdminComments(event.target.value)} placeholder="Add filing notes or payer correspondence summary..." />
            </label>
            <button className="button" type="button" onClick={fileDocument} disabled={!canFile}>
              {filing ? "Filing…" : item.status === "filed" ? "Already Filed" : "File Document"}
            </button>
            {requiresTarget && !selectedEntity ? (
              <p className="muted-text">Search and select a {entityType} before filing.</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {item && item.status === "filed" ? (
        <section className="panel form-panel">
          <h2>Re-link filed document</h2>
          <p className="muted-text">
            Made a mistake when filing? Move this document to a different patient, encounter, or claim
            without re-uploading. The original document record is updated and the change is recorded
            in the audit log.
          </p>
          {relinkError ? <div className="alert-panel">{relinkError}</div> : null}
          {relinkMessage ? <div className="empty-state success-panel">{relinkMessage}</div> : null}
          <label className="field-label">
            New destination
            <select
              value={relinkDestination}
              onChange={(event) => setRelinkDestination(event.target.value as FilingDestination)}
              disabled={relinking}
            >
              <option value="patient_chart">Patient chart</option>
              <option value="claim">Claim</option>
              <option value="encounter">Encounter</option>
              <option value="practice_documents">Practice-level documents (unlink patient/encounter/claim)</option>
            </select>
          </label>
          {relinkRequiresTarget && relinkEntityType ? (
            <div className="field-label">
              <span>
                {relinkEntityType === "patient" ? "Patient" : relinkEntityType === "claim" ? "Claim" : "Encounter"}
              </span>
              <EntityPicker
                entityType={relinkEntityType}
                organizationId={organizationId}
                value={relinkEntity}
                onChange={setRelinkEntity}
                disabled={relinking}
              />
            </div>
          ) : (
            <p className="muted-text">
              This will unlink the patient, encounter, and claim from the document and file it at the practice level.
            </p>
          )}
          <button className="button" type="button" onClick={relinkDocument} disabled={!canRelink}>
            {relinking ? "Re-linking…" : "Re-link document"}
          </button>
          {relinkRequiresTarget && !relinkEntity ? (
            <p className="muted-text">Search and select a {relinkEntityType} before re-linking.</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
