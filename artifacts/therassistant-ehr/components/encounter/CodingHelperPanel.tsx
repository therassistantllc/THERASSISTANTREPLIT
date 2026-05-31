"use client";

import { useMemo, useState } from "react";
import { analyzeMedicaidDocumentation } from "@/lib/encounters/medicaidCodeDetection";
import type { SoapNoteData } from "@/components/encounter/SoapNoteEditor";
import type { Diagnosis } from "@/components/encounter/DiagnosisPicker";
import type { ServiceLine } from "@/components/encounter/CptCodePanel";
import CodingQuestionnaire from "@/components/encounter/coding-helper/CodingQuestionnaire";
import { buildCodingReport, type CodingHelperReport } from "@/components/encounter/coding-helper/buildCodingReport";
import { scoreCodingQuestionnaire } from "@/components/encounter/coding-helper/scoring";

type CodingQuestionnaireAnswers = Partial<Record<string, string>>;

type Props = {
  encounterId: string;
  organizationId: string;
  practiceName?: string;
  providerName?: string;
  dateOfService?: string | null;
  clientName?: string;
  payerName?: string | null;
  isMedicaid: boolean;
  soapNote: SoapNoteData;
  diagnoses: Diagnosis[];
  serviceLines: ServiceLine[];
  onApplySuggestedCodes: (codes: string[]) => void;
  onSaveReport: (report: CodingHelperReport) => Promise<void>;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sectionsFromState(params: {
  soapNote: SoapNoteData;
  diagnoses: Diagnosis[];
  serviceLines: ServiceLine[];
  clientName?: string;
  payerName?: string | null;
  isMedicaid: boolean;
}) {
  const { soapNote, diagnoses, serviceLines, clientName, payerName, isMedicaid } = params;
  const diagnosisSummary = diagnoses
    .filter((d) => clean(d.diagnosis_code).length > 0)
    .map((d) => `${clean(d.diagnosis_code)}${clean(d.diagnosis_description) ? ` (${clean(d.diagnosis_description)})` : ""}`)
    .join(", ");

  const serviceSummary = serviceLines
    .map((line) => {
      const code = clean(line.cpt_hcpcs_code) || "(uncoded)";
      const units = Number.isFinite(Number(line.units)) ? Number(line.units) : 1;
      const date = clean(line.service_date);
      return `Code ${code}, units ${units}${date ? `, service date ${date}` : ""}`;
    })
    .join("; ");

  return [
    clean(clientName) ? `Client: ${clean(clientName)}` : "",
    clean(payerName) ? `Payer: ${clean(payerName)}` : "",
    `Coverage: ${isMedicaid ? "Medicaid" : "Non-Medicaid"}`,
    clean(soapNote.subjective) ? `Subjective: ${clean(soapNote.subjective)}` : "",
    clean(soapNote.objective) ? `Objective: ${clean(soapNote.objective)}` : "",
    clean(soapNote.assessment) ? `Assessment: ${clean(soapNote.assessment)}` : "",
    clean(soapNote.plan) ? `Plan: ${clean(soapNote.plan)}` : "",
    diagnosisSummary ? `Diagnoses: ${diagnosisSummary}` : "",
    serviceSummary ? `Service lines: ${serviceSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export default function CodingHelperPanel(props: Props) {
  const {
    encounterId,
    practiceName,
    providerName,
    dateOfService,
    clientName,
    payerName,
    isMedicaid,
    soapNote,
    diagnoses,
    serviceLines,
    onApplySuggestedCodes,
    onSaveReport,
  } = props;

  const [answers, setAnswers] = useState<CodingQuestionnaireAnswers>({});
  const [latestReport, setLatestReport] = useState<CodingHelperReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelMessage, setPanelMessage] = useState<string | null>(null);

  const documentationText = useMemo(
    () =>
      sectionsFromState({
        soapNote,
        diagnoses,
        serviceLines,
        clientName,
        payerName,
        isMedicaid,
      }),
    [soapNote, diagnoses, serviceLines, clientName, payerName, isMedicaid],
  );

  const questionnaireScore = useMemo(() => scoreCodingQuestionnaire(answers), [answers]);

  const noteAnalysis = useMemo(() => {
    if (!documentationText.trim()) return null;
    return analyzeMedicaidDocumentation(documentationText);
  }, [documentationText]);

  const suggestedCodes = useMemo(
    () => Array.from(new Set(questionnaireScore.suggestedCodes)),
    [questionnaireScore],
  );

  const auditSummary = useMemo(
    () => [questionnaireScore.summary, noteAnalysis?.auditSummary.join(" ") ?? ""].filter(Boolean).join(" "),
    [questionnaireScore, noteAnalysis],
  );

  function buildReport(): CodingHelperReport {
    return buildCodingReport({
      encounterId,
      practiceName,
      providerName,
      dateOfService,
      clientName,
      answers,
      questionnaireScore,
      noteAnalysis,
    });
  }

  function handleGenerate() {
    setPanelError(null);
    const report = buildReport();
    setLatestReport(report);
    setPanelMessage("Generated coding helper report from current encounter state.");
  }

  function handleApplyCodes() {
    setPanelError(null);
    if (!suggestedCodes.length) {
      setPanelError("No suggested codes are currently available to apply.");
      return;
    }
    onApplySuggestedCodes(suggestedCodes);
    setPanelMessage(`Applied ${suggestedCodes.join(", ")} to service lines.`);
  }

  async function handleSaveReport() {
    setPanelError(null);
    const report = latestReport ?? buildReport();
    setLatestReport(report);

    setSaving(true);
    try {
      await onSaveReport(report);
      setPanelMessage("Saved coding report to encounter records.");
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Failed to save coding report.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "grid", gap: 8 }}>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Practice: {clean(practiceName) || "Unknown"} · Provider: {clean(providerName) || "Unknown"} · Date of service: {clean(dateOfService) || "Unknown"}
        </p>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Client: {clean(clientName) || "Unknown"} · Payer: {clean(payerName) || "Unknown"} · Coverage: {isMedicaid ? "Medicaid" : "Non-Medicaid"}
        </p>
        {!isMedicaid ? (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            The questionnaire logic still runs for non-Medicaid coverage, but payer-specific fit may vary.
          </p>
        ) : null}
      </div>

      <div style={{ marginTop: 16 }}>
        <CodingQuestionnaire answers={answers} onChange={setAnswers} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button className="button button-secondary" type="button" onClick={handleGenerate}>
          Generate Report
        </button>
        <button className="button button-secondary" type="button" onClick={handleApplyCodes} disabled={!suggestedCodes.length}>
          Apply Suggested Codes
        </button>
        <button className="button" type="button" onClick={handleSaveReport} disabled={saving}>
          {saving ? "Saving…" : "Save Report"}
        </button>
      </div>

      {panelMessage ? (
        <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
          {panelMessage}
        </p>
      ) : null}
      {panelError ? (
        <p className="alert-panel" style={{ marginTop: 10 }}>
          {panelError}
        </p>
      ) : null}

      <div className="detail-list" style={{ marginTop: 12 }}>
        <p>
          <strong>Suggested codes:</strong> {suggestedCodes.length ? suggestedCodes.join(", ") : "None yet"}
        </p>
        <p>
          <strong>Audit summary:</strong> {auditSummary}
        </p>
        {questionnaireScore.documentationWarnings.length ? (
          <p>
            <strong>Documentation warnings:</strong> {questionnaireScore.documentationWarnings.join(" | ")}
          </p>
        ) : null}
        {questionnaireScore.screeningDetails.length ? (
          <p>
            <strong>Screening details:</strong> {questionnaireScore.screeningDetails.join(" | ")}
          </p>
        ) : null}
        {noteAnalysis?.recommendations.some((rec) => rec.action === "suggest") ? (
          <p>
            <strong>Note-only suggest signals:</strong> {Array.from(new Set(noteAnalysis.recommendations.filter((rec) => rec.action === "suggest").map((rec) => rec.code))).join(", ")}
          </p>
        ) : null}
      </div>

      {latestReport ? (
        <article className="panel" style={{ marginTop: 12, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Generated Report Preview</h3>
          <p style={{ marginBottom: 8 }}><strong>Report date:</strong> {latestReport.date}</p>
          <p style={{ marginBottom: 8 }}><strong>Codes:</strong> {latestReport.codes || "None"}</p>
          <p style={{ marginBottom: 8 }}><strong>Summary:</strong> {latestReport.auditSummary}</p>
          <p style={{ marginBottom: 8 }}><strong>Coding rationale:</strong> {latestReport.codingRationale}</p>
          <p style={{ marginBottom: 8 }}><strong>Documentation gaps:</strong> {latestReport.documentationGaps.length ? latestReport.documentationGaps.join(" | ") : "None"}</p>
          <div style={{ marginBottom: 8 }}>
            <strong>Structured report:</strong>
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                borderRadius: 8,
                background: "rgba(15, 23, 42, 0.06)",
                whiteSpace: "pre-wrap",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {latestReport.reportText}
            </pre>
          </div>
          <p style={{ marginBottom: 0 }}><strong>Source encounter:</strong> {latestReport.sourceEncounterId}</p>
        </article>
      ) : null}
    </div>
  );
}

export type { CodingHelperReport };
