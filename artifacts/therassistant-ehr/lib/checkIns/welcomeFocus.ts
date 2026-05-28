export const WELCOME_FOCUS_OPTIONS = {
  continue_goals: "Continue working on my current goals",
  new_concern: "I want to discuss a new concern or stressor",
  symptoms_changed: "My symptoms or situation have changed",
  update_goals: "I would like to update my treatment goals",
  not_sure: "I'm not sure",
} as const;

export type WelcomeFocusOptionKey = keyof typeof WELCOME_FOCUS_OPTIONS;

export const WELCOME_FOCUS_OPTION_KEYS = Object.keys(
  WELCOME_FOCUS_OPTIONS,
) as WelcomeFocusOptionKey[];

export const WELCOME_FOCUS_REFLECTION_MAX = 4000;

export function isWelcomeFocusOption(value: unknown): value is WelcomeFocusOptionKey {
  return typeof value === "string" && value in WELCOME_FOCUS_OPTIONS;
}

export function welcomeFocusLabel(value: unknown): string {
  return isWelcomeFocusOption(value) ? WELCOME_FOCUS_OPTIONS[value] : "";
}

export const CHECK_IN_SUBJECTIVE_MARKER = "[Pre-session check-in]";
const CHECK_IN_SUBJECTIVE_MARKER_END = "[/Pre-session check-in]";

export function composeCheckInSubjectiveBlock(input: {
  focusOption?: string | null;
  focusReflection?: string | null;
}): string {
  const label = welcomeFocusLabel(input.focusOption);
  const reflection = (input.focusReflection ?? "").trim();
  if (!label && !reflection) return "";
  const lines: string[] = [
    CHECK_IN_SUBJECTIVE_MARKER,
    "(From client's pre-session check-in)",
  ];
  if (label) lines.push(`Focus for today: ${label}`);
  if (reflection) lines.push(`Client reflection: ${reflection}`);
  lines.push(CHECK_IN_SUBJECTIVE_MARKER_END);
  return lines.join("\n");
}

export function mergeCheckInIntoSubjective(
  existingSubjective: string,
  block: string,
): string {
  if (!block) return existingSubjective ?? "";
  const current = existingSubjective ?? "";
  if (current.includes(CHECK_IN_SUBJECTIVE_MARKER)) return current;
  const trimmed = current.trim();
  return trimmed ? `${block}\n\n${trimmed}` : block;
}
