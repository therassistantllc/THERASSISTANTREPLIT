"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import SoapNoteEditor, { SoapNoteData } from "@/components/encounter/SoapNoteEditor";
import DiagnosisPicker, { Diagnosis } from "@/components/encounter/DiagnosisPicker";
import CptCodePanel, { ServiceLine } from "@/components/encounter/CptCodePanel";
import ClaimReadinessSidebar, { ClaimReadinessCheck } from "@/components/encounter/ClaimReadinessSidebar";
import SignNoteModal from "@/components/encounter/SignNoteModal";

type EncounterSummary = {
  success: boolean;
  error?: string;
  patient?: { id: string; name: string; dateOfBirth?: string | null } | null;
  encounter?: { id: string; encounter_status?: string | null; service_date?: string | null; started_at?: string | null; ended_at?: string | null };
  appointment?: { appointment_type?: string | null; scheduled_start_at?: string | null; scheduled_end_at?: string | null; service_location?: string | null; telehealth_url?: string | null } | null;
  diagnoses?: Array<{ id: string; diagnosis_code?: string | null; diagnosis_description?: string | null; is_primary?: boolean | null }>;
  clinicalNote?: { id: string; note_status?: string | null; subjective?: string | null; objective?: string | null; assessment?: string | null; plan?: string | null; signed_at?: string | null } | null;
  serviceLines?: Array<{ id: string; cpt_hcpcs_code?: string | null; service_date?: string | null; units?: number | null; charge_amount?: number | null; modifier_1?: string | null; modifier_2?: string | null; modifier_3?: string | null; modifier_4?: string | null; place_of_service_code?: string | null }>;
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not listed";
  const date = new Date(`${value}`.includes("T") ? value : `${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "Not listed";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not listed" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusClass(value: string | null | undefined): string {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("signed") || normalized.includes("complete")) return "status status-green";
  if (normalized.includes("draft")) return "status status-yellow";
  if (normalized.includes("void") || normalized.includes("blocked")) return "status status-red";
  return "status";
}

export default function EncounterNoteClient({ encounterId }: { encounterId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [summary, setSummary] = useState<EncounterSummary | null>(null);
  const [soapNote, setSoapNote] = useState<SoapNoteData>({});
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [showSignModal, setShowSignModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finalized = useMemo(
    () => summary?.encounter?.encounter_status === "signed" || summary?.clinicalNote?.note_status === "signed",
    [summary]
  );

  const claimReadinessChecks = useMemo((): ClaimReadinessCheck[] => {
    return [
      { label: "Primary diagnosis selected", isComplete: diagnoses.some((d) => d.is_primary), required: true },
      { label: "All service lines coded", isComplete: serviceLines.length > 0, required: true },
      { label: "Service line charges entered", isComplete: serviceLines.every((s) => s.charge_amount > 0), required: false },
      { label: "Clinical note documented", isComplete: !!(soapNote.subjective || soapNote.objective || soapNote.assessment || soapNote.plan), required: true },
      { label: "Plan section completed", isComplete: !!soapNote.plan, required: false },
      { label: "Assessment section documented", isComplete: !!soapNote.assessment, required: false },
    ];
  }, [diagnoses, serviceLines, soapNote]);

  async function loadEncounter() {
    if (!organizationId) {
      setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`/api/encounters/${encounterId}/summary?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const json = (await response.json()) as EncounterSummary;
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load encounter");
      setSummary(json);
      setSoapNote({
        subjective: json.clinicalNote?.subjective ?? "",
        objective: json.clinicalNote?.objective ?? "",
        assessment: json.clinicalNote?.assessment ?? "",
        plan: json.clinicalNote?.plan ?? "",
      });

      const loadedDiagnoses: Diagnosis[] = (json.diagnoses ?? []).map((d) => ({
        id: d.id || `diag-${Date.now()}`,
        diagnosis_code: d.diagnosis_code || "",
        diagnosis_description: d.diagnosis_description || "",
        is_primary: d.is_primary || false,
      }));
      setDiagnoses(loadedDiagnoses);

      const loadedServiceLines: ServiceLine[] = (json.serviceLines ?? []).map((s) => ({
        id: s.id || `service-${Date.now()}`,
        service_date: s.service_date || json.encounter?.service_date || new Date().toISOString().slice(0, 10),
        cpt_hcpcs_code: s.cpt_hcpcs_code || "",
        modifier_1: s.modifier_1 || "",
        modifier_2: s.modifier_2 || "",
        modifier_3: s.modifier_3 || "",
        modifier_4: s.modifier_4 || "",
        units: s.units || 1,
        charge_amount: s.charge_amount || 0,
        place_of_service_code: s.place_of_service_code || "10",
      }));
      setServiceLines(loadedServiceLines);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load encounter");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadEncounter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId, organizationId]);

  async function saveNote() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/encounters/${encounterId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          action: "save",
          subjective: soapNote.subjective || "",
          objective: soapNote.objective || "",
          assessment: soapNote.assessment || "",
          plan: soapNote.plan || "",
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Note action failed");
      setMessage("Draft saved.");
      await loadEncounter();
    } catch (noteError) {
      setError(noteError instanceof Error ? noteError.message : "Note action failed");
    } finally {
      setSaving(false);
    }
  }

  async function signNote() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/encounters/${encounterId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          action: "sign",
          subjective: soapNote.subjective || "",
          objective: soapNote.objective || "",
          assessment: soapNote.assessment || "",
          plan: soapNote.plan || "",
          userId: null,
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to sign note");
      setMessage("Note signed successfully.");
      setShowSignModal(false);
      await loadEncounter();
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Failed to sign note");
    } finally {
      setSaving(false);
    }
  }

  async function saveBillingDetails() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/encounters/${encounterId}/billing-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          diagnoses: diagnoses.map((d) => ({
            diagnosis_code: d.diagnosis_code,
            diagnosis_description: d.diagnosis_description,
            is_primary: d.is_primary,
          })),
          serviceLines: serviceLines.map((s) => ({
            service_date: s.service_date,
            cpt_hcpcs_code: s.cpt_hcpcs_code,
            modifier_1: s.modifier_1,
            modifier_2: s.modifier_2,
            modifier_3: s.modifier_3,
            modifier_4: s.modifier_4,
            units: s.units,
            charge_amount: s.charge_amount,
            place_of_service_code: s.place_of_service_code,
          })),
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to save billing details");
      setMessage("Diagnoses and service lines saved.");
    } catch (billError) {
      setError(billError instanceof Error ? billError.message : "Failed to save billing details");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty-state">Loading encounter…</div>;
  if (error && !summary) return <div className="alert-panel">{error}</div>;
  if (!summary?.encounter) return <div className="alert-panel">Encounter not found.</div>;

  const patient = summary.patient;
  const encounter = summary.encounter;
  const appointment = summary.appointment;

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Encounter Documentation Workspace</p>
          <h1>{patient?.name ?? "Encounter"}</h1>
          <p className="hero-copy">Service date: {formatDate(encounter.service_date)} · Status: {encounter.encounter_status ?? "not set"}</p>
        </div>
        <div className="hero-actions">
          {patient?.id ? <Link className="button button-secondary" href={`/clients/${patient.id}`}>Patient Chart</Link> : null}
          <Link className="button button-secondary" href="/clinician/agenda">Agenda</Link>
          <button className="button button-secondary" type="button" onClick={() => { saveNote(); saveBillingDetails(); }} disabled={saving || finalized}>Save Draft</button>
          <button className="button" type="button" onClick={() => setShowSignModal(true)} disabled={saving || finalized || !soapNote.subjective}>Sign Note</button>
        </div>
      </section>

      {message ? <div className="empty-state success-panel">{message}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}

      <section className="encounter-workspace">
        <aside className="workspace-sidebar-left">
          <article className="panel">
            <h2>Visit Context</h2>
            <div className="detail-list">
              <p><strong>Patient DOB:</strong> {formatDate(patient?.dateOfBirth)}</p>
              <p><strong>Type:</strong> {appointment?.appointment_type ?? "Not listed"}</p>
              <p><strong>Start:</strong> {formatTime(encounter.started_at ?? appointment?.scheduled_start_at)}</p>
              <p><strong>End:</strong> {formatTime(encounter.ended_at ?? appointment?.scheduled_end_at)}</p>
              <p><strong>Location:</strong> {appointment?.service_location ?? (appointment?.telehealth_url ? "Telehealth" : "Not listed")}</p>
              <p><strong>Status:</strong> <span className={statusClass(encounter.encounter_status)}>{encounter.encounter_status ?? "not set"}</span></p>
            </div>
          </article>
          <ClaimReadinessSidebar checks={claimReadinessChecks} />
        </aside>

        <main className="workspace-main">
          <SoapNoteEditor data={soapNote} onChange={setSoapNote} disabled={finalized} />
          <DiagnosisPicker diagnoses={diagnoses} onChange={setDiagnoses} disabled={finalized} />
          <CptCodePanel serviceLines={serviceLines} onChange={setServiceLines} disabled={finalized} serviceDate={encounter.service_date || undefined} />
        </main>
      </section>

      <SignNoteModal isOpen={showSignModal} onClose={() => setShowSignModal(false)} onConfirm={signNote} isLoading={saving} />

      <style jsx>{`
        .encounter-workspace {
          display: grid;
          grid-template-columns: 280px 1fr;
          gap: 1.5rem;
          max-width: 100%;
        }

        .workspace-sidebar-left {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .workspace-main {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        @media (max-width: 1024px) {
          .encounter-workspace {
            grid-template-columns: 1fr;
          }
          
          .workspace-sidebar-left {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 640px) {
          .encounter-workspace {
            gap: 1rem;
          }

          .workspace-sidebar-left {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </>
  );
}
