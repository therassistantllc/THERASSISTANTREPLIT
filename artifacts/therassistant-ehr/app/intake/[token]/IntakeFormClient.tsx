"use client";

import { useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.css";
import { GAD7_QUESTIONS, PHQ9_QUESTIONS } from "@/lib/intake/scoring";

type IntakeData = {
  organization: { id: string; name: string };
  client: {
    id: string;
    firstName: string;
    lastName: string;
    preferredName: string | null;
    dateOfBirth: string | null;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  token: string;
  expiresAt: string | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: IntakeData }
  | { kind: "done"; scores: { phq9: number | null; gad7: number | null; phq9Severity: string | null; gad7Severity: string | null } };

type FileEntry = { name?: string; type?: string; content?: string };

function buildSurveyJson(data: IntakeData) {
  const c = data.client;
  const choiceLevels = [
    { value: 0, text: "Not at all" },
    { value: 1, text: "Several days" },
    { value: 2, text: "More than half the days" },
    { value: 3, text: "Nearly every day" },
  ];
  return {
    showProgressBar: "top",
    showQuestionNumbers: "off",
    pageNextText: "Continue",
    pagePrevText: "Back",
    completeText: "Submit intake",
    title: "Patient Intake",
    description: `For ${data.organization.name}. Please complete each section before your first visit.`,
    pages: [
      {
        name: "demographics",
        title: "Your information",
        elements: [
          { type: "text", name: "firstName", title: "First name", isRequired: true, defaultValue: c.firstName ?? "" },
          { type: "text", name: "lastName", title: "Last name", isRequired: true, defaultValue: c.lastName ?? "" },
          { type: "text", name: "preferredName", title: "Preferred name", defaultValue: c.preferredName ?? "" },
          { type: "text", name: "dateOfBirth", title: "Date of birth", inputType: "date", defaultValue: c.dateOfBirth ?? "" },
          { type: "text", name: "pronouns", title: "Pronouns" },
          { type: "text", name: "email", title: "Email", inputType: "email", defaultValue: c.email ?? "" },
          { type: "text", name: "phone", title: "Phone", defaultValue: c.phone ?? "" },
          { type: "text", name: "addressLine1", title: "Address line 1", defaultValue: c.addressLine1 ?? "" },
          { type: "text", name: "addressLine2", title: "Address line 2", defaultValue: c.addressLine2 ?? "" },
          { type: "text", name: "city", title: "City", defaultValue: c.city ?? "" },
          { type: "text", name: "state", title: "State", defaultValue: c.state ?? "" },
          { type: "text", name: "postalCode", title: "Postal code", defaultValue: c.postalCode ?? "" },
        ],
      },
      {
        name: "insurance",
        title: "Insurance",
        description: "Enter your primary insurance details. Leave blank if self-pay.",
        elements: [
          { type: "text", name: "planName", title: "Plan / payer name" },
          { type: "text", name: "policyNumber", title: "Member / policy ID" },
          { type: "text", name: "groupNumber", title: "Group number" },
          {
            type: "dropdown",
            name: "subscriberRelationship",
            title: "Relationship to subscriber",
            defaultValue: "self",
            choices: [
              { value: "self", text: "Self" },
              { value: "spouse", text: "Spouse" },
              { value: "child", text: "Child" },
              { value: "other", text: "Other" },
            ],
          },
          {
            type: "file",
            name: "insuranceCardFront",
            title: "Insurance card — front photo",
            storeDataAsText: true,
            allowMultiple: false,
            acceptedTypes: "image/*",
            maxSize: 5 * 1024 * 1024,
          },
          {
            type: "file",
            name: "insuranceCardBack",
            title: "Insurance card — back photo",
            storeDataAsText: true,
            allowMultiple: false,
            acceptedTypes: "image/*",
            maxSize: 5 * 1024 * 1024,
          },
        ],
      },
      {
        name: "phq9",
        title: "PHQ-9 (Depression)",
        description: "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
        elements: [
          {
            type: "matrix",
            name: "phq9",
            title: " ",
            isAllRowRequired: true,
            columns: choiceLevels,
            rows: PHQ9_QUESTIONS.map((q, i) => ({ value: `q${i}`, text: q })),
          },
        ],
      },
      {
        name: "gad7",
        title: "GAD-7 (Anxiety)",
        description: "Over the last 2 weeks, how often have you been bothered by the following problems?",
        elements: [
          {
            type: "matrix",
            name: "gad7",
            title: " ",
            isAllRowRequired: true,
            columns: choiceLevels,
            rows: GAD7_QUESTIONS.map((q, i) => ({ value: `q${i}`, text: q })),
          },
        ],
      },
      {
        name: "consents",
        title: "Consents",
        elements: [
          {
            type: "boolean",
            name: "consentHipaa",
            title: "I acknowledge and agree to the HIPAA Notice of Privacy Practices (required).",
            isRequired: true,
            validators: [{ type: "expression", expression: "{consentHipaa} = true", text: "You must accept the HIPAA consent to continue." }],
          },
          {
            type: "boolean",
            name: "consentTelehealth",
            title: "I acknowledge and agree to the Telehealth Informed Consent (required).",
            isRequired: true,
            validators: [{ type: "expression", expression: "{consentTelehealth} = true", text: "You must accept the Telehealth consent to continue." }],
          },
          {
            type: "boolean",
            name: "consentRoi",
            title: "I authorize the Release of Information (optional).",
          },
        ],
      },
      {
        name: "signature",
        title: "Signature",
        description: "Type your full legal name below. This serves as your electronic signature.",
        elements: [
          { type: "text", name: "signatureName", title: "Typed full legal name", isRequired: true },
        ],
      },
    ],
  };
}

function rowsToArray(rows: Record<string, number | string> | undefined, count: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null);
  if (!rows) return out;
  for (let i = 0; i < count; i++) {
    const raw = rows[`q${i}`];
    if (raw == null || raw === "") continue;
    const num = Number(raw);
    out[i] = Number.isFinite(num) ? num : null;
  }
  return out;
}

function firstFile(value: unknown): FileEntry | null {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) return value[0] as FileEntry;
  if (typeof value === "object") return value as FileEntry;
  return null;
}

export default function IntakeFormClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/intake/${encodeURIComponent(token)}`, { cache: "no-store" });
        const json = await response.json();
        if (cancelled) return;
        if (!response.ok || !json.success) {
          setState({ kind: "error", message: json.error ?? "Unable to load intake form" });
          return;
        }
        setState({ kind: "ready", data: json as IntakeData });
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Unable to load intake form",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const survey = useMemo(() => {
    if (state.kind !== "ready") return null;
    const model = new Model(buildSurveyJson(state.data));
    model.onComplete.add(async (sender, options) => {
      setSubmitError(null);
      options.showSaveInProgress?.("Submitting…");
      try {
        const r = sender.data as Record<string, unknown>;
        const insuranceFront = firstFile(r.insuranceCardFront);
        const insuranceBack = firstFile(r.insuranceCardBack);
        const payload = {
          demographics: {
            firstName: r.firstName ?? "",
            lastName: r.lastName ?? "",
            preferredName: r.preferredName ?? "",
            dateOfBirth: r.dateOfBirth ?? "",
            pronouns: r.pronouns ?? "",
            email: r.email ?? "",
            phone: r.phone ?? "",
            addressLine1: r.addressLine1 ?? "",
            addressLine2: r.addressLine2 ?? "",
            city: r.city ?? "",
            state: r.state ?? "",
            postalCode: r.postalCode ?? "",
          },
          insurance: {
            planName: r.planName ?? "",
            policyNumber: r.policyNumber ?? "",
            groupNumber: r.groupNumber ?? "",
            subscriberRelationship: r.subscriberRelationship ?? "self",
            cardFront: insuranceFront
              ? { name: insuranceFront.name, type: insuranceFront.type, content: insuranceFront.content }
              : null,
            cardBack: insuranceBack
              ? { name: insuranceBack.name, type: insuranceBack.type, content: insuranceBack.content }
              : null,
          },
          consents: {
            hipaa: Boolean(r.consentHipaa),
            telehealth: Boolean(r.consentTelehealth),
            roi: Boolean(r.consentRoi),
          },
          screeners: {
            phq9: rowsToArray(r.phq9 as Record<string, number>, PHQ9_QUESTIONS.length),
            gad7: rowsToArray(r.gad7 as Record<string, number>, GAD7_QUESTIONS.length),
          },
          signatureName: String(r.signatureName ?? "").trim(),
        };
        const response = await fetch(`/api/intake/${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await response.json();
        if (!response.ok || !json.success) throw new Error(json.error ?? "Submission failed");
        options.showSaveSuccess?.("Submitted");
        setState({
          kind: "done",
          scores: {
            phq9: json.scores?.phq9?.score ?? null,
            gad7: json.scores?.gad7?.score ?? null,
            phq9Severity: json.scores?.phq9?.severity ?? null,
            gad7Severity: json.scores?.gad7?.severity ?? null,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Submission failed";
        options.showSaveError?.(message);
        setSubmitError(message);
      }
    });
    return model;
  }, [state, token]);

  if (state.kind === "loading") {
    return (
      <main className="app-shell">
        <section className="panel"><div className="empty-state">Loading your intake form…</div></section>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="app-shell">
        <section className="panel">
          <div className="alert-panel">{state.message}</div>
          <p className="muted">If this link expired or was already used, please contact your provider for a new link.</p>
        </section>
      </main>
    );
  }

  if (state.kind === "done") {
    return (
      <main className="app-shell">
        <section className="hero-panel">
          <div>
            <p className="eyebrow">Intake complete</p>
            <h1>Thank you</h1>
            <p className="hero-copy">Your provider has received your information. You can close this window.</p>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><h2 style={{ margin: 0 }}>Screener results</h2></div>
          <p>PHQ-9 score: <strong>{state.scores.phq9 ?? "—"}</strong> ({state.scores.phq9Severity ?? "—"})</p>
          <p>GAD-7 score: <strong>{state.scores.gad7 ?? "—"}</strong> ({state.scores.gad7Severity ?? "—"})</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {submitError ? <div className="alert-panel">{submitError}</div> : null}
      {survey ? <Survey model={survey} /> : null}
    </main>
  );
}
