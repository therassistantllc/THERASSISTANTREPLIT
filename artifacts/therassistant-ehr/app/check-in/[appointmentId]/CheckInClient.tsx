"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type CheckInResponse = {
  success?: boolean;
  checkIn?: {
    currentMood: string;
    currentStressors: string;
    safetyConcerns: string;
    psychosocialUpdates: string;
    patientStatement: string;
    selectedGoalIds: string[];
    goalUpdates: unknown;
    status: string;
  } | null;
  error?: string;
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
  return new URLSearchParams(window.location.search).get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

export default function CheckInClient({ appointmentId }: { appointmentId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [currentMood, setCurrentMood] = useState("");
  const [currentStressors, setCurrentStressors] = useState("");
  const [safetyConcerns, setSafetyConcerns] = useState("");
  const [psychosocialUpdates, setPsychosocialUpdates] = useState("");
  const [patientStatement, setPatientStatement] = useState("");
  const [goalUpdatesText, setGoalUpdatesText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/check-ins/appointment/${appointmentId}?organizationId=${encodeURIComponent(organizationId)}`);
      const json = (await response.json()) as CheckInResponse;
      if (!response.ok || !json.success) {
        setError(json.error || "Unable to load check-in.");
      } else if (json.checkIn) {
        setCurrentMood(json.checkIn.currentMood || "");
        setCurrentStressors(json.checkIn.currentStressors || "");
        setSafetyConcerns(json.checkIn.safetyConcerns || "");
        setPsychosocialUpdates(json.checkIn.psychosocialUpdates || "");
        setPatientStatement(json.checkIn.patientStatement || "");
        setGoalUpdatesText(Array.isArray(json.checkIn.goalUpdates) ? JSON.stringify(json.checkIn.goalUpdates, null, 2) : "");
      }
      setLoading(false);
    }

    if (organizationId && appointmentId) void load();
    else void Promise.resolve().then(() => {
      setError("Missing organization or appointment.");
      setLoading(false);
    });
  }, [organizationId, appointmentId]);

  async function submit() {
    setSaving(true);
    setError(null);
    setMessage(null);

    const response = await fetch(`/api/check-ins/appointment/${appointmentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        status: "submitted",
        currentMood,
        currentStressors,
        safetyConcerns,
        psychosocialUpdates,
        patientStatement,
        goalUpdates: goalUpdatesText.trim() ? [{ note: goalUpdatesText.trim() }] : [],
      }),
    });

    const json = (await response.json()) as CheckInResponse;
    if (!response.ok || !json.success) {
      setError(json.error || "Unable to submit check-in.");
    } else {
      setMessage("Check-in submitted. Your clinician can review it before the visit.");
    }
    setSaving(false);
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Patient Check-In</p>
          <h1>Pre-session update</h1>
          <p className="hero-copy">Share what has changed since your last visit. Your answers become part of the clinical context your clinician reviews.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/">Home</Link>
        </div>
      </section>

      {loading ? <div className="empty-state">Loading check-in…</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}
      {message ? <div className="empty-state success-panel">{message}</div> : null}

      {!loading ? (
        <section className="panel form-panel">
          <label className="field-label">
            How are you feeling today?
            <textarea value={currentMood} onChange={(event) => setCurrentMood(event.target.value)} placeholder="Describe your current mood, symptoms, or concerns..." />
          </label>
          <label className="field-label">
            What stressors or psychosocial changes happened since your last visit?
            <textarea value={currentStressors} onChange={(event) => setCurrentStressors(event.target.value)} placeholder="Work, school, housing, family, relationships, legal, financial, health, or other changes..." />
          </label>
          <label className="field-label">
            Any safety concerns you want your clinician to know about?
            <textarea value={safetyConcerns} onChange={(event) => setSafetyConcerns(event.target.value)} placeholder="You can write none, not today, or describe concerns you want reviewed." />
          </label>
          <label className="field-label">
            Any updates related to your treatment goals?
            <textarea value={goalUpdatesText} onChange={(event) => setGoalUpdatesText(event.target.value)} placeholder="Describe progress, barriers, or goals you want to work on today..." />
          </label>
          <label className="field-label">
            Anything else you want your clinician to know?
            <textarea value={patientStatement} onChange={(event) => setPatientStatement(event.target.value)} placeholder="Optional additional context..." />
          </label>
          <div className="section-actions">
            <button className="button" type="button" onClick={submit} disabled={saving}>
              {saving ? "Submitting…" : "Submit Check-In"}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
