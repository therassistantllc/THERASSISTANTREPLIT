"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

function getParam(name: string) {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) || "";
}

function getOrganizationId() {
  return getParam("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

export default function RouteToBillerClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const clientId = useMemo(() => getParam("clientId"), []);
  const appointmentId = useMemo(() => getParam("appointmentId"), []);
  const encounterId = useMemo(() => getParam("encounterId"), []);

  const [reason, setReason] = useState("balance_question");
  const [priority, setPriority] = useState("normal");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setCreatedId(null);

    try {
      if (!organizationId || !clientId) throw new Error("Missing organizationId or clientId.");

      const response = await fetch("/api/workqueue/create-routed-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          clientId,
          appointmentId: appointmentId || null,
          encounterId: encounterId || null,
          reason,
          priority,
          title: "Clinician routed billing/admin review",
          description: description || `Clinician requested billing/admin review. Reason: ${reason}`,
          workType: "clinician_routed_billing_review",
        }),
      });

      const json = (await response.json()) as { success?: boolean; workqueueItemId?: string; error?: string };
      if (!response.ok || !json.success || !json.workqueueItemId) throw new Error(json.error ?? "Route to biller failed.");
      setCreatedId(json.workqueueItemId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Route to biller failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Route to Biller</p>
          <h1>Send billing/admin review</h1>
          <p className="hero-copy">Create a workqueue item without interrupting clinical documentation.</p>
        </div>
        <div className="hero-actions">
          {clientId ? <Link className="button button-secondary" href={`/clients/${clientId}`}>Patient Chart</Link> : null}
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
        </div>
      </section>

      <section className="panel form-panel">
        {error ? <div className="alert-panel">{error}</div> : null}
        {createdId ? <div className="empty-state success-panel">Routed to billing/admin review.</div> : null}

        <div className="detail-list">
          <p><strong>Patient ID:</strong> {clientId || "Missing"}</p>
          <p><strong>Appointment ID:</strong> {appointmentId || "Not provided"}</p>
          <p><strong>Encounter ID:</strong> {encounterId || "Not provided"}</p>
        </div>

        <label className="field-label">
          Reason
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="balance_question">Patient balance question</option>
            <option value="eligibility_question">Eligibility question</option>
            <option value="insurance_question">Insurance question</option>
            <option value="claim_question">Claim question</option>
            <option value="payment_question">Payment question</option>
            <option value="admin_help_needed">Administrative help needed</option>
          </select>
        </label>

        <label className="field-label">
          Priority
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>

        <label className="field-label">
          Message to billing/admin
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what needs review..." />
        </label>

        <div className="section-actions">
          <button className="button" type="button" onClick={submit} disabled={submitting}>
            {submitting ? "Routing…" : "Route to Biller"}
          </button>
          {clientId ? <Link className="button button-secondary" href={`/clients/${clientId}`}>Cancel</Link> : null}
        </div>
      </section>
    </main>
  );
}
