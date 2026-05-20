export type ScreenerAnswer = 0 | 1 | 2 | 3;

export const PHQ9_QUESTIONS: string[] = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself — or that you are a failure",
  "Trouble concentrating on things",
  "Moving or speaking so slowly that other people noticed (or the opposite — being fidgety/restless)",
  "Thoughts that you would be better off dead, or of hurting yourself",
];

export const GAD7_QUESTIONS: string[] = [
  "Feeling nervous, anxious, or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it is hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid as if something awful might happen",
];

export const SCREENER_OPTIONS: { value: ScreenerAnswer; label: string }[] = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
];

export function scoreAnswers(answers: unknown, expectedCount: number): number | null {
  if (!Array.isArray(answers)) return null;
  if (answers.length !== expectedCount) return null;
  let total = 0;
  for (const value of answers) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 3) return null;
    total += Math.round(num);
  }
  return total;
}

export function phq9Severity(score: number | null): string | null {
  if (score == null) return null;
  if (score <= 4) return "minimal";
  if (score <= 9) return "mild";
  if (score <= 14) return "moderate";
  if (score <= 19) return "moderately_severe";
  return "severe";
}

export function gad7Severity(score: number | null): string | null {
  if (score == null) return null;
  if (score <= 4) return "minimal";
  if (score <= 9) return "mild";
  if (score <= 14) return "moderate";
  return "severe";
}
