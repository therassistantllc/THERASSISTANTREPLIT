import type { MedicaidDetectionResult } from "@/lib/encounters/medicaidCodeDetection";
import type { CodingQuestionnaireScore } from "./scoring";

type CodingQuestionnaireAnswers = Partial<Record<string, string>>;

type ReportCode = "H0002" | "H0031" | "H0001" | "H0032";

type CodeReportReference = {
  description: string;
  reimbursementRange: string;
  legalCitations: string[];
  medicalNecessityStandard: string;
  requiredDocumentation: string[];
  suggestedDocumentationLanguage: string;
  commonDeficiencies: string[];
};

export type CodingReportSection = {
  code: string;
  description: string;
  reimbursementRange: string;
  whyCodeSupported: string;
  legalCitations: string;
  medicalNecessityStandard: string;
  requiredDocumentation: string;
  suggestedDocumentationLanguage: string;
  commonDeficiencies: string;
};

type CodingReportLegalHeader = {
  practiceName: string;
  providerName: string;
  dateOfService: string;
  clientName: string;
};

const CODE_REPORT_REFERENCE: Record<ReportCode, CodeReportReference> = {
  H0002: {
    description: "Behavioral health screening using a structured and validated screening process.",
    reimbursementRange: "Varies by Medicaid fee schedule and state; commonly low-complexity screening reimbursement.",
    legalCitations: [
      "HCPCS Level II code set (CMS annual release)",
      "42 U.S.C. 1396d(a)(13)(C)",
      "42 CFR 440.130(d)",
    ],
    medicalNecessityStandard: "Documentation should show that screening results were clinically reviewed and informed treatment decisions.",
    requiredDocumentation: [
      "Name of screening tool",
      "Scored results",
      "Clinical interpretation",
      "Clinical action taken from results",
    ],
    suggestedDocumentationLanguage: "A validated screening tool was administered, scored, reviewed with the client, and used to guide the treatment plan.",
    commonDeficiencies: [
      "No tool name documented",
      "No score or interpretation",
      "No linkage between screening findings and treatment action",
    ],
  },
  H0031: {
    description: "Biopsychosocial or mental health assessment/reassessment beyond routine psychotherapy.",
    reimbursementRange: "Varies by state Medicaid fee schedule and rendering provider qualifications.",
    legalCitations: [
      "HCPCS Level II code set (CMS annual release)",
      "42 U.S.C. 1396d(a)(13)(C)",
      "42 CFR 440.130(d)",
    ],
    medicalNecessityStandard: "Record should support assessment-level service with symptom severity, functional impact, risk review, and diagnostic rationale.",
    requiredDocumentation: [
      "Presenting symptoms and severity",
      "Functional impact domains",
      "Risk and safety findings",
      "Diagnostic impression and rationale",
      "Reason for assessment or reassessment",
    ],
    suggestedDocumentationLanguage: "Assessment findings demonstrated clinically significant symptoms, functional impairment, and diagnostic considerations requiring assessment-level service.",
    commonDeficiencies: [
      "Psychotherapy-only language with no assessment findings",
      "No diagnostic rationale",
      "No documented functional impairment or risk review",
    ],
  },
  H0001: {
    description: "Alcohol and drug assessment addressing substance use history, severity, and care needs.",
    reimbursementRange: "Varies by state Medicaid fee schedule and benefit design for SUD services.",
    legalCitations: [
      "HCPCS Level II code set (CMS annual release)",
      "42 U.S.C. 1396d(a)(13)(C)",
      "42 CFR 440.130(d)",
    ],
    medicalNecessityStandard: "Documentation should support structured substance use assessment with clinical findings and disposition decisions.",
    requiredDocumentation: [
      "Substances used with frequency/amount",
      "Last use and relapse/craving risk",
      "Functional or legal impact",
      "Diagnostic impression",
      "Level-of-care or referral rationale",
    ],
    suggestedDocumentationLanguage: "A structured substance use assessment was completed, including risk profile, diagnostic findings, and medical necessity for recommended level of care.",
    commonDeficiencies: [
      "Substance use mentioned but not assessed",
      "No severity or risk analysis",
      "No diagnostic or level-of-care rationale",
    ],
  },
  H0032: {
    description: "Treatment planning activity including development or formal review/update of goals and interventions.",
    reimbursementRange: "Varies by state Medicaid fee schedule and plan-of-care policy requirements.",
    legalCitations: [
      "HCPCS Level II code set (CMS annual release)",
      "42 U.S.C. 1396d(a)(13)(C)",
      "42 CFR 440.130(d)",
    ],
    medicalNecessityStandard: "Record should show medically necessary treatment plan development or revision tied to current clinical status.",
    requiredDocumentation: [
      "Problem list or focus area",
      "Goals and measurable objectives",
      "Interventions and frequency/modality",
      "Progress/barriers and rationale for updates",
      "Client participation in planning",
    ],
    suggestedDocumentationLanguage: "The treatment plan was reviewed and updated to address current symptoms, barriers, goals, and interventions with client collaboration.",
    commonDeficiencies: [
      "Plan update claimed but no goal/objective changes",
      "No clinical reason for plan revision",
      "No client collaboration documented",
    ],
  },
};

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function referenceForCode(code: string): CodeReportReference {
  const typedCode = code as ReportCode;
  return CODE_REPORT_REFERENCE[typedCode] ?? {
    description: "Code guidance is limited. Confirm payer-specific coverage and policy support before billing.",
    reimbursementRange: "Unknown - verify current payer fee schedule.",
    legalCitations: ["HCPCS Level II code set (CMS annual release)", "Payer contract and current state Medicaid policy"],
    medicalNecessityStandard: "Documentation must support the billed service level and clinical necessity.",
    requiredDocumentation: ["Service-specific clinical findings", "Rationale for billed service", "Payer-required elements"],
    suggestedDocumentationLanguage: "Documentation supports medical necessity and code selection based on current clinical findings.",
    commonDeficiencies: ["Insufficient service-specific documentation", "No payer-policy crosswalk"],
  };
}

function buildSectionReportText(section: CodingReportSection, index: number): string {
  return [
    `SECTION ${index + 1}: CODE REVIEW`,
    `CODE: ${section.code}`,
    `DESCRIPTION: ${section.description}`,
    `REIMBURSEMENT RANGE: ${section.reimbursementRange}`,
    `WHY THE CODE IS SUPPORTED: ${section.whyCodeSupported}`,
    `LEGAL CITATIONS: ${section.legalCitations}`,
    `MEDICAL NECESSITY STANDARD: ${section.medicalNecessityStandard}`,
    `REQUIRED DOCUMENTATION: ${section.requiredDocumentation}`,
    `SUGGESTED DOCUMENTATION LANGUAGE: ${section.suggestedDocumentationLanguage}`,
    `COMMON DEFICIENCIES: ${section.commonDeficiencies}`,
  ].join("\n");
}

function buildLegalHeaderText(params: {
  encounterId: string;
  reportDate: string;
  legalHeader: CodingReportLegalHeader;
  sourceReference: string;
}): string {
  const { encounterId, reportDate, legalHeader, sourceReference } = params;
  return [
    "CODING COMPLIANCE REPORT",
    "REPORT CLASSIFICATION: INTERNAL CLINICAL/BILLING DOCUMENT",
    "",
    "CASE IDENTIFICATION",
    `PRACTICE: ${legalHeader.practiceName}`,
    `PROVIDER: ${legalHeader.providerName}`,
    `DATE OF SERVICE: ${legalHeader.dateOfService}`,
    `CLIENT NAME: ${legalHeader.clientName}`,
    `ENCOUNTER ID: ${encounterId}`,
    `REPORT DATE: ${reportDate}`,
    "",
    "LEGAL AND COMPLIANCE NOTICE",
    "This report is generated to support coding review and billing documentation quality. Final billing responsibility remains with the rendering provider and practice compliance program.",
    "",
    "SOURCE RECORD",
    sourceReference,
    "",
  ].join("\n");
}

export type CodingHelperReport = {
  id: string;
  date: string;
  codes: string;
  legalHeader: CodingReportLegalHeader;
  auditSummary: string;
  codingRationale: string;
  documentationGaps: string[];
  sourceEncounterId: string;
  detailedSections: CodingReportSection[];
  reportText: string;
};

type BuildCodingReportParams = {
  encounterId: string;
  practiceName?: string;
  providerName?: string;
  dateOfService?: string | null;
  clientName?: string;
  answers: CodingQuestionnaireAnswers;
  questionnaireScore: CodingQuestionnaireScore;
  noteAnalysis: MedicaidDetectionResult | null;
};

export function buildCodingReport(params: BuildCodingReportParams): CodingHelperReport {
  const {
    encounterId,
    practiceName,
    providerName,
    dateOfService,
    clientName,
    answers,
    questionnaireScore,
    noteAnalysis,
  } = params;
  const date = new Date().toISOString().slice(0, 10);
  const legalHeader: CodingReportLegalHeader = {
    practiceName: practiceName?.trim() || "UNKNOWN PRACTICE",
    providerName: providerName?.trim() || "UNKNOWN PROVIDER",
    dateOfService: dateOfService?.trim() || "UNKNOWN DATE OF SERVICE",
    clientName: clientName?.trim() || "UNKNOWN CLIENT",
  };

  const noteSuggestedCodes = (noteAnalysis?.recommendations ?? [])
    .filter((rec) => rec.action === "suggest")
    .map((rec) => rec.code);
  const suggestedCodes = uniq([...questionnaireScore.suggestedCodes, ...noteSuggestedCodes]);
  const recommendations = (noteAnalysis?.recommendations ?? []).filter(
    (rec) => rec.action === "suggest",
  );
  const recommendationText = recommendations
    .map((rec) => `${rec.code}: ${rec.explanation}`)
    .join(" ");
  const documentationGaps = uniq(recommendations.flatMap((rec) => rec.missingElements));
  const sourceReference = `Generated from encounter ${encounterId} note state on ${new Date().toISOString()}. Clinical note text is not duplicated in this coding report.`;
  const answeredCount = Object.values(answers).filter((value) => String(value ?? "").trim().length > 0).length;

  const auditSummary = [
    questionnaireScore.summary,
    `Questionnaire answered items: ${answeredCount}.`,
    noteAnalysis?.auditSummary.length ? `Note analysis: ${noteAnalysis.auditSummary.join(" ")}` : "",
    sourceReference,
  ].filter(Boolean).join(" ");

  const detailedSections: CodingReportSection[] = (suggestedCodes.length ? suggestedCodes : ["NO_CODE_SUGGESTED"])
    .map((code) => {
      const reference = referenceForCode(code);
      const recommendation = recommendations.find((rec) => rec.code === code);
      const score = questionnaireScore.codeScores.find((entry) => entry.code === code);
      const matchedFromQuestionnaire = score?.matchedQuestions ?? [];
      const missingFromQuestionnaire = score?.missingQuestions ?? [];
      const whySupportedParts = uniq([
        recommendation?.explanation ?? "",
        matchedFromQuestionnaire.length
          ? `Questionnaire support: ${matchedFromQuestionnaire.slice(0, 6).join("; ")}.`
          : "",
        noteAnalysis?.auditSummary.length ? `Documentation audit context: ${noteAnalysis.auditSummary.join(" ")}` : "",
      ]);
      const commonDeficiencies = uniq([
        ...reference.commonDeficiencies,
        ...(recommendation?.missingElements ?? []),
        ...missingFromQuestionnaire,
      ]);

      return {
        code,
        description: reference.description,
        reimbursementRange: reference.reimbursementRange,
        whyCodeSupported: whySupportedParts.join(" ") || "No direct support signal was detected for this code.",
        legalCitations: reference.legalCitations.join("; "),
        medicalNecessityStandard: reference.medicalNecessityStandard,
        requiredDocumentation: uniq([...reference.requiredDocumentation, ...(recommendation?.missingElements ?? [])]).join("; "),
        suggestedDocumentationLanguage: recommendation?.documentationSuggestion ?? reference.suggestedDocumentationLanguage,
        commonDeficiencies: commonDeficiencies.join("; "),
      };
    });

  const legalHeaderText = buildLegalHeaderText({
    encounterId,
    reportDate: date,
    legalHeader,
    sourceReference,
  });
  const summaryText = [
    "EXECUTIVE SUMMARY",
    `SUGGESTED CODES: ${suggestedCodes.length ? suggestedCodes.join(", ") : "NONE"}`,
    `AUDIT SUMMARY: ${auditSummary}`,
    `CODING RATIONALE: ${recommendationText || "No recommendation rows generated."}`,
    `DOCUMENTATION GAPS: ${documentationGaps.length ? documentationGaps.join("; ") : "NONE IDENTIFIED"}`,
    "",
  ].join("\n");
  const detailText = detailedSections.map((section, index) => buildSectionReportText(section, index)).join("\n\n");
  const reportText = [legalHeaderText, summaryText, detailText].filter(Boolean).join("\n");

  return {
    id: `coding-helper-${encounterId}-${Date.now()}`,
    date,
    codes: suggestedCodes.join(", "),
    legalHeader,
    auditSummary,
    codingRationale: recommendationText || "No recommendation rows generated.",
    documentationGaps,
    sourceEncounterId: encounterId,
    detailedSections,
    reportText,
  };
}