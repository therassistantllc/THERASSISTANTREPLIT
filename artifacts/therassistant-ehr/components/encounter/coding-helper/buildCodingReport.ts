import type { Diagnosis } from "@/components/encounter/DiagnosisPicker";
import type { ServiceLine } from "@/components/encounter/CptCodePanel";
import type { SoapNoteData } from "@/components/encounter/SoapNoteEditor";
import type { MedicaidDetectionResult } from "@/lib/encounters/medicaidCodeDetection";
import type { CodingQuestionnaireScore } from "./scoring";

type CodingQuestionnaireAnswers = Partial<Record<string, string>>;

export type CodingHelperReport = {
  id: string;
  date: string;
  codes: string;
  auditSummary: string;
  formSummary: string;
  encounterId: string;
  organizationId: string;
  answers: CodingQuestionnaireAnswers;
  questionnaireScore: CodingQuestionnaireScore;
  suggestedCodes: string[];
  documentationWarnings: string[];
  sourceSnapshot: string;
  noteAnalysisSummary: string[];
  noteSuggestedCodes: string[];
};

type BuildCodingReportParams = {
  encounterId: string;
  organizationId: string;
  answers: CodingQuestionnaireAnswers;
  questionnaireScore: CodingQuestionnaireScore;
  noteAnalysis: MedicaidDetectionResult | null;
  sourceSnapshot: string;
  soapNote: SoapNoteData;
  diagnoses: Diagnosis[];
  serviceLines: ServiceLine[];
  payerName?: string | null;
  isMedicaid: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildCodingReport(params: BuildCodingReportParams): CodingHelperReport {
  const {
    encounterId,
    organizationId,
    answers,
    questionnaireScore,
    noteAnalysis,
    sourceSnapshot,
    diagnoses,
    serviceLines,
    payerName,
    isMedicaid,
  } = params;
  const date = new Date().toISOString().slice(0, 10);

  const diagnosisSummary = diagnoses
    .filter((item) => clean(item.diagnosis_code))
    .map((item) => `${clean(item.diagnosis_code)}${clean(item.diagnosis_description) ? ` (${clean(item.diagnosis_description)})` : ""}`)
    .join(", ");

  const lineSummary = serviceLines
    .map((item) => `${clean(item.cpt_hcpcs_code) || "(uncoded)"} x${Number.isFinite(Number(item.units)) ? Number(item.units) : 1}`)
    .join(", ");

  const noteSuggestedCodes = Array.from(
    new Set(
      (noteAnalysis?.recommendations ?? [])
        .filter((item) => item.action === "suggest")
        .map((item) => item.code),
    ),
  );

  const suggestedCodes = Array.from(new Set(questionnaireScore.suggestedCodes));

  const scoreBreakdown = questionnaireScore.codeScores
    .map((score) => `${score.code}: ${score.earnedPoints}/${score.possiblePoints} (${score.status})`)
    .join("\n");

  const sectionBreakdown = questionnaireScore.sectionScores
    .map((section) => `${section.title}: ${section.earnedPoints}/${section.possiblePoints} across ${section.answeredQuestions} answered questions`)
    .join("\n");

  const documentationWarnings = Array.from(
    new Set([
      ...questionnaireScore.documentationWarnings,
      ...(noteAnalysis?.globalWarnings ?? []),
    ]),
  );

  const auditSummary = [
    questionnaireScore.summary,
    noteAnalysis?.auditSummary.length ? `Note analysis: ${noteAnalysis.auditSummary.join(" ")}` : "",
    noteSuggestedCodes.length ? `Note-only supported codes: ${noteSuggestedCodes.join(", ")}. These are not auto-applied without questionnaire support.` : "",
  ].filter(Boolean).join(" ");

  const formSummary = [
    `Encounter: ${encounterId}`,
    `Organization: ${organizationId}`,
    `Coverage: ${isMedicaid ? "Medicaid" : "Non-Medicaid"}`,
    clean(payerName) ? `Payer: ${clean(payerName)}` : "",
    diagnosisSummary ? `Diagnoses: ${diagnosisSummary}` : "",
    lineSummary ? `Service lines: ${lineSummary}` : "",
    `Suggested codes: ${suggestedCodes.length ? suggestedCodes.join(", ") : "None"}`,
    noteSuggestedCodes.length ? `Note-only suggest signals: ${noteSuggestedCodes.join(", ")}` : "",
    "",
    "Questionnaire score by code:",
    scoreBreakdown || "No code scores available.",
    "",
    "Questionnaire score by section:",
    sectionBreakdown || "No section scores available.",
    documentationWarnings.length ? `Documentation warnings: ${documentationWarnings.join(" | ")}` : "",
    "",
    "Source snapshot:",
    sourceSnapshot,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `coding-helper-${encounterId}-${Date.now()}`,
    date,
    codes: suggestedCodes.join(", "),
    auditSummary,
    formSummary,
    encounterId,
    organizationId,
    answers,
    questionnaireScore,
    suggestedCodes,
    documentationWarnings,
    sourceSnapshot,
    noteAnalysisSummary: noteAnalysis?.auditSummary ?? [],
    noteSuggestedCodes,
  };
}