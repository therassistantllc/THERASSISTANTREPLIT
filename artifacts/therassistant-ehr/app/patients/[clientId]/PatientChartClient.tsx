"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type InsurancePolicySummary = {
  id: string;
  plan_name?: string | null;
  policy_number?: string | null;
  priority?: string | null;
  active_flag?: boolean | null;
};

type EligibilitySummary = {
  id?: string;
  eligibility_status?: string | null;
  checked_at?: string | null;
  copay_amount?: string | number | null;
  deductible_remaining?: string | number | null;
};

type InvoiceSummary = {
  id: string;
  invoice_number?: string | null;
  invoice_status?: string | null;
  balance_amount?: string | number | null;
};

type EncounterSummary = {
  id: string;
  encounter_status?: string | null;
  service_date?: string | null;
};

type WorkqueueSummary = {
  id: string;
  title?: string | null;
  work_type?: string | null;
  status?: string | null;
  priority?: string | null;
  created_at?: string | null;
};

type PatientSummary = {
  success: boolean;
  error?: string;
  patient?: {
    id: string;
    name: string;
    preferredName?: string | null;
    dateOfBirth?: string | null;
    email?: string | null;
    phone?: string | null;
    pronouns?: string | null;
  };
  insurance?: {
    policies: InsurancePolicySummary[];
    latestEligibility: EligibilitySummary | null;
  };
  balance?: {
    total: number;
    invoices: InvoiceSummary[];
  };
  encounters?: EncounterSummary[];
  workqueueItems?: WorkqueueSummary[];
};

type AppointmentSummary = {
  id: string;
  scheduledStart?: string | null;
  status?: string | null;
  type?: string | null;
  reason?: string | null;
  encounter?: { id: string; status?: string | null } | null;
};

type ConditionSummary = {
  id: string;
  code: string;
  description?: string | null;
  encounterId: string;
  encounterDate?: string | null;
};

type ClaimSummary = {
  id: string;
  claimNumber?: string | null;
  status?: string | null;
  totalCharge?: number | null;
  createdAt?: string | null;
};

type NoteSummary = {
  id: string;
  encounterId: string;
  encounterDate?: string | null;
  noteStatus?: string | null;
  noteType?: string | null;
};

type DocumentSummary = {
  id: string;
  title?: string | null;
  fileName?: string | null;
  createdAt?: string | null;
  mailroomItemId?: string | null;
};

type MailroomSummary = {
  id: string;
  fileName?: string;
  status?: string;
  documentType?: string;
  createdAt?: string;
};

type DetailState = {
  appointments: AppointmentSummary[];
  conditions: ConditionSummary[];
  claims: ClaimSummary[];
  notes: NoteSummary[];
  documents: DocumentSummary[];
  mailroomItems: MailroomSummary[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(`${value}`.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusClass(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("active") && !normalized.includes("inactive")) return "status status-green";
  if (normalized.includes("paid") || normalized.includes("accepted") || normalized.includes("resolved")) return "status status-green";
  if (normalized.includes("inactive") || normalized.includes("blocked") || normalized.includes("denied") || normalized.includes("rejected")) return "status status-red";
  if (normalized.includes("open") || normalized.includes("sent") || normalized.includes("draft") || normalized.includes("submitted") || normalized.includes("in_progress")) return "status status-yellow";
  return "status";
}

async function fetchList<T>(url: string, field: string): Promise<T[]> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const json = (await response.json()) as Record<string, unknown> & { success?: boolean };
    if (!response.ok || !json.success) return [];
    return (Array.isArray(json[field]) ? (json[field] as T[]) : []);
  } catch {
    return [];
  }
}

export default function PatientChartClient({ clientId }: { clientId: string }) {
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [details, setDetails] = useState<DetailState>({
    appointments: [],
    conditions: [],
    claims: [],
    notes: [],
    documents: [],
    mailroomItems: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const organizationId = useMemo(() => getOrganizationId(), []);

  useEffect(() => {
    let cancelled = false;

    async function loadPatient() {
      if (!organizationId) {
        setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
        setLoading(false);
        return;
      }

      try {
        const summaryResponse = await fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const summaryJson = (await summaryResponse.json()) as PatientSummary;
        if (!summaryResponse.ok || !summaryJson.success) throw new Error(summaryJson.error ?? "Failed to load patient chart");

        const [appointments, conditions, claims, notes, documents, mailroomItems] = await Promise.all([
          fetchList<AppointmentSummary>(`/api/patients/${clientId}/appointments?organizationId=${encodeURIComponent(organizationId)}`, "appointments"),
          fetchList<ConditionSummary>(`/api/patients/${clientId}/conditions?organizationId=${encodeURIComponent(organizationId)}`, "conditions"),
          fetchList<ClaimSummary>(`/api/patients/${clientId}/claims?organizationId=${encodeURIComponent(organizationId)}`, "claims"),
          fetchList<NoteSummary>(`/api/patients/${clientId}/notes?organizationId=${encodeURIComponent(organizationId)}`, "notes"),
          fetchList<DocumentSummary>(`/api/patients/${clientId}/documents?organizationId=${encodeURIComponent(organizationId)}`, "documents"),
          fetchList<MailroomSummary>(`/api/mailroom/items?organizationId=${encodeURIComponent(organizationId)}&clientId=${encodeURIComponent(clientId)}&status=all&limit=10`, "items"),
        ]);

        if (cancelled) return;

        setSummary(summaryJson);
        setDetails({
          appointments,
          conditions,
          claims,
          notes,
          documents,
          mailroomItems,
        });
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load patient chart");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadPatient();
    return () => {
      cancelled = true;
    };
  }, [clientId, organizationId]);

  const patient = summary?.patient;
  const latestEligibility = summary?.insurance?.latestEligibility ?? null;
  const policies = summary?.insurance?.policies ?? [];
  const invoices = summary?.balance?.invoices ?? [];
  const encounters = summary?.encounters ?? [];
  const workqueueItems = summary?.workqueueItems ?? [];

  const claimCounts = details.claims.reduce(
    (acc, claim) => {
      const key = String(claim.status ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const deniedOrRejectedCount = details.claims.filter((claim) => {
    const status = String(claim.status ?? "").toLowerCase();
    return status.includes("denied") || status.includes("rejected");
  }).length;

  const alerts: string[] = [];
  if (!latestEligibility) alerts.push("No recent eligibility check on file.");
  if (latestEligibility && String(latestEligibility.eligibility_status ?? "").toLowerCase().includes("inactive")) {
    alerts.push("Coverage is marked inactive. Verify eligibility before next visit.");
  }
  if ((summary?.balance?.total ?? 0) > 0) alerts.push("Outstanding patient balance requires follow-up.");
  if (deniedOrRejectedCount > 0) alerts.push(`${deniedOrRejectedCount} denied/rejected claim(s) need billing action.`);
  if (workqueueItems.length > 0) alerts.push(`${workqueueItems.length} open workqueue item(s) linked to this client.`);

  const orgQ = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  if (loading) return <div className="empty-state">Loading client chart…</div>;
  if (error) return <div className="alert-panel">{error}</div>;
  if (!patient) return <div className="alert-panel">Client record not found.</div>;

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Client Chart Summary</p>
          <h1>{patient.name}</h1>
          <p className="hero-copy">
            DOB: {formatDate(patient.dateOfBirth)}{patient.pronouns ? ` · Pronouns: ${patient.pronouns}` : ""}
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/clients/${patient.id}/appointments${orgQ}`}>Appointments</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/notes${orgQ}`}>Notes</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/eligibility${orgQ}`}>Eligibility</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/claims${orgQ}`}>Claims</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/balance${orgQ}`}>Balance</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/documents${orgQ}`}>Documents</Link>
          <Link className="button" href={`/workqueue/new?clientId=${patient.id}${organizationId ? `&organizationId=${organizationId}` : ""}`}>Route to Biller</Link>
        </div>
      </section>

      <section className="metric-grid">
        <article className="metric-card">
          <span>Outstanding Balance</span>
          <strong>{formatMoney(summary?.balance?.total ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Claims</span>
          <strong>{details.claims.length}</strong>
        </article>
        <article className="metric-card">
          <span>Recent Encounters</span>
          <strong>{encounters.length}</strong>
        </article>
        <article className="metric-card">
          <span>Open Workqueue</span>
          <strong>{workqueueItems.length}</strong>
        </article>
      </section>

      <section className="panel" style={{ marginBottom: "16px" }}>
        <h2>Alerts</h2>
        {alerts.length === 0 ? <p className="muted">No active chart alerts.</p> : null}
        <div className="stack-list">
          {alerts.map((alert) => (
            <div className="stack-item" key={alert}>
              <span className="status status-yellow">Attention</span>
              <strong>{alert}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-grid">
        <article className="panel">
          <h2>Demographics</h2>
          <div className="detail-list">
            <p><strong>Preferred name:</strong> {patient.preferredName ?? "Not listed"}</p>
            <p><strong>Email:</strong> {patient.email ?? "Not listed"}</p>
            <p><strong>Phone:</strong> {patient.phone ?? "Not listed"}</p>
            <p><strong>Client ID:</strong> {patient.id}</p>
          </div>
        </article>

        <article className="panel">
          <h2>Insurance</h2>
          {policies.length === 0 ? <p className="muted">No active insurance policies found.</p> : null}
          <div className="stack-list">
            {policies.slice(0, 3).map((policy) => (
              <div className="stack-item" key={policy.id}>
                <strong>{policy.plan_name ?? "Insurance policy"}</strong>
                <span>{policy.priority ?? "priority not set"} · {policy.active_flag ? "active" : "inactive"}</span>
                <span>Policy: {policy.policy_number ?? "not listed"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/eligibility${orgQ}`}>Open Eligibility</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Recent Appointments</h2>
          {details.appointments.length === 0 ? <p className="muted">No appointments found.</p> : null}
          <div className="stack-list">
            {details.appointments.slice(0, 5).map((appointment) => (
              <div className="stack-item" key={appointment.id}>
                <strong>{formatDate(appointment.scheduledStart)}</strong>
                <span>{appointment.type ?? "visit"} · {appointment.reason ?? "no reason listed"}</span>
                <span className={statusClass(appointment.status)}>{appointment.status ?? "scheduled"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/appointments${orgQ}`}>Open Appointments</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Active Conditions / Diagnoses</h2>
          {details.conditions.length === 0 ? <p className="muted">No diagnoses documented.</p> : null}
          <div className="stack-list">
            {details.conditions.slice(0, 6).map((condition) => (
              <div className="stack-item" key={condition.id}>
                <strong>{condition.code}</strong>
                <span>{condition.description ?? "No description"}</span>
                <span>Last seen: {formatDate(condition.encounterDate)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/conditions${orgQ}`}>Open Diagnoses</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Recent Encounters</h2>
          {encounters.length === 0 ? <p className="muted">No encounters found.</p> : null}
          <div className="stack-list">
            {encounters.slice(0, 6).map((encounter) => (
              <div className="stack-item stack-row" key={encounter.id}>
                <div>
                  <strong>{formatDate(encounter.service_date)}</strong>
                  <span className={statusClass(encounter.encounter_status)}>{encounter.encounter_status ?? "status not set"}</span>
                </div>
                <Link className="button button-secondary" href={`/encounters/${encounter.id}${orgQ}`}>Open Encounter</Link>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <h2>Open Workqueue Items</h2>
          {workqueueItems.length === 0 ? <p className="muted">No open routed items.</p> : null}
          <div className="stack-list">
            {workqueueItems.slice(0, 6).map((item) => (
              <div className="stack-item" key={item.id}>
                <strong>{item.title ?? "Routed item"}</strong>
                <span>{item.work_type ?? "work item"} · {item.priority ?? "priority not set"}</span>
                <span className={statusClass(item.status)}>{item.status ?? "status not set"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/workqueue${orgQ}`}>Open Client Workqueue</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Balance Summary</h2>
          <div className="detail-list">
            <p><strong>Outstanding:</strong> {formatMoney(summary?.balance?.total ?? 0)}</p>
            <p><strong>Open invoices:</strong> {invoices.length}</p>
            <p><strong>Latest eligibility:</strong> <span className={statusClass(latestEligibility?.eligibility_status)}>{latestEligibility?.eligibility_status ?? "not checked"}</span></p>
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/balance${orgQ}`}>Open Balance</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Claim Summary</h2>
          {details.claims.length === 0 ? <p className="muted">No professional claims found.</p> : null}
          <div className="detail-list" style={{ marginBottom: "12px" }}>
            {Object.entries(claimCounts).slice(0, 6).map(([status, count]) => (
              <p key={status}><strong>{status}:</strong> {count}</p>
            ))}
          </div>
          <div className="stack-list">
            {details.claims.slice(0, 5).map((claim) => (
              <div className="stack-item" key={claim.id}>
                <strong>{claim.claimNumber ?? claim.id.slice(0, 8)}</strong>
                <span className={statusClass(claim.status)}>{claim.status ?? "status not set"}</span>
                <span>Total charge: {formatMoney(claim.totalCharge)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/claims${orgQ}`}>Open Claims</Link>
            <Link className="button button-secondary" href={`/billing/charge-capture${orgQ}`}>Charge Capture</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Documents / Mailroom Summary</h2>
          <div className="metric-grid" style={{ marginTop: 0 }}>
            <article className="metric-card">
              <span>Documents</span>
              <strong>{details.documents.length}</strong>
            </article>
            <article className="metric-card">
              <span>Mailroom Items</span>
              <strong>{details.mailroomItems.length}</strong>
            </article>
            <article className="metric-card">
              <span>Clinical Notes</span>
              <strong>{details.notes.length}</strong>
            </article>
            <article className="metric-card">
              <span>Latest Note</span>
              <strong className="metric-text">{formatDate(details.notes[0]?.encounterDate ?? null)}</strong>
            </article>
          </div>
          <div className="stack-list">
            {details.documents.slice(0, 3).map((document) => (
              <div className="stack-item" key={document.id}>
                <strong>{document.title ?? document.fileName ?? "Document"}</strong>
                <span>Created: {formatDate(document.createdAt)}</span>
              </div>
            ))}
            {details.mailroomItems.slice(0, 3).map((mailroomItem) => (
              <div className="stack-item" key={mailroomItem.id}>
                <strong>{mailroomItem.fileName ?? "Mailroom item"}</strong>
                <span>{mailroomItem.documentType ?? "document"} · {mailroomItem.status ?? "status not set"}</span>
                <span>Received: {formatDate(mailroomItem.createdAt ?? null)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/documents${orgQ}`}>Open Documents</Link>
            <Link className="button button-secondary" href={`/mailroom${orgQ}`}>Open Mailroom</Link>
            <Link className="button button-secondary" href={`/clients/${patient.id}/notes${orgQ}`}>Open Notes</Link>
          </div>
        </article>
      </section>
    </>
  );
}
