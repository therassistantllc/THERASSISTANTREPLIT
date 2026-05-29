"use client";

import {
  CODING_QUESTIONNAIRE_SECTIONS,
  getAnswerString,
  type CodingQuestion,
  type CodingQuestionSection,
  type CodingQuestionnaireAnswers,
} from "./questions";

type Props = {
  answers: CodingQuestionnaireAnswers;
  onChange: (answers: CodingQuestionnaireAnswers) => void;
};

function setAnswer(
  answers: CodingQuestionnaireAnswers,
  id: string,
  value: string,
): CodingQuestionnaireAnswers {
  return {
    ...answers,
    [id]: value,
  };
}

function renderQuestion(params: {
  question: CodingQuestion;
  answers: CodingQuestionnaireAnswers;
  onChange: (answers: CodingQuestionnaireAnswers) => void;
}) {
  const { question, answers, onChange } = params;
  const commonStyle = {
    width: "100%",
    border: "1px solid var(--line, #d9e7f4)",
    borderRadius: 8,
    padding: "10px 12px",
    background: "#fff",
  } as const;

  if (question.type === "yesNo") {
    const value = getAnswerString(answers, question.id);
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {["yes", "no"].map((option) => {
          const active = value === option;
          return (
            <button
              key={option}
              type="button"
              className={active ? "button" : "button button-secondary"}
              onClick={() => onChange(setAnswer(answers, question.id, option))}
              aria-pressed={active}
            >
              {option === "yes" ? "Yes" : "No"}
            </button>
          );
        })}
      </div>
    );
  }

  return null;
}

function SectionCard(props: {
  section: CodingQuestionSection;
  answers: CodingQuestionnaireAnswers;
  onChange: (answers: CodingQuestionnaireAnswers) => void;
}) {
  const { section, answers, onChange } = props;
  return (
    <section className="panel" style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{section.title}</h3>
        {section.description ? <p className="muted" style={{ margin: "6px 0 0 0", fontSize: 13 }}>{section.description}</p> : null}
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {section.questions.map((question) => {
          if (question.parentId && getAnswerString(answers, question.parentId) !== question.showWhen) return null;
          return (
            <div key={question.id} style={{ display: "grid", gap: 8 }}>
              <label style={{ fontWeight: 600 }}>{question.label}</label>
              {renderQuestion({ question, answers, onChange })}
              {question.helperText ? <p className="muted" style={{ margin: 0, fontSize: 12 }}>{question.helperText}</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function CodingQuestionnaire({ answers, onChange }: Props) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {CODING_QUESTIONNAIRE_SECTIONS.map((section) => (
        <SectionCard key={section.id} section={section} answers={answers} onChange={onChange} />
      ))}
    </div>
  );
}