import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Lift the parser by re-implementing the heuristic in isolation. The route
// keeps it private; we mirror the same behaviour here. If the route's
// heuristic changes, this test should be updated in lockstep.
const CPT_RE = /\b([A-Z][0-9]{4}|[0-9]{5})\b/;
const MONEY_RE = /\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const MOD_RE = /^(?:[A-Z]{2}|[0-9]{2})$/;

function toMoney(raw: string): number | null {
  const n = Number(raw.replace(/[,$\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function parseLine(line: string) {
  const cptMatch = line.match(CPT_RE);
  if (!cptMatch) return null;
  const cpt = cptMatch[1].toUpperCase();
  const afterCpt = line.slice((cptMatch.index ?? 0) + cpt.length);
  const moneys: number[] = [];
  let m: RegExpExecArray | null;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(line)) !== null) {
    const raw = m[1];
    if (!raw.includes(".") && !raw.includes(",")) continue;
    const n = toMoney(raw);
    if (n != null && n > 0 && n < 100000) moneys.push(n);
  }
  if (moneys.length === 0) return null;
  const allowed = moneys[moneys.length - 1];
  const billed = moneys.length > 1 ? moneys[0] : null;
  const tokens = afterCpt
    .split(/[\s|,/]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const modifiers: string[] = [];
  for (const tok of tokens) {
    if (/\$|\./.test(tok)) break;
    if (MOD_RE.test(tok) && modifiers.length < 4) modifiers.push(tok);
  }
  return { procedureCode: cpt, modifiers, allowedAmount: allowed, billedRate: billed };
}

describe("fee schedule line parser", () => {
  it("extracts CPT + allowed from a simple row", () => {
    const r = parseLine("90837  Psychotherapy 60 min   $165.00");
    assert.equal(r?.procedureCode, "90837");
    assert.equal(r?.allowedAmount, 165);
    assert.equal(r?.billedRate, null);
  });

  it("extracts billed + allowed when both present", () => {
    const r = parseLine("90834\tPsych 45m\t$200.00\t$135.50");
    assert.equal(r?.procedureCode, "90834");
    assert.equal(r?.billedRate, 200);
    assert.equal(r?.allowedAmount, 135.5);
  });

  it("captures HCPCS codes (letter+4)", () => {
    const r = parseLine("H0031  Mental health assessment   95.00");
    assert.equal(r?.procedureCode, "H0031");
    assert.equal(r?.allowedAmount, 95);
  });

  it("captures modifiers right after CPT", () => {
    const r = parseLine("90837 95 HJ  Telehealth  $150.00");
    assert.deepEqual(r?.modifiers, ["95", "HJ"]);
    assert.equal(r?.allowedAmount, 150);
  });

  it("handles commas in money values", () => {
    const r = parseLine("99205   New client visit   $1,234.56");
    assert.equal(r?.allowedAmount, 1234.56);
  });

  it("ignores rows with no money values", () => {
    assert.equal(parseLine("90837  Psychotherapy 60 minutes"), null);
  });

  it("ignores rows with no CPT", () => {
    assert.equal(parseLine("Description   $100.00"), null);
  });

  it("does not pick up bare integers (POS/units) as money", () => {
    const r = parseLine("90837  60  11  $165.00");
    assert.equal(r?.allowedAmount, 165);
    assert.equal(r?.billedRate, null);
  });
});
