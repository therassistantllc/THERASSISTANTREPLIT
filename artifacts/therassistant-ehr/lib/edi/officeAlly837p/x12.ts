const ELEMENT_SEPARATOR = "*";
const SEGMENT_TERMINATOR = "~";
const COMPONENT_SEPARATOR = ":";
const REPETITION_SEPARATOR = "^";

export function sanitizeX12(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/[~*:\^\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDateYYYYMMDD(date: string | Date): string {
  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  const trimmed = sanitizeX12(date);
  if (/^\d{8}$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed.replace(/-/g, "").slice(0, 8);
  }

  return formatDateYYYYMMDD(parsed);
}

export function formatMoney(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) return "0.00";
  return numericValue.toFixed(2);
}

export function buildSegment(elements: Array<string | number | null | undefined>): string {
  return elements.map((element) => sanitizeX12(element)).join(ELEMENT_SEPARATOR) + SEGMENT_TERMINATOR;
}

export function generateControlNumber(length = 9): string {
  const safeLength = Math.max(1, Math.floor(length));
  let digits = "";

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(safeLength);
    crypto.getRandomValues(values);
    digits = Array.from(values)
      .map((value) => String(value % 10))
      .join("");
  } else {
    digits = Array.from({ length: safeLength }, () => String(Math.floor(Math.random() * 10))).join("");
  }

  return digits.padStart(safeLength, "0").slice(0, safeLength);
}

export function countSegments(x12: string, fromST = false): number {
  const segments = x12.split(SEGMENT_TERMINATOR).map((segment) => segment.trim()).filter(Boolean);

  if (!fromST) {
    return segments.length;
  }

  const startIndex = segments.findIndex((segment) => segment.startsWith("ST" + ELEMENT_SEPARATOR));
  if (startIndex < 0) {
    return 0;
  }

  return segments.slice(startIndex).length;
}

export const X12 = {
  elementSeparator: ELEMENT_SEPARATOR,
  segmentTerminator: SEGMENT_TERMINATOR,
  componentSeparator: COMPONENT_SEPARATOR,
  repetitionSeparator: REPETITION_SEPARATOR,
} as const;
