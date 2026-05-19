"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DiagnosisRow = {
  diagnosisCode: string;
  diagnosisDescription: string;
  isPrimary: boolean;
  presentOnClaim: boolean;
};

type ServiceLineRow = {
  serviceDate: string;
  procedureCode: string;
  modifier1: string;
  modifier2: string;
  modifier3: string;
  modifier4: string;
  units: number;
  chargeAmount: number;
  placeOfServiceCode: string;
};

type BillingPayload = {
  success: boolean;
  error?: string;
  encounter?: { id: string; service_date?: string | null; encounter_status?: string | null };
  diagnoses?: Array<Record<string, unknown>>;
  serviceLines?: Array<Record<string, unknown>>;
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function blankDiagnosis(): DiagnosisRow {
  return { diagnosisCode: "", diagnosisDescription: "", isPrimary: false, presentOnClaim: true };
}

function blankServiceLine(serviceDate = today()): ServiceLineRow {
  return {
    serviceDate,
    procedureCode: "",
    modifier1: "",
    modifier2: "",
    modifier3: "",
    modifier4: "",
    units: 1,
    chargeAmount: 0,
    placeOfServiceCode: "10",
  };
}

export default function BillingDetailsClient({ encounterId }: { encounterId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [diagnoses, setDiagnoses] = useState<DiagnosisRow[]>([blankDiagnosis()]);
  const [serviceLines, setServiceLines] = useState<ServiceLineRow[]>([blankServiceLine()]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadDetails() {
    if (!organizationId) {
      setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`/api/encounters/${encounterId}/billing-details?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const json = (await response.json()) as BillingPayload;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load billing details");

      const loadedDiagnoses = (json.diagnoses ?? []).map((row, index) => ({
        diagnosisCode: text(row.diagnosis_code),
        diagnosisDescription: text(row.diagnosis_description),
        isPrimary: Boolean(row.is_primary ?? index === 0),
        presentOnClaim: row.present_on_claim !== false,
      }));

      const defaultDate = text(json.encounter?.service_date) || today();
      const loadedServiceLines = (json.serviceLines ?? []).map((row) => ({
        serviceDate: text(row.service_date) || defaultDate,
        procedureCode: text(row.cpt_hcpcs_code),
        modifier1: text(row.modifier_1),
        modifier2: text(row.modifier_2),
        modifier3: text(row.modifier_3),
        modifier4: text(row.modifier_4),
        units: Number(row.units ?? 1) || 1,
        chargeAmount: Number(row.charge_amount ?? 0) || 0,
        placeOfServiceCode: text(row.place_of_service_code) || "10",
      }));

      setDiagnoses(loadedDiagnoses.length ? loadedDiagnoses : [blankDiagnosis()]);
      setServiceLines(loadedServiceLines.length ? loadedServiceLines : [blankServiceLine(defaultDate)]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load billing details");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId, organizationId]);

  function updateDiagnosis(index: number, patch: Partial<DiagnosisRow>) {
    setDiagnoses((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function updateServiceLine(index: number, patch: Partial<ServiceLineRow>) {
    setServiceLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/encounters/${encounterId}/billing-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, diagnoses, serviceLines }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to save billing details");
      setMessage("Billing details saved.");
      await loadDetails();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save billing details");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className="app-shell"><div className="empty-state">Loading billing details…</div></main>;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Billing/Admin</p>
          <h1>Encounter Billing Details</h1>
          <p className="hero-copy">Add claim-required diagnosis and service line data without interrupting clinician documentation.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/encounters/${encounterId}`}>Encounter Note</Link>
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
        </div>
      </section>

      {message ? <div className="empty-state success-panel">{message}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="panel form-panel">
        <h2>Diagnoses</h2>
        {diagnoses.map((diagnosis, index) => (
          <div className="billing-row-grid" key={`diagnosis-${index + 1}`}>
            <label className="field-label">ICD-10<input value={diagnosis.diagnosisCode} onChange={(event) => updateDiagnosis(index, { diagnosisCode: event.target.value })} /></label>
            <label className="field-label">Description<input value={diagnosis.diagnosisDescription} onChange={(event) => updateDiagnosis(index, { diagnosisDescription: event.target.value })} /></label>
            <label className="checkbox-label"><input type="checkbox" checked={diagnosis.isPrimary} onChange={(event) => updateDiagnosis(index, { isPrimary: event.target.checked })} /> Primary</label>
            <label className="checkbox-label"><input type="checkbox" checked={diagnosis.presentOnClaim} onChange={(event) => updateDiagnosis(index, { presentOnClaim: event.target.checked })} /> On claim</label>
          </div>
        ))}
        <button className="button button-secondary" type="button" onClick={() => setDiagnoses((current) => [...current, blankDiagnosis()])}>Add Diagnosis</button>
      </section>

      <section className="panel form-panel">
        <h2>Service Lines</h2>
        {serviceLines.map((line, index) => (
          <div className="billing-service-grid" key={`service-line-${index + 1}`}>
            <label className="field-label">Service Date<input type="date" value={line.serviceDate} onChange={(event) => updateServiceLine(index, { serviceDate: event.target.value })} /></label>
            <label className="field-label">Code<input value={line.procedureCode} onChange={(event) => updateServiceLine(index, { procedureCode: event.target.value })} /></label>
            <label className="field-label">Units<input type="number" min="1" value={line.units} onChange={(event) => updateServiceLine(index, { units: Number(event.target.value) })} /></label>
            <label className="field-label">Charge<input type="number" min="0" step="0.01" value={line.chargeAmount} onChange={(event) => updateServiceLine(index, { chargeAmount: Number(event.target.value) })} /></label>
            <label className="field-label">POS<input value={line.placeOfServiceCode} onChange={(event) => updateServiceLine(index, { placeOfServiceCode: event.target.value })} /></label>
            <label className="field-label">Mod 1<input value={line.modifier1} onChange={(event) => updateServiceLine(index, { modifier1: event.target.value })} /></label>
            <label className="field-label">Mod 2<input value={line.modifier2} onChange={(event) => updateServiceLine(index, { modifier2: event.target.value })} /></label>
            <label className="field-label">Mod 3<input value={line.modifier3} onChange={(event) => updateServiceLine(index, { modifier3: event.target.value })} /></label>
            <label className="field-label">Mod 4<input value={line.modifier4} onChange={(event) => updateServiceLine(index, { modifier4: event.target.value })} /></label>
          </div>
        ))}
        <button className="button button-secondary" type="button" onClick={() => setServiceLines((current) => [...current, blankServiceLine(current[0]?.serviceDate || today())])}>Add Service Line</button>
      </section>

      <div className="section-actions">
        <button className="button" type="button" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Billing Details"}</button>
      </div>
    </main>
  );
}
