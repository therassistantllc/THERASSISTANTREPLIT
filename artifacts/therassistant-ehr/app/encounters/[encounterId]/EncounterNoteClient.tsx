"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import SoapNoteEditor, { SoapNoteData } from "@/components/encounter/SoapNoteEditor";
import DiagnosisPicker, { Diagnosis } from "@/components/encounter/DiagnosisPicker";
import CptCodePanel, { ServiceLine } from "@/components/encounter/CptCodePanel";
import ClaimReadinessSidebar, { ClaimReadinessCheck } from "@/components/encounter/ClaimReadinessSidebar";
import SignNoteModal from "@/components/encounter/SignNoteModal";
import ClinicianJournalPanel, { ImportResult } from "@/components/encounter/ClinicianJournalPanel";
import { DEFAULT_ORG_ID } from "@/lib/config";
import {
  CHECK_IN_SUBJECTIVE_MARKER,
  composeCheckInSubjectiveBlock,
  mergeCheckInIntoSubjective,
} from "@/lib/checkIns/welcomeFocus";

type EncounterSummary = {
  success: boolean;
  error?: string;
  patient?: { id: string; name: string; dateOfBirth?: string | null } | null;
  encounter?: { id: string; appointment_id?: string | null; encounter_status?: string | null; service_date?: string | null; started_at?: string | null; ended_at?: string | null };
  appointment?: { appointment_type?: string | null; scheduled_start_at?: string | null; scheduled_end_at?: string | null; service_location?: string | null; telehealth_url?: string | null } | null;
  diagnoses?: Array<{ id: string; diagnosis_code?: string | null; diagnosis_description?: string | null; is_primary?: boolean | null }>;
  clinicalNote?: { id: string; note_status?: string | null; subjective?: string | null; objective?: string | null; assessment?: string | null; plan?: string | null; signed_at?: string | null } | null;
  serviceLines?: Array<{ id: string; cpt_hcpcs_code?: string | null; service_date?: string | null; units?: number | null; charge_amount?: number | null; modifier_1?: string | null; modifier_2?: string | null; modifier_3?: string | null; modifier_4?: string | null; place_of_service_code?: string | null }>;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
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

type NoteTemplate = {
  id: string;
  name: string;
  service_type: string | null;
  cpt_code: string | null;
  default_subjective: string;
  default_objective: string;
  default_assessment: string;
  default_plan: string;
  is_default: boolean;
  provider_id: string | null;
};

type EncounterMailroomDocument = {
  id: string;
  type: string | null;
  title: string | null;
  fileName: string | null;
  mimeType: string | null;
  filedAt: string | null;
  createdAt: string | null;
  mailroomItemId: string | null;
};

export default function EncounterNoteClient({ encounterId }: { encounterId: string }) {
  const router = useRouter();
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [summary, setSummary] = useState<EncounterSummary | null>(null);
  const [soapNote, setSoapNote] = useState<SoapNoteData>({});
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [showSignModal, setShowSignModal] = useState(false);
  const [amending, setAmending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [mailroomDocs, setMailroomDocs] = useState<EncounterMailroomDocument[]>([]);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [showJournalModal, setShowJournalModal] = useState(false);

  const personalTemplates = useMemo(
    () => templates.filter((t) => t.provider_id !== null),
    [templates],
  );
  const orgTemplates = useMemo(
    () => templates.filter((t) => t.provider_id === null),
    [templates],
  );

  const isSigned = useMemo(
    () => summary?.encounter?.encounter_status === "signed" || summary?.clinicalNote?.note_status === "signed",
    [summary]
  );

  // Allow the Notes-tab "Amend Note" / "Edit Note" link to deep-link into
  // amend mode via ?edit=1. We only auto-enter once (per page load) and only
  // when the note is signed; unsigned notes are already editable.
  const [autoEditApplied, setAutoEditApplied] = useState(false);
  useEffect(() => {
    if (autoEditApplied || loading || !summary) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("edit") === "1" && isSigned) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmending(true);
      setMessage("Editing signed note. Click Save Amendment when done.");
    }
    setAutoEditApplied(true);
  }, [autoEditApplied, loading, summary, isSigned]);
  // "finalized" = signed AND not currently being amended. Editor + Save/Sign
  // buttons read this; while amending, the editor unlocks for in-place edits.
  const finalized = isSigned && !amending;

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
      let mergedSubjective = json.clinicalNote?.subjective ?? "";
      const appointmentIdForCheckIn = json.encounter?.appointment_id ?? null;
      if (
        appointmentIdForCheckIn &&
        !mergedSubjective.includes(CHECK_IN_SUBJECTIVE_MARKER)
      ) {
        try {
          const checkInResponse = await fetch(
            `/api/check-ins/appointment/${appointmentIdForCheckIn}?organizationId=${encodeURIComponent(organizationId)}`,
            { cache: "no-store" },
          );
          const checkInJson = (await checkInResponse.json()) as {
            success?: boolean;
            checkIn?: { status?: string; focusOption?: string; focusReflection?: string } | null;
          };
          const ci = checkInJson?.checkIn;
          if (checkInJson?.success && ci && ci.status === "submitted") {
            const block = composeCheckInSubjectiveBlock({
              focusOption: ci.focusOption,
              focusReflection: ci.focusReflection,
            });
            if (block) {
              mergedSubjective = mergeCheckInIntoSubjective(mergedSubjective, block);
              setMessage("Pulled the patient's pre-session focus into Subjective. Save the draft to keep it.");
            }
          }
        } catch {
          /* pre-session check-in is best-effort */
        }
      }
      setSoapNote({
        subjective: mergedSubjective,
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

  useEffect(() => {
    let cancelled = false;
    async function loadDocs() {
      if (!organizationId) return;
      try {
        const response = await fetch(
          `/api/encounters/${encounterId}/documents?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = (await response.json()) as { success?: boolean; documents?: EncounterMailroomDocument[] };
        if (cancelled) return;
        if (json.success && Array.isArray(json.documents)) setMailroomDocs(json.documents);
      } catch {
        /* mailroom docs are best-effort */
      }
    }
    loadDocs();
    return () => {
      cancelled = true;
    };
  }, [encounterId, organizationId]);

  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      if (!organizationId) return;
      try {
        const response = await fetch(
          `/api/note-templates?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        );
        const json = (await response.json()) as { success?: boolean; templates?: NoteTemplate[] };
        if (cancelled) return;
        if (json.success && Array.isArray(json.templates)) setTemplates(json.templates);
      } catch {
        /* templates are optional — silently ignore */
      }
    }
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  function applyTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    // Merge: only fill sections the clinician hasn't typed into, so we never
    // overwrite work in progress.
    const next: SoapNoteData = { ...soapNote };
    const skipped: string[] = [];
    const filled: string[] = [];
    const slots: Array<{ key: keyof SoapNoteData; label: string; content: string }> = [
      { key: "subjective", label: "Subjective", content: template.default_subjective ?? "" },
      { key: "objective", label: "Objective", content: template.default_objective ?? "" },
      { key: "assessment", label: "Assessment", content: template.default_assessment ?? "" },
      { key: "plan", label: "Plan", content: template.default_plan ?? "" },
    ];
    for (const slot of slots) {
      if (!slot.content) continue;
      const current = (next[slot.key] ?? "").trim();
      if (current.length === 0) {
        next[slot.key] = slot.content;
        filled.push(slot.label);
      } else {
        skipped.push(slot.label);
      }
    }
    setSoapNote(next);
    if (skipped.length === 0 && filled.length > 0) {
      setMessage(`Applied template "${template.name}".`);
    } else if (skipped.length > 0 && filled.length > 0) {
      setMessage(
        `Applied template "${template.name}" to empty sections. Kept your existing ${skipped.join(", ")} content.`,
      );
    } else if (skipped.length > 0 && filled.length === 0) {
      setMessage(
        `Template "${template.name}" not applied — every section already has content.`,
      );
    }
  }

  async function saveAsPersonalTemplate() {
    if (typeof window === "undefined") return;
    const hasContent =
      (soapNote.subjective ?? "").trim().length > 0 ||
      (soapNote.objective ?? "").trim().length > 0 ||
      (soapNote.plan ?? "").trim().length > 0;
    if (!hasContent) {
      setError("Add some content to the Subjective, Interventions, or Plan section before saving as a template.");
      return;
    }
    const defaultName =
      summary?.appointment?.appointment_type
        ? `My ${summary.appointment.appointment_type} template`
        : "My personal template";
    const name = window.prompt("Name this template (only you will see it):", defaultName);
    if (!name || !name.trim()) return;

    setSavingPersonal(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/note-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          scope: "personal",
          name: name.trim(),
          service_type: summary?.appointment?.appointment_type ?? null,
          default_subjective: soapNote.subjective ?? "",
          default_interventions: soapNote.objective ?? "",
          default_plan: soapNote.plan ?? "",
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string; template?: NoteTemplate };
      if (!response.ok || !json.success || !json.template) {
        throw new Error(json.error ?? "Failed to save personal template");
      }
      setTemplates((prev) => [...prev, json.template as NoteTemplate]);
      setMessage(`Saved "${json.template.name}" to your personal templates.`);
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Failed to save personal template");
    } finally {
      setSavingPersonal(false);
    }
  }

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

  async function saveAmendment() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/encounters/${encounterId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          action: "amend",
          subjective: soapNote.subjective || "",
          objective: soapNote.objective || "",
          assessment: soapNote.assessment || "",
          plan: soapNote.plan || "",
          userId: null,
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to save amendment");
      setMessage("Amendment saved. Note remains signed.");
      setAmending(false);
      await loadEncounter();
    } catch (amendError) {
      setError(amendError instanceof Error ? amendError.message : "Failed to save amendment");
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
      setShowSignModal(false);
      router.push(`/billing/charges?organizationId=${encodeURIComponent(organizationId)}`);
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Failed to sign note");
    } finally {
      setSaving(false);
    }
  }

  async function handleJournalImport({ entry, field, text }: ImportResult) {
    // The import is a 2-step sequence (stamp → save text). We stamp first
    // so that if anything fails the SOAP body isn't mutated; the stamp is
    // idempotent for the same (note, field) so a retry is safe. If the
    // stamp succeeds but the text save fails the user just re-saves, and
    // the stamp call returns success again because it matches.
    if (!summary?.clinicalNote?.id) {
      // No draft yet — saving creates the encounter_clinical_notes row so
      // we have a noteId to stamp onto the entry.
      await saveNote();
    }
    let noteId = summary?.clinicalNote?.id ?? null;
    if (!noteId) {
      const res = await fetch(
        `/api/encounters/${encounterId}/summary?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as EncounterSummary;
      noteId = json.clinicalNote?.id ?? null;
    }
    if (!noteId) {
      throw new Error("Could not create a draft note to import into. Try Save Draft first.");
    }
    const clientIdForEntry = summary?.patient?.id ?? "";
    const importRes = await fetch(
      `/api/clients/${encodeURIComponent(clientIdForEntry)}/journal/${entry.id}/import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, noteId, field }),
      },
    );
    const importJson = (await importRes.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!importRes.ok || !importJson.success) {
      throw new Error(importJson.error ?? "Failed to mark entry as imported");
    }
    const stamp = entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "";
    const attributed = `\n\n${text}\n— From patient journal${stamp ? ` — ${stamp}` : ""}`;
    const current = soapNote[field] ?? "";
    const nextValue = current ? `${current.trimEnd()}${attributed}` : attributed.trimStart();
    const updated: SoapNoteData = { ...soapNote, [field]: nextValue };
    setSoapNote(updated);
    const saveRes = await fetch(`/api/encounters/${encounterId}/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: isSigned ? "amend" : "save",
        subjective: updated.subjective ?? "",
        objective: updated.objective ?? "",
        assessment: updated.assessment ?? "",
        plan: updated.plan ?? "",
        userId: null,
      }),
    });
    if (!saveRes.ok) {
      throw new Error(
        "Imported entry was marked, but saving the appended note text failed. Use Save Draft to retry.",
      );
    }
    setMessage(`Imported journal entry into ${field}.`);
    await loadEncounter();
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
          {isSigned && !amending ? (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => { setAmending(true); setMessage("Editing signed note. Click Save Amendment when done."); }}
              disabled={saving}
            >
              Edit Note
            </button>
          ) : null}
          {isSigned && amending ? (
            <>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => { setAmending(false); loadEncounter(); }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="button"
                type="button"
                onClick={saveAmendment}
                disabled={saving || !soapNote.subjective}
              >
                {saving ? "Saving…" : "Save Amendment"}
              </button>
            </>
          ) : null}
          {!isSigned ? (
            <>
              <button className="button button-secondary" type="button" onClick={() => { saveNote(); saveBillingDetails(); }} disabled={saving || finalized}>Save Draft</button>
              <button className="button" type="button" onClick={() => setShowSignModal(true)} disabled={saving || finalized || !soapNote.subjective}>Sign Note</button>
            </>
          ) : null}
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
          <article className="panel template-picker-panel">
            <div className="template-picker-row">
              <label htmlFor="note-template-picker">
                <strong>Note template</strong>
                <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.875rem" }}>
                  Applies to empty sections only — anything you&apos;ve typed is kept.
                </span>
              </label>
              <div className="template-picker-controls">
                <select
                  id="note-template-picker"
                  value={selectedTemplateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  disabled={finalized || saving || templates.length === 0}
                >
                  <option value="">
                    {templates.length === 0 ? "No templates available" : "Choose a template…"}
                  </option>
                  {personalTemplates.length > 0 ? (
                    <optgroup label="My personal templates">
                      {personalTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                          {template.service_type ? ` · ${template.service_type}` : ""}
                          {template.cpt_code ? ` · ${template.cpt_code}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {orgTemplates.length > 0 ? (
                    <optgroup label="Organization templates">
                      {orgTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                          {template.is_default ? " (default)" : ""}
                          {template.service_type ? ` · ${template.service_type}` : ""}
                          {template.cpt_code ? ` · ${template.cpt_code}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={saveAsPersonalTemplate}
                  disabled={finalized || saving || savingPersonal}
                  title="Save the current note as a personal template only you can see."
                >
                  {savingPersonal ? "Saving…" : "Save as personal template"}
                </button>
              </div>
            </div>
          </article>
          <article className="panel">
            <h2>Mailroom Documents</h2>
            {mailroomDocs.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No mailroom documents have been filed to this encounter yet.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>File / Title</th>
                    <th>Type</th>
                    <th>Filed</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {mailroomDocs.map((doc) => {
                    const href = doc.mailroomItemId
                      ? `/mailroom/${doc.mailroomItemId}?organizationId=${encodeURIComponent(organizationId)}`
                      : null;
                    return (
                      <tr key={doc.id}>
                        <td>
                          <strong>{doc.title ?? doc.fileName ?? "Untitled"}</strong>
                          {doc.title && doc.fileName ? (
                            <div className="muted" style={{ fontSize: 12 }}>{doc.fileName}</div>
                          ) : null}
                        </td>
                        <td>{doc.type ?? "—"}</td>
                        <td>{formatDate(doc.filedAt ?? doc.createdAt)}</td>
                        <td style={{ textAlign: "right" }}>
                          {href ? (
                            <Link className="button button-secondary" href={href}>Open</Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>
          <article className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div>
                <h2 style={{ margin: 0 }}>Between-session journal</h2>
                <p className="muted" style={{ margin: "4px 0 0 0", fontSize: 13 }}>
                  Pull individual entries the patient logged between visits into a SOAP field.
                </p>
              </div>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setShowJournalModal(true)}
                disabled={!summary?.patient?.id}
              >
                Import from journal
              </button>
            </div>
          </article>
          <SoapNoteEditor data={soapNote} onChange={setSoapNote} disabled={finalized} />
          <DiagnosisPicker diagnoses={diagnoses} onChange={setDiagnoses} disabled={finalized} />
          <CptCodePanel serviceLines={serviceLines} onChange={setServiceLines} disabled={finalized} serviceDate={encounter.service_date || undefined} />
        </main>
      </section>

      <SignNoteModal isOpen={showSignModal} onClose={() => setShowSignModal(false)} onConfirm={signNote} isLoading={saving} />

      {showJournalModal && summary?.patient?.id ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import from journal"
          onClick={(e) => { if (e.target === e.currentTarget) setShowJournalModal(false); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "48px 16px",
            zIndex: 1000,
            overflowY: "auto",
          }}
        >
          <div
            className="panel"
            style={{
              background: "var(--surface-color, #fff)",
              borderRadius: 8,
              width: "min(900px, 100%)",
              maxHeight: "calc(100vh - 96px)",
              overflowY: "auto",
              padding: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Import from patient journal</h2>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setShowJournalModal(false)}
              >
                Close
              </button>
            </div>
            <ClinicianJournalPanel
              clientId={summary.patient.id}
              organizationId={organizationId}
              mode="import"
              windowSinceLastSigned
              excludeEncounterId={encounterId}
              onImport={handleJournalImport}
            />
          </div>
        </div>
      ) : null}

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

        .template-picker-row {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .template-picker-controls {
          display: flex;
          gap: 0.75rem;
          align-items: center;
          flex-wrap: wrap;
        }

        .template-picker-controls select {
          flex: 1 1 240px;
          min-width: 0;
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
