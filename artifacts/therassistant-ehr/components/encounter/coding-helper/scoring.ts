import {
  CODING_QUESTIONNAIRE_SECTIONS,
  getAnswerString,
  isYes,
  type CodingQuestionnaireAnswers,
} from "./questions";

export type ScoredCode = "H0002" | "H0031" | "H0001" | "H0032";

export type CodingCodeScore = {
  code: ScoredCode;
  title: string;
  earnedPoints: number;
  possiblePoints: number;
  status: "suggest" | "consider" | "unsupported";
  confidence: "high" | "moderate" | "low";
  suggestThreshold: number;
  considerThreshold: number;
  matchedQuestions: string[];
  missingQuestions: string[];
};

export type CodingQuestionScore = {
  questionId: string;
  label: string;
  answer: string;
  earnedPoints: number;
  possiblePoints: number;
  matchedCodes: Array<{ code: ScoredCode; points: number }>;
};

export type CodingSectionScore = {
  sectionId: string;
  title: string;
  earnedPoints: number;
  possiblePoints: number;
  answeredQuestions: number;
  questionScores: CodingQuestionScore[];
};

export type CodingQuestionnaireScore = {
  suggestedCodes: string[];
  consideredCodes: string[];
  totalAnsweredQuestions: number;
  sectionScores: CodingSectionScore[];
  codeScores: CodingCodeScore[];
  screeningDetails: string[];
  documentationWarnings: string[];
  summary: string;
};

type ScoreRule = {
  questionId: string;
  code: ScoredCode;
  points: number;
  description: string;
  when?: (answers: CodingQuestionnaireAnswers) => boolean;
};

type Thresholds = Record<ScoredCode, { title: string; suggest: number; consider: number }>;

const CODE_THRESHOLDS: Thresholds = {
  H0002: { title: "Behavioral Health Screening", suggest: 7, consider: 4 },
  H0031: { title: "Behavioral Health Assessment", suggest: 9, consider: 5 },
  H0001: { title: "Alcohol and Drug Assessment", suggest: 6, consider: 4 },
  H0032: { title: "Treatment Plan Development or Review", suggest: 8, consider: 4 },
};

const SCORE_RULES: ScoreRule[] = [
  { questionId: "screenUsed", code: "H0002", points: 3, description: "Formal screening tool used", when: (answers) => isYes(answers, "screenUsed") },
  { questionId: "screenScored", code: "H0002", points: 2, description: "Screening score documented", when: (answers) => isYes(answers, "screenScored") },
  { questionId: "screenInterpreted", code: "H0002", points: 2, description: "Screening interpreted with client", when: (answers) => isYes(answers, "screenInterpreted") },
  { questionId: "screenAction", code: "H0002", points: 2, description: "Screening informed next steps", when: (answers) => isYes(answers, "screenAction") },
  { questionId: "screenSeverity", code: "H0002", points: 1, description: "Screening severity documented", when: (answers) => isYes(answers, "screenSeverity") },
  { questionId: "screenClinicalSignificance", code: "H0002", points: 1, description: "Clinical significance documented", when: (answers) => isYes(answers, "screenClinicalSignificance") },

  { questionId: "newConcerns", code: "H0031", points: 2, description: "New symptoms reviewed", when: (answers) => isYes(answers, "newConcerns") },
  { questionId: "currentExperience", code: "H0031", points: 1, description: "Current symptoms reviewed", when: (answers) => isYes(answers, "currentExperience") },
  { questionId: "symptomProgression", code: "H0031", points: 2, description: "Symptom progression reviewed", when: (answers) => isYes(answers, "symptomProgression") },
  { questionId: "sessionChanges", code: "H0031", points: 1, description: "Clinical changes reviewed", when: (answers) => isYes(answers, "sessionChanges") },
  { questionId: "severityExploration", code: "H0031", points: 2, description: "Severity explored", when: (answers) => isYes(answers, "severityExploration") },
  { questionId: "onsetHistory", code: "H0031", points: 1, description: "Onset and history reviewed", when: (answers) => isYes(answers, "onsetHistory") },
  { questionId: "mh_social", code: "H0031", points: 2, description: "Social functioning reviewed", when: (answers) => isYes(answers, "mh_social") },
  { questionId: "mh_work", code: "H0031", points: 2, description: "Work or school functioning reviewed", when: (answers) => isYes(answers, "mh_work") },
  { questionId: "mh_adl", code: "H0031", points: 2, description: "Daily living impact reviewed", when: (answers) => isYes(answers, "mh_adl") },
  { questionId: "mh_cognitive", code: "H0031", points: 2, description: "Cognitive impact reviewed", when: (answers) => isYes(answers, "mh_cognitive") },
  { questionId: "mh_risk", code: "H0031", points: 2, description: "Risk reviewed", when: (answers) => isYes(answers, "mh_risk") },
  { questionId: "mh_dxClarified", code: "H0031", points: 3, description: "Diagnostic clarification documented", when: (answers) => isYes(answers, "mh_dxClarified") },
  { questionId: "mh_dxRevised", code: "H0031", points: 2, description: "Diagnosis revised", when: (answers) => isYes(answers, "mh_dxRevised") },
  { questionId: "mh_reassessment", code: "H0031", points: 3, description: "Reassessment documented", when: (answers) => isYes(answers, "mh_reassessment") },

  { questionId: "substanceUse", code: "H0001", points: 2, description: "Substance use assessed", when: (answers) => isYes(answers, "substanceUse") },
  { questionId: "cravingsAssessment", code: "H0001", points: 2, description: "Cravings or relapse risk assessed", when: (answers) => isYes(answers, "cravingsAssessment") },
  { questionId: "triggersIdentification", code: "H0001", points: 2, description: "Triggers reviewed", when: (answers) => isYes(answers, "triggersIdentification") },
  { questionId: "treatmentHistory", code: "H0001", points: 2, description: "Treatment history reviewed", when: (answers) => isYes(answers, "treatmentHistory") },
  { questionId: "asamFactors", code: "H0001", points: 2, description: "ASAM or level of care reviewed", when: (answers) => isYes(answers, "asamFactors") },

  { questionId: "plan_initial", code: "H0032", points: 3, description: "Initial or restarted plan work", when: (answers) => isYes(answers, "plan_initial") },
  { questionId: "plan_newFocus", code: "H0032", points: 2, description: "New focus added", when: (answers) => isYes(answers, "plan_newFocus") },
  { questionId: "plan_goalsRevised", code: "H0032", points: 3, description: "Goals revised", when: (answers) => isYes(answers, "plan_goalsRevised") },
  { questionId: "plan_objectives", code: "H0032", points: 2, description: "Objectives updated", when: (answers) => isYes(answers, "plan_objectives") },
  { questionId: "plan_interventions", code: "H0032", points: 3, description: "Interventions updated", when: (answers) => isYes(answers, "plan_interventions") },
  { questionId: "plan_frequency", code: "H0032", points: 1, description: "Frequency or modality changed", when: (answers) => isYes(answers, "plan_frequency") },
  { questionId: "plan_progress", code: "H0032", points: 1, description: "Progress reviewed", when: (answers) => isYes(answers, "plan_progress") },
  { questionId: "plan_barriers", code: "H0032", points: 1, description: "Barriers reviewed", when: (answers) => isYes(answers, "plan_barriers") },
  { questionId: "plan_collaboration", code: "H0032", points: 1, description: "Client collaboration documented", when: (answers) => isYes(answers, "plan_collaboration") },
  { questionId: "planReason", code: "H0032", points: 2, description: "Reason for plan work documented", when: (answers) => isYes(answers, "planReason") },

];

const SECTION_LOOKUP = new Map(
  CODING_QUESTIONNAIRE_SECTIONS.flatMap((section) =>
    section.questions.map((question) => [question.id, { sectionId: section.id, sectionTitle: section.title, questionLabel: question.label }]),
  ),
);

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function confidenceFromStatus(status: CodingCodeScore["status"], ratio: number): CodingCodeScore["confidence"] {
  if (status === "unsupported") return "low";
  if (ratio >= 1.25) return "high";
  if (ratio >= 1) return "moderate";
  return "low";
}

export function scoreCodingQuestionnaire(answers: CodingQuestionnaireAnswers): CodingQuestionnaireScore {
  const questionScores = new Map<string, CodingQuestionScore>();
  const earnedByCode = new Map<ScoredCode, number>();
  const possibleByCode = new Map<ScoredCode, number>();
  const matchedByCode = new Map<ScoredCode, Set<string>>();
  const possibleByQuestion = new Map<string, number>();

  for (const rule of SCORE_RULES) {
    possibleByCode.set(rule.code, (possibleByCode.get(rule.code) ?? 0) + rule.points);
    possibleByQuestion.set(rule.questionId, Math.max(possibleByQuestion.get(rule.questionId) ?? 0, rule.points + (possibleByQuestion.get(rule.questionId) ?? 0)));

    const answer = clean(getAnswerString(answers, rule.questionId));
    if (!questionScores.has(rule.questionId)) {
      const meta = SECTION_LOOKUP.get(rule.questionId);
      questionScores.set(rule.questionId, {
        questionId: rule.questionId,
        label: meta?.questionLabel ?? rule.questionId,
        answer,
        earnedPoints: 0,
        possiblePoints: 0,
        matchedCodes: [],
      });
    }
    const scoreEntry = questionScores.get(rule.questionId);
    if (!scoreEntry) continue;
    scoreEntry.possiblePoints += rule.points;
    scoreEntry.answer = answer;

    const matched = rule.when ? rule.when(answers) : isYes(answers, rule.questionId);
    if (!matched) continue;

    earnedByCode.set(rule.code, (earnedByCode.get(rule.code) ?? 0) + rule.points);
    if (!matchedByCode.has(rule.code)) matchedByCode.set(rule.code, new Set());
    matchedByCode.get(rule.code)?.add(scoreEntry.label);
    scoreEntry.earnedPoints += rule.points;
    scoreEntry.matchedCodes.push({ code: rule.code, points: rule.points });
  }

  const sectionScores: CodingSectionScore[] = CODING_QUESTIONNAIRE_SECTIONS.map((section) => {
    const sectionQuestionScores = section.questions.map((question) => {
      const existing = questionScores.get(question.id);
      return existing ?? {
        questionId: question.id,
        label: question.label,
        answer: clean(getAnswerString(answers, question.id)),
        earnedPoints: 0,
        possiblePoints: 0,
        matchedCodes: [],
      };
    });

    return {
      sectionId: section.id,
      title: section.title,
      earnedPoints: sectionQuestionScores.reduce((sum, item) => sum + item.earnedPoints, 0),
      possiblePoints: sectionQuestionScores.reduce((sum, item) => sum + item.possiblePoints, 0),
      answeredQuestions: sectionQuestionScores.filter((item) => item.answer.length > 0).length,
      questionScores: sectionQuestionScores,
    };
  });

  const codeScores = (Object.keys(CODE_THRESHOLDS) as ScoredCode[]).map((code) => {
    const thresholds = CODE_THRESHOLDS[code];
    const earnedPoints = earnedByCode.get(code) ?? 0;
    const possiblePoints = possibleByCode.get(code) ?? 0;
    const status: CodingCodeScore["status"] = earnedPoints >= thresholds.suggest
      ? "suggest"
      : earnedPoints >= thresholds.consider
        ? "consider"
        : "unsupported";
    const ratio = thresholds.suggest ? earnedPoints / thresholds.suggest : 0;
    const matchedQuestions = Array.from(matchedByCode.get(code) ?? []);
    const missingQuestions = SCORE_RULES.filter((rule) => rule.code === code && !(rule.when ? rule.when(answers) : isYes(answers, rule.questionId)))
      .map((rule) => SECTION_LOOKUP.get(rule.questionId)?.questionLabel ?? rule.questionId)
      .slice(0, 5);

    return {
      code,
      title: thresholds.title,
      earnedPoints,
      possiblePoints,
      status,
      confidence: confidenceFromStatus(status, ratio),
      suggestThreshold: thresholds.suggest,
      considerThreshold: thresholds.consider,
      matchedQuestions,
      missingQuestions,
    };
  });

  const totalAnsweredQuestions = sectionScores.reduce((sum, section) => sum + section.answeredQuestions, 0);
  const screeningDetails = [
    isYes(answers, "screenUsed") ? "Screening tool used" : "",
    isYes(answers, "screenScored") ? "Score documented" : "",
    isYes(answers, "screenInterpreted") ? "Results discussed" : "",
    isYes(answers, "screenAction") ? "Result used for next step" : "",
    isYes(answers, "screenSeverity") ? "Screening severity documented" : "",
    isYes(answers, "screenClinicalSignificance") ? "Clinically significant symptoms documented" : "",
  ].filter(Boolean);
  const documentationWarnings = new Set<string>();
  if (!totalAnsweredQuestions) documentationWarnings.add("No questionnaire answers have been recorded yet.");
  if (codeScores.find((score) => score.code === "H0032")?.status === "suggest" && !["plan_goalsRevised", "plan_objectives", "plan_interventions"].some((key) => isYes(answers, key))) {
    documentationWarnings.add("Treatment planning scored as supported, but core goal/objective/intervention changes were not marked yes.");
  }

  const suggestedCodes = codeScores.filter((score) => score.status === "suggest").map((score) => score.code);
  const consideredCodes = codeScores.filter((score) => score.status === "consider").map((score) => score.code);
  const summary = [
    suggestedCodes.length ? `Questionnaire-supported codes: ${suggestedCodes.join(", ")}.` : "Questionnaire scoring did not reach a suggest threshold for add-on codes.",
    consideredCodes.length ? `Consider reviewing: ${consideredCodes.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  return {
    suggestedCodes,
    consideredCodes,
    totalAnsweredQuestions,
    sectionScores,
    codeScores,
    screeningDetails,
    documentationWarnings: Array.from(documentationWarnings),
    summary,
  };
}
