// File: lib/clearinghouse/parsers/x12Segments.ts

export type X12Segment = {
  id: string;
  elements: string[];
  raw: string;
};

export function parseX12Segments(rawX12: string): X12Segment[] {
  return String(rawX12 ?? "")
    .replace(/\r?\n/g, "")
    .split("~")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split("*");
      return {
        id: parts[0] ?? "",
        elements: parts.slice(1),
        raw,
      };
    });
}

export function splitComposite(value: string | null | undefined) {
  return String(value ?? "").split(":");
}

export function normalizeX12Date(value: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\D/g, "");
  if (v.length !== 8) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

export function parseX12Money(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
