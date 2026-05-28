"use client";

import { useState } from "react";

export type SoapNoteData = {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
};

type Props = {
  data: SoapNoteData;
  onChange: (updated: SoapNoteData) => void;
  disabled?: boolean;
};

const SECTION_TEMPLATES = {
  subjective: `Chief Complaint: 

History of Present Illness:
- Onset:
- Severity:
- Affecting:

Review of Systems:`,

  objective: `Vital Signs:
- BP:
- HR:
- RR:
- Temp:
- Weight:

Physical Exam:
- General:
- HEENT:
- Cardiopulmonary:
- Abdomen:
- Musculoskeletal:
- Psychiatric:`,

  assessment: `Primary Diagnosis:

Differential/Considerations:

Severity/Acuity:

Functional Impact:`,

  plan: `Treatment Plan:
1.
2.
3.

Follow-up:

Referrals:

Client Education:

Safety Planning:`,
};

export default function SoapNoteEditor({ data, onChange, disabled = false }: Props) {
  const [expandedTemplate, setExpandedTemplate] = useState<keyof typeof SECTION_TEMPLATES | null>(null);

  function insertTemplate(section: keyof typeof SECTION_TEMPLATES) {
    const current = data[section] || "";
    const template = SECTION_TEMPLATES[section];
    const updated = current ? `${current}\n\n${template}` : template;
    onChange({ ...data, [section]: updated });
    setExpandedTemplate(null);
  }

  return (
    <article className="panel wide-panel">
      <h2>Clinical Documentation (SOAP)</h2>
      <p className="muted">
        Document the encounter using SOAP structure. Template buttons insert guidance; remove or modify as needed.
      </p>

      <div className="soap-sections">
        {/* SUBJECTIVE */}
        <div className="soap-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <label>
              <strong>Subjective</strong>
              <span className="muted" style={{ fontSize: "0.875rem", marginLeft: "0.5rem" }}>
                Chief complaint, history, symptoms
              </span>
            </label>
            <button
              type="button"
              className="button button-small"
              onClick={() => setExpandedTemplate(expandedTemplate === "subjective" ? null : "subjective")}
              disabled={disabled}
            >
              {expandedTemplate === "subjective" ? "Hide" : "Template"}
            </button>
          </div>
          {expandedTemplate === "subjective" && (
            <div style={{ marginBottom: "0.5rem", padding: "0.75rem", backgroundColor: "var(--bg-muted)", borderRadius: "4px" }}>
              <p style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap" }}>{SECTION_TEMPLATES.subjective}</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => insertTemplate("subjective")}
                disabled={disabled}
              >
                Insert Template
              </button>
            </div>
          )}
          <textarea
            value={data.subjective || ""}
            onChange={(e) => onChange({ ...data, subjective: e.target.value })}
            placeholder="Document the session from client perspective..."
            disabled={disabled}
            style={{ minHeight: "120px" }}
          />
        </div>

        {/* OBJECTIVE */}
        <div className="soap-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <label>
              <strong>Objective</strong>
              <span className="muted" style={{ fontSize: "0.875rem", marginLeft: "0.5rem" }}>
                Observations, vitals, exam findings
              </span>
            </label>
            <button
              type="button"
              className="button button-small"
              onClick={() => setExpandedTemplate(expandedTemplate === "objective" ? null : "objective")}
              disabled={disabled}
            >
              {expandedTemplate === "objective" ? "Hide" : "Template"}
            </button>
          </div>
          {expandedTemplate === "objective" && (
            <div style={{ marginBottom: "0.5rem", padding: "0.75rem", backgroundColor: "var(--bg-muted)", borderRadius: "4px" }}>
              <p style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap" }}>{SECTION_TEMPLATES.objective}</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => insertTemplate("objective")}
                disabled={disabled}
              >
                Insert Template
              </button>
            </div>
          )}
          <textarea
            value={data.objective || ""}
            onChange={(e) => onChange({ ...data, objective: e.target.value })}
            placeholder="Record observations, exam findings, vital signs..."
            disabled={disabled}
            style={{ minHeight: "120px" }}
          />
        </div>

        {/* ASSESSMENT */}
        <div className="soap-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <label>
              <strong>Assessment</strong>
              <span className="muted" style={{ fontSize: "0.875rem", marginLeft: "0.5rem" }}>
                Diagnosis, impression, clinical reasoning
              </span>
            </label>
            <button
              type="button"
              className="button button-small"
              onClick={() => setExpandedTemplate(expandedTemplate === "assessment" ? null : "assessment")}
              disabled={disabled}
            >
              {expandedTemplate === "assessment" ? "Hide" : "Template"}
            </button>
          </div>
          {expandedTemplate === "assessment" && (
            <div style={{ marginBottom: "0.5rem", padding: "0.75rem", backgroundColor: "var(--bg-muted)", borderRadius: "4px" }}>
              <p style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap" }}>{SECTION_TEMPLATES.assessment}</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => insertTemplate("assessment")}
                disabled={disabled}
              >
                Insert Template
              </button>
            </div>
          )}
          <textarea
            value={data.assessment || ""}
            onChange={(e) => onChange({ ...data, assessment: e.target.value })}
            placeholder="Document your clinical assessment and reasoning..."
            disabled={disabled}
            style={{ minHeight: "120px" }}
          />
        </div>

        {/* PLAN */}
        <div className="soap-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <label>
              <strong>Plan</strong>
              <span className="muted" style={{ fontSize: "0.875rem", marginLeft: "0.5rem" }}>
                Treatment, referrals, follow-up
              </span>
            </label>
            <button
              type="button"
              className="button button-small"
              onClick={() => setExpandedTemplate(expandedTemplate === "plan" ? null : "plan")}
              disabled={disabled}
            >
              {expandedTemplate === "plan" ? "Hide" : "Template"}
            </button>
          </div>
          {expandedTemplate === "plan" && (
            <div style={{ marginBottom: "0.5rem", padding: "0.75rem", backgroundColor: "var(--bg-muted)", borderRadius: "4px" }}>
              <p style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap" }}>{SECTION_TEMPLATES.plan}</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => insertTemplate("plan")}
                disabled={disabled}
              >
                Insert Template
              </button>
            </div>
          )}
          <textarea
            value={data.plan || ""}
            onChange={(e) => onChange({ ...data, plan: e.target.value })}
            placeholder="Outline the treatment plan, follow-up, and client instructions..."
            disabled={disabled}
            style={{ minHeight: "120px" }}
          />
        </div>
      </div>

      <style jsx>{`
        .soap-sections {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          margin-top: 1rem;
        }

        .soap-section {
          border-left: 4px solid var(--line);
          padding-left: 1rem;
        }

        .soap-section textarea {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid var(--line);
          border-radius: 4px;
          font-family: inherit;
          font-size: 0.9rem;
        }

        .soap-section textarea:disabled {
          background-color: var(--bg-muted);
          color: var(--muted);
          cursor: not-allowed;
        }

        .button-small {
          padding: 0.4rem 0.8rem;
          font-size: 0.875rem;
        }
      `}</style>
    </article>
  );
}
