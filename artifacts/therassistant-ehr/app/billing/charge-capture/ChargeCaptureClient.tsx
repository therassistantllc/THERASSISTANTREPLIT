"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./charge-capture.module.css";
import CodeCombobox, { fetchChildCodes, validateCode } from "./CodeCombobox";
import type { CodeOption, CodeValidation } from "./CodeCombobox";

type ChargeStatus = "ready" | "unsigned" | "missing_dx" | "hold" | "released";

interface ChargeRow {
  id: string;
  clientId: string;
  patient: string;
  dob: string;
  dos: string;
  cpt: string;
  provider: string;
  insurance: string;
  charge: number;
  status: ChargeStatus;
  blockers: string[];
}

type ApiItem = {
  chargeCaptureId: string;
  clientId: string;
  patientName: string;
  dateOfBirth?: string | null;
  serviceDate?: string | null;
  chargeStatus?: string | null;
  totalCharge: number;
  cptCodes?: string[];
  providerName?: string | null;
  payerName?: string | null;
  blockers: Array<{ field?: string; message?: string }>;
};

type ApiPayload = {
  success: boolean;
  error?: string;
  items?: ApiItem[];
};

type ServiceLine = {
  lineNumber: number;
  procedureCode: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  modifiers: string[];
  diagnosisPointers: string[];
  units: number;
  unitOfMeasure: string;
  chargeAmount: number;
  placeOfService: string | null;
  renderingProviderNpi: string | null;
  authorizationNumber: string | null;
};

type ChargeDetail = {
  id: string;
  status: string;
  serviceDate: string | null;
  placeOfService: string | null;
  totalCharge: number;
  blockerReasons: string[];
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    displayName: string;
    dateOfBirth: string | null;
    accountNumber: string | null;
  } | null;
  provider: { id: string; displayName: string; credential: string | null; npi: string | null } | null;
  payer: { id: string; name: string; payerType: string | null } | null;
  policy: {
    id: string;
    planName: string | null;
    policyNumber: string | null;
    subscriberId: string | null;
    copay: number;
    deductible: number;
    coinsurancePercent: number;
    priority: string | null;
  } | null;
  diagnoses: string[];
  serviceLines: ServiceLine[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function mapApiStatus(s?: string | null): ChargeStatus {
  switch (s) {
    case "ready_for_claim": return "ready";
    case "claim_created":
    case "ready_for_batch": return "released";
    case "blocked": return "hold";
    case "validation_failed": return "missing_dx";
    default: return "unsigned";
  }
}

function mapApiItem(item: ApiItem): ChargeRow {
  const blockerMessages = item.blockers.map((b) =>
    [b.field, b.message].filter(Boolean).join(": ") || "Needs review",
  );
  return {
    id: item.chargeCaptureId,
    clientId: item.clientId,
    patient: item.patientName,
    dob: item.dateOfBirth ? new Date(item.dateOfBirth).toLocaleDateString() : "—",
    dos: item.serviceDate ? new Date(item.serviceDate).toLocaleDateString() : "—",
    cpt: (item.cptCodes ?? [])[0] ?? "—",
    provider: item.providerName?.trim() ? item.providerName : "—",
    insurance: item.payerName?.trim() ? item.payerName : "—",
    charge: item.totalCharge,
    status: mapApiStatus(item.chargeStatus),
    blockers: blockerMessages,
  };
}

const STATUS_LABELS: Record<ChargeStatus, string> = {
  ready: "Ready",
  unsigned: "Unsigned",
  missing_dx: "Missing DX",
  hold: "Hold",
  released: "Released",
};
const STATUS_CLASS: Record<ChargeStatus, string> = {
  ready: styles.statusReady,
  unsigned: styles.statusUnsigned,
  missing_dx: styles.statusMissingDx,
  hold: styles.statusHold,
  released: styles.statusReleased,
};

function money(v: number) {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function ageFromDob(dob?: string | null): string {
  if (!dob) return "";
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  return String(Math.floor(ms / (365.25 * 24 * 3600 * 1000)));
}

const POS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "11", label: "11 - Office" },
  { value: "02", label: "02 - Telehealth (other)" },
  { value: "10", label: "10 - Telehealth in home" },
  { value: "12", label: "12 - Home" },
  { value: "53", label: "53 - Community Mental Health" },
  { value: "99", label: "99 - Other" },
];

const EMPTY_LINE: ServiceLine = {
  lineNumber: 0,
  procedureCode: "",
  serviceDateFrom: null,
  serviceDateTo: null,
  modifiers: [],
  diagnosisPointers: ["1"],
  units: 1,
  unitOfMeasure: "UN",
  chargeAmount: 0,
  placeOfService: null,
  renderingProviderNpi: null,
  authorizationNumber: null,
};

type FilterType = "all" | ChargeStatus;

function HeaderChildSuggestions({
  parent,
  onPick,
}: {
  parent: string;
  onPick: (code: string) => void;
}) {
  const [children, setChildren] = useState<CodeOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChildren([]);
    void fetchChildCodes("diagnosis", parent, 8).then((items) => {
      if (cancelled) return;
      setChildren(items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [parent]);

  if (loading) {
    return (
      <div style={{ marginTop: 4, fontSize: 10.5, color: "#94A3B8" }}>
        Loading billable codes under {parent}…
      </div>
    );
  }
  if (children.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 4,
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 10.5, color: "#64748B" }}>Try:</span>
      {children.map((c) => (
        <button
          key={c.code}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c.code.toUpperCase());
          }}
          title={c.description}
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10.5,
            padding: "1px 6px",
            borderRadius: 10,
            border: "1px solid #CBD5E1",
            background: "#F8FAFC",
            color: "#0F172A",
            cursor: "pointer",
            lineHeight: 1.5,
          }}
        >
          {c.code}
        </button>
      ))}
    </div>
  );
}

export default function ChargeCaptureClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [items, setItems] = useState<ChargeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChargeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [invalidDx, setInvalidDx] = useState<Map<string, CodeValidation>>(new Map());
  const [invalidProc, setInvalidProc] = useState<Map<string, CodeValidation>>(new Map());

  // Load workqueue list
  useEffect(() => {
    if (!organizationId) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/billing/claim-readiness?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<ApiPayload>)
      .then((json) => {
        if (json.success && json.items) {
          const list = json.items.map(mapApiItem);
          setItems(list);
          if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, reloadKey]);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetailLoading(true);
    fetch(`/api/billing/charge-capture/${encodeURIComponent(selectedId)}?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setDetail(json.detail);
        else setDetail(null);
      })
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selectedId, organizationId, reloadKey]);

  const counts = useMemo(() => ({
    total: items.length,
    ready: items.filter((c) => c.status === "ready").length,
    released: items.filter((c) => c.status === "released").length,
    unsigned: items.filter((c) => c.status === "unsigned").length,
    missing_dx: items.filter((c) => c.status === "missing_dx").length,
    hold: items.filter((c) => c.status === "hold").length,
  }), [items]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter !== "all") list = list.filter((c) => c.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        c.patient.toLowerCase().includes(q) ||
        c.cpt.toLowerCase().includes(q) ||
        c.provider.toLowerCase().includes(q) ||
        c.insurance.toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, filter, search]);

  const updateLine = useCallback((idx: number, patch: Partial<ServiceLine>) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const lines = prev.serviceLines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      const total = lines.reduce((s, l) => s + (l.chargeAmount || 0) * (l.units || 0), 0);
      return { ...prev, serviceLines: lines, totalCharge: Math.round(total * 100) / 100 };
    });
  }, []);

  const addLine = useCallback(() => {
    setDetail((prev) => prev ? {
      ...prev,
      serviceLines: [...prev.serviceLines, {
        ...EMPTY_LINE,
        lineNumber: prev.serviceLines.length + 1,
        serviceDateFrom: prev.serviceDate,
        serviceDateTo: prev.serviceDate,
        placeOfService: prev.placeOfService,
        renderingProviderNpi: prev.provider?.npi ?? null,
      }],
    } : prev);
  }, []);

  const removeLine = useCallback((idx: number) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const lines = prev.serviceLines.filter((_, i) => i !== idx);
      const total = lines.reduce((s, l) => s + (l.chargeAmount || 0) * (l.units || 0), 0);
      return { ...prev, serviceLines: lines, totalCharge: Math.round(total * 100) / 100 };
    });
  }, []);

  const updateDiagnosis = useCallback((idx: number, value: string) => {
    setDetail((prev) => {
      if (!prev) return prev;
      const dx = [...prev.diagnoses];
      while (dx.length <= idx) dx.push("");
      dx[idx] = value.toUpperCase();
      while (dx.length > 0 && !dx[dx.length - 1]) dx.pop();
      return { ...prev, diagnoses: dx };
    });
  }, []);

  // Validate every non-empty DX and CPT code against reference tables before saving.
  const validateAllCodes = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    if (!detail) return { ok: true };
    const dxCodes = detail.diagnoses.map((d) => d.trim().toUpperCase()).filter(Boolean);
    const procCodes = detail.serviceLines
      .map((l) => l.procedureCode.trim().toUpperCase())
      .filter(Boolean);
    const dxBad = new Map<string, CodeValidation>();
    const procBad = new Map<string, CodeValidation>();
    await Promise.all([
      ...dxCodes.map(async (c) => {
        const v = await validateCode("diagnosis", c);
        if (v.status !== "active") dxBad.set(c, v);
      }),
      ...procCodes.map(async (c) => {
        const v = await validateCode("procedure", c);
        if (v.status !== "active") procBad.set(c, v);
      }),
    ]);
    setInvalidDx(dxBad);
    setInvalidProc(procBad);
    if (dxBad.size === 0 && procBad.size === 0) return { ok: true };
    const describe = (code: string, v: CodeValidation): string => {
      if (v.status === "unknown") return `${code} (not found)`;
      if (v.status === "retired") return `${code} (retired${v.expirationDate ? ` ${v.expirationDate}` : ""})`;
      if (v.status === "header") return `${code} (header — not billable)`;
      return code;
    };
    const parts: string[] = [];
    if (dxBad.size) parts.push(`ICD-10: ${[...dxBad.entries()].map(([c, v]) => describe(c, v)).join(", ")}`);
    if (procBad.size) parts.push(`CPT/HCPCS: ${[...procBad.entries()].map(([c, v]) => describe(c, v)).join(", ")}`);
    return { ok: false, reason: parts.join(" · ") };
  }, [detail]);

  async function saveCharge() {
    if (!detail || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const codeCheck = await validateAllCodes();
      if (!codeCheck.ok) {
        setMessage({ tone: "error", text: codeCheck.reason ?? "Invalid codes" });
        setSaving(false);
        return;
      }
      const res = await fetch(
        `/api/billing/charge-capture/${encodeURIComponent(detail.id)}?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            diagnoses: detail.diagnoses,
            placeOfService: detail.placeOfService,
            serviceDate: detail.serviceDate,
            serviceLines: detail.serviceLines.map((l) => ({
              procedureCode: l.procedureCode,
              serviceDateFrom: l.serviceDateFrom,
              serviceDateTo: l.serviceDateTo,
              modifiers: l.modifiers,
              diagnosisPointers: l.diagnosisPointers,
              units: l.units,
              chargeAmount: l.chargeAmount,
              placeOfService: l.placeOfService,
              renderingProviderNpi: l.renderingProviderNpi,
              authorizationNumber: l.authorizationNumber,
            })),
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Save failed");
      setMessage({ tone: "success", text: "Charge saved." });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function releaseCharge() {
    if (!detail || releasing) return;
    setReleasing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/billing/charge-capture/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, chargeCaptureIds: [detail.id] }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Release failed");
      const first = json.results?.[0];
      if (first && first.ok === false) {
        setMessage({ tone: "error", text: first.errors?.[0]?.message ?? "Release failed" });
      } else {
        setMessage({ tone: "success", text: "Released to billing." });
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Release failed" });
    } finally {
      setReleasing(false);
    }
  }

  // Ensure 12 diagnosis slots for display
  const dxSlots = useMemo(() => {
    const arr = [...(detail?.diagnoses ?? [])];
    while (arr.length < 12) arr.push("");
    return arr.slice(0, 12);
  }, [detail?.diagnoses]);

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <span className={styles.headerTitle}>Charge Capture</span>
        {loading ? <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>Loading…</span> : null}
        <div className={styles.headerSpacer} />
      </header>

      {message ? (
        <div
          role="status"
          style={{
            margin: "8px 16px 0", padding: "8px 12px", borderRadius: 6, fontSize: 13,
            background: message.tone === "success" ? "#ecfdf5" : "#fef2f2",
            color: message.tone === "success" ? "#065f46" : "#991b1b",
            border: `1px solid ${message.tone === "success" ? "#a7f3d0" : "#fecaca"}`,
          }}
        >
          {message.text}
        </div>
      ) : null}

      <div className={styles.splitBody}>
        {/* LEFT: workqueue */}
        <aside className={styles.leftPanel}>
          <div className={styles.leftToolbar}>
            <div className={styles.searchWrap} style={{ flex: 1 }}>
              <span className={styles.searchIcon}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              </span>
              <input
                className={styles.searchInput}
                style={{ width: "100%" }}
                placeholder="Search patient, CPT…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className={styles.leftFilters}>
            {(["all", "ready", "unsigned", "missing_dx", "hold", "released"] as FilterType[]).map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : STATUS_LABELS[f as ChargeStatus]}
                {f !== "all" ? ` (${counts[f as ChargeStatus]})` : ` (${counts.total})`}
              </button>
            ))}
          </div>

          <div className={styles.leftList}>
            {filtered.length === 0 ? (
              <div className={styles.emptyState}>No charges match.</div>
            ) : null}
            {filtered.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelectedId(row.id)}
                className={`${styles.leftItem} ${selectedId === row.id ? styles.leftItemActive : ""}`}
              >
                <div className={styles.leftItemTop}>
                  <span className={styles.patientName}>{row.patient}</span>
                  <span className={styles.chargeAmt}>{money(row.charge)}</span>
                </div>
                <div className={styles.leftItemMid}>
                  <span className={`${styles.status} ${STATUS_CLASS[row.status]}`}>{STATUS_LABELS[row.status]}</span>
                  <span style={{ fontSize: 11.5, color: "#64748B" }}>{row.dos}</span>
                </div>
                <div className={styles.leftItemBot}>
                  <span className={styles.cptCode}>{row.cpt}</span>
                  <span style={{ fontSize: 11.5, color: "#94A3B8", marginLeft: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.insurance}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* RIGHT: superbill form */}
        <section className={styles.rightPanel}>
          {!detail ? (
            <div className={styles.emptyState} style={{ padding: 60 }}>
              {detailLoading ? "Loading charge…" : "Select a charge on the left to view and edit."}
            </div>
          ) : (
            <>
              {/* Patient bar */}
              <div className={styles.patientBar}>
                <div className={styles.field}>
                  <label>Patient</label>
                  <input readOnly value={detail.patient ? `${detail.patient.lastName}, ${detail.patient.firstName}` : ""} />
                </div>
                <div className={styles.field}>
                  <label>DOB</label>
                  <input readOnly value={detail.patient?.dateOfBirth ?? ""} />
                </div>
                <div className={styles.field} style={{ maxWidth: 70 }}>
                  <label>Age</label>
                  <input readOnly value={ageFromDob(detail.patient?.dateOfBirth)} />
                </div>
                <div className={styles.field} style={{ maxWidth: 140 }}>
                  <label>Acct #</label>
                  <input readOnly value={detail.patient?.accountNumber ?? ""} />
                </div>
                <div className={styles.field}>
                  <label>Service Date</label>
                  <input
                    type="date"
                    value={detail.serviceDate ?? ""}
                    onChange={(e) => setDetail((p) => p ? { ...p, serviceDate: e.target.value || null } : p)}
                  />
                </div>
                <div className={styles.field} style={{ maxWidth: 180 }}>
                  <label>Status</label>
                  <input readOnly value={detail.status.replace(/_/g, " ")} />
                </div>
              </div>

              {/* Case + payer */}
              <div className={styles.sectionCard}>
                <div className={styles.sectionTitle}>Case Information</div>
                <div className={styles.row}>
                  <div className={styles.field} style={{ flex: 2 }}>
                    <label>Primary Payer</label>
                    <input readOnly value={detail.payer?.name ?? ""} />
                  </div>
                  <div className={styles.field}>
                    <label>Plan</label>
                    <input readOnly value={detail.policy?.planName ?? ""} />
                  </div>
                  <div className={styles.field}>
                    <label>Member ID</label>
                    <input readOnly value={detail.policy?.subscriberId ?? detail.policy?.policyNumber ?? ""} />
                  </div>
                  <div className={styles.field} style={{ maxWidth: 130 }}>
                    <label>Type</label>
                    <input readOnly value={detail.payer?.payerType ?? ""} />
                  </div>
                </div>
              </div>

              {/* Diagnoses */}
              <div className={styles.sectionCard}>
                <div className={styles.sectionTitle}>Diagnosis (ICD-10)</div>
                <div className={styles.dxGrid}>
                  {dxSlots.map((code, idx) => {
                    const upper = code.trim().toUpperCase();
                    const badEntry = upper.length > 0 ? invalidDx.get(upper) : undefined;
                    const bad = Boolean(badEntry);
                    const badTitle = badEntry && badEntry.status !== "active"
                      ? badEntry.reason
                      : "Code not found in ICD-10 reference";
                    const pickChild = (childCode: string) => {
                      updateDiagnosis(idx, childCode);
                      setInvalidDx((prev) => {
                        if (!prev.has(upper)) return prev;
                        const n = new Map(prev);
                        n.delete(upper);
                        return n;
                      });
                    };
                    return (
                      <div className={styles.dxCell} key={idx}>
                        <label>{`D${idx + 1}${idx === 0 ? "*" : ""}`}</label>
                        <CodeCombobox
                          kind="diagnosis"
                          value={code}
                          onChange={(next) => {
                            updateDiagnosis(idx, next);
                            if (invalidDx.size) {
                              setInvalidDx((prev) => {
                                const n = new Map(prev);
                                n.delete(upper);
                                return n;
                              });
                            }
                          }}
                          placeholder={idx === 0 ? "F41.1" : ""}
                          ariaLabel={`Diagnosis ${idx + 1}`}
                          invalid={bad}
                          invalidTitle={badTitle}
                        />
                        {badEntry && badEntry.status === "header" ? (
                          <HeaderChildSuggestions parent={upper} onPick={pickChild} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Service lines */}
              <div className={styles.sectionCard}>
                <div className={styles.sectionTitleRow}>
                  <span className={styles.sectionTitle}>Procedure Lines</span>
                  <button type="button" className={styles.smallBtn} onClick={addLine}>+ Add line</button>
                </div>
                <div className={styles.linesTableWrap}>
                  <table className={styles.linesTable}>
                    <thead>
                      <tr>
                        <th>Proc</th>
                        <th>DOS From</th>
                        <th>DOS To</th>
                        <th>DX Ptr</th>
                        <th>M1</th>
                        <th>M2</th>
                        <th>M3</th>
                        <th>M4</th>
                        <th>Units</th>
                        <th>UOM</th>
                        <th>Charge</th>
                        <th>Total</th>
                        <th>POS</th>
                        <th>Auth #</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.serviceLines.length === 0 ? (
                        <tr><td colSpan={15} style={{ textAlign: "center", color: "#94A3B8", padding: 24 }}>No procedure lines. Click &ldquo;Add line&rdquo;.</td></tr>
                      ) : null}
                      {detail.serviceLines.map((line, idx) => {
                        const lineTotal = (line.chargeAmount || 0) * (line.units || 0);
                        const mods = [0, 1, 2, 3].map((i) => line.modifiers[i] ?? "");
                        const procUpper = line.procedureCode.trim().toUpperCase();
                        const procBadEntry = procUpper.length > 0 ? invalidProc.get(procUpper) : undefined;
                        const procBadTitle = procBadEntry && procBadEntry.status !== "active"
                          ? procBadEntry.reason
                          : "Code not found in CPT/HCPCS reference";
                        return (
                          <tr key={idx}>
                            <td style={{ minWidth: 90 }}>
                              <CodeCombobox
                                kind="procedure"
                                value={line.procedureCode}
                                onChange={(next) => {
                                  updateLine(idx, { procedureCode: next });
                                  if (invalidProc.size) {
                                    setInvalidProc((prev) => {
                                      const n = new Map(prev);
                                      n.delete(procUpper);
                                      return n;
                                    });
                                  }
                                }}
                                className={styles.cellInput}
                                placeholder="90837"
                                ariaLabel={`Procedure code line ${idx + 1}`}
                                invalid={Boolean(procBadEntry)}
                                invalidTitle={procBadTitle}
                              />
                            </td>
                            <td><input className={styles.cellInput} type="date" value={line.serviceDateFrom ?? ""} onChange={(e) => updateLine(idx, { serviceDateFrom: e.target.value || null })} /></td>
                            <td><input className={styles.cellInput} type="date" value={line.serviceDateTo ?? ""} onChange={(e) => updateLine(idx, { serviceDateTo: e.target.value || null })} /></td>
                            <td>
                              <input
                                className={styles.cellInput}
                                style={{ width: 50 }}
                                value={line.diagnosisPointers.join(",")}
                                onChange={(e) => updateLine(idx, { diagnosisPointers: e.target.value.split(/[ ,]+/).map((s) => s.trim()).filter(Boolean) })}
                                placeholder="1"
                              />
                            </td>
                            {mods.map((m, mi) => (
                              <td key={mi}>
                                <input
                                  className={styles.cellInput}
                                  style={{ width: 50 }}
                                  value={m}
                                  maxLength={2}
                                  onChange={(e) => {
                                    const next = [...line.modifiers];
                                    while (next.length <= mi) next.push("");
                                    next[mi] = e.target.value.toUpperCase();
                                    while (next.length > 0 && !next[next.length - 1]) next.pop();
                                    updateLine(idx, { modifiers: next });
                                  }}
                                />
                              </td>
                            ))}
                            <td>
                              <input className={styles.cellInput} style={{ width: 50 }} type="number" min={1} value={line.units}
                                onChange={(e) => updateLine(idx, { units: Number(e.target.value) || 1 })} />
                            </td>
                            <td>
                              <select className={styles.cellInput} style={{ width: 60 }} value={line.unitOfMeasure}
                                onChange={(e) => updateLine(idx, { unitOfMeasure: e.target.value })}>
                                <option value="UN">UN</option>
                                <option value="MJ">MJ</option>
                                <option value="ML">ML</option>
                              </select>
                            </td>
                            <td>
                              <input className={styles.cellInput} style={{ width: 78, textAlign: "right" }} type="number" step="0.01" min={0}
                                value={line.chargeAmount}
                                onChange={(e) => updateLine(idx, { chargeAmount: Number(e.target.value) || 0 })} />
                            </td>
                            <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{money(lineTotal)}</td>
                            <td>
                              <select className={styles.cellInput} style={{ width: 70 }} value={line.placeOfService ?? ""}
                                onChange={(e) => updateLine(idx, { placeOfService: e.target.value || null })}>
                                <option value="">—</option>
                                {POS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                              </select>
                            </td>
                            <td>
                              <input className={styles.cellInput} style={{ width: 110 }} value={line.authorizationNumber ?? ""}
                                onChange={(e) => updateLine(idx, { authorizationNumber: e.target.value || null })} />
                            </td>
                            <td>
                              <button type="button" className={styles.iconBtn} onClick={() => removeLine(idx)} title="Remove line">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={11} style={{ textAlign: "right", fontWeight: 600, padding: "8px 12px" }}>Total</td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, padding: "8px 12px" }}>{money(detail.totalCharge)}</td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Additional info + payments */}
              <div className={styles.twoCol}>
                <div className={styles.sectionCard} style={{ flex: 2 }}>
                  <div className={styles.sectionTitle}>Additional Information</div>
                  <div className={styles.row}>
                    <div className={styles.field}>
                      <label>Rendering Provider</label>
                      <input readOnly value={detail.provider ? `${detail.provider.displayName}${detail.provider.credential ? `, ${detail.provider.credential}` : ""}` : ""} />
                    </div>
                    <div className={styles.field} style={{ maxWidth: 150 }}>
                      <label>NPI</label>
                      <input readOnly value={detail.provider?.npi ?? ""} />
                    </div>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.field}>
                      <label>Place of Service (default)</label>
                      <select
                        value={detail.placeOfService ?? ""}
                        onChange={(e) => setDetail((p) => p ? { ...p, placeOfService: e.target.value || null } : p)}
                      >
                        <option value="">—</option>
                        {POS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                <div className={styles.sectionCard} style={{ flex: 1, minWidth: 260 }}>
                  <div className={styles.sectionTitle}>Patient Payments</div>
                  <div className={styles.row}>
                    <div className={styles.field}>
                      <label>Co-Pay</label>
                      <input readOnly value={detail.policy ? money(detail.policy.copay) : "$0.00"} />
                    </div>
                    <div className={styles.field}>
                      <label>Deductible</label>
                      <input readOnly value={detail.policy ? money(detail.policy.deductible) : "$0.00"} />
                    </div>
                    <div className={styles.field}>
                      <label>Co-Ins %</label>
                      <input readOnly value={detail.policy ? `${detail.policy.coinsurancePercent}%` : "0%"} />
                    </div>
                  </div>
                </div>
              </div>

              {detail.blockerReasons.length > 0 ? (
                <div className={styles.sectionCard} style={{ borderColor: "#fecaca", background: "#fef2f2" }}>
                  <div className={styles.sectionTitle} style={{ color: "#991b1b" }}>Blockers</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#991b1b" }}>
                    {detail.blockerReasons.map((b, i) => <li key={i}>{typeof b === "string" ? b : JSON.stringify(b)}</li>)}
                  </ul>
                </div>
              ) : null}

              {/* Action bar */}
              <div className={styles.actionBar}>
                <span style={{ fontSize: 12, color: "#64748B" }}>* required field</span>
                <div style={{ flex: 1 }} />
                <button type="button" className={styles.secondaryBtn} onClick={() => setReloadKey((k) => k + 1)} disabled={detailLoading}>
                  Refresh
                </button>
                <button type="button" className={styles.secondaryBtn} disabled>
                  Print Superbill
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={saveCharge}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className={styles.releaseBtn}
                  onClick={releaseCharge}
                  disabled={releasing || detail.status !== "ready_for_claim"}
                  title={detail.status !== "ready_for_claim" ? "Charge must be Ready before release" : ""}
                >
                  {releasing ? "Releasing…" : "Release to Billing"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
