"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CodeOption = {
  code: string;
  description: string;
  code_system?: string;
  is_active?: boolean;
  expiration_date?: string | null;
};

export type CodeValidation =
  | { status: "active"; option: CodeOption }
  | { status: "header"; option: CodeOption; reason: string }
  | { status: "retired"; option: CodeOption; expirationDate: string | null; reason: string }
  | { status: "unknown"; reason: string };

type Props = {
  kind: "diagnosis" | "procedure";
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  invalid?: boolean;
  invalidTitle?: string;
};

const ENDPOINT: Record<Props["kind"], string> = {
  diagnosis: "/api/billing/codes/diagnoses",
  procedure: "/api/billing/codes/procedures",
};

// Per-kind in-memory cache of validation results (this session only).
const validationCache: Record<Props["kind"], Map<string, CodeValidation>> = {
  diagnosis: new Map(),
  procedure: new Map(),
};

function classifyOption(kind: Props["kind"], opt: CodeOption): CodeValidation {
  if (opt.is_active !== false) return { status: "active", option: opt };
  // Retired if we have an expiration date.
  if (opt.expiration_date) {
    return {
      status: "retired",
      option: opt,
      expirationDate: opt.expiration_date,
      reason: `${opt.code} was retired on ${opt.expiration_date}`,
    };
  }
  // No expiration date + inactive → ICD-10 header / non-billable parent.
  if (kind === "diagnosis") {
    return {
      status: "header",
      option: opt,
      reason: `${opt.code} is a header — pick a more specific child code`,
    };
  }
  // Procedure with no expiration date but inactive — treat as non-billable.
  return {
    status: "header",
    option: opt,
    reason: `${opt.code} is not billable`,
  };
}

export function describeValidation(v: CodeValidation): string {
  if (v.status === "active") return "";
  return v.reason;
}

// Per-kind cache of child-code lookups (this session only).
const childrenCache: Record<Props["kind"], Map<string, CodeOption[]>> = {
  diagnosis: new Map(),
  procedure: new Map(),
};

// Look up the billable descendants of an ICD-10 header (e.g. F32 → F32.0,
// F32.1, F32.9…). Only meaningful for kind="diagnosis"; returns [] otherwise.
export async function fetchChildCodes(
  kind: Props["kind"],
  parent: string,
  limit = 12,
): Promise<CodeOption[]> {
  if (kind !== "diagnosis") return [];
  const upper = parent.trim().toUpperCase();
  if (!upper) return [];
  const cached = childrenCache[kind].get(upper);
  if (cached) return cached;
  try {
    const res = await fetch(
      `${ENDPOINT[kind]}?parent=${encodeURIComponent(upper)}&limit=${limit}`,
      { cache: "no-store" },
    );
    const json = await res.json();
    const items: CodeOption[] = (json?.items ?? []).filter(
      (it: CodeOption) => it.is_active !== false,
    );
    childrenCache[kind].set(upper, items);
    return items;
  } catch {
    return [];
  }
}

export async function validateCode(
  kind: Props["kind"],
  code: string,
): Promise<CodeValidation> {
  const upper = code.trim().toUpperCase();
  if (!upper) return { status: "unknown", reason: "Empty code" };
  const cached = validationCache[kind].get(upper);
  if (cached) return cached;
  try {
    const res = await fetch(
      `${ENDPOINT[kind]}?q=${encodeURIComponent(upper)}&limit=10&includeInactive=1`,
      { cache: "no-store" },
    );
    const json = await res.json();
    const items: CodeOption[] = json?.items ?? [];
    const match = items.find((it) => it.code.toUpperCase() === upper);
    let result: CodeValidation;
    if (!match) {
      result = { status: "unknown", reason: `${upper} not found in ${kind === "diagnosis" ? "ICD-10" : "CPT/HCPCS"} reference` };
    } else {
      result = classifyOption(kind, match);
    }
    validationCache[kind].set(upper, result);
    return result;
  } catch {
    return { status: "unknown", reason: "Lookup failed" };
  }
}

export default function CodeCombobox({
  kind,
  value,
  onChange,
  placeholder,
  className,
  style,
  ariaLabel,
  invalid,
  invalidTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [options, setOptions] = useState<CodeOption[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolvedDescription, setResolvedDescription] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);

  // Sync external value updates (e.g. reload from server) into local input.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Resolve description for the current value so preloaded codes show context
  // (the canonical code stays in the input; description renders alongside).
  useEffect(() => {
    const upper = value.trim().toUpperCase();
    if (!upper) {
      setResolvedDescription(null);
      return;
    }
    let cancelled = false;
    void validateCode(kind, upper).then((v) => {
      if (cancelled) return;
      if (v.status === "unknown") {
        setResolvedDescription(null);
      } else {
        setResolvedDescription(v.option.description);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [value, kind]);

  // Click-outside closes dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const id = ++reqIdRef.current;
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `${ENDPOINT[kind]}?q=${encodeURIComponent(q)}&limit=20&includeInactive=1`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (id !== reqIdRef.current) return;
        const items: CodeOption[] = json?.items ?? [];
        setOptions(items);
        setHighlight(0);
        // Warm validation cache from search results so onBlur is fast.
        for (const it of items) {
          validationCache[kind].set(it.code.toUpperCase(), classifyOption(kind, it));
        }
      } catch {
        if (id === reqIdRef.current) setOptions([]);
      } finally {
        if (id === reqIdRef.current) setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, open, kind]);

  const commitSelection = useCallback(
    (opt: CodeOption) => {
      const upper = opt.code.toUpperCase();
      validationCache[kind].set(upper, classifyOption(kind, opt));
      setQuery(upper);
      onChange(upper);
      setOpen(false);
    },
    [kind, onChange],
  );

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(options.length - 1, h + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setHighlight((h) => Math.max(0, h - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (open && options[highlight]) {
        commitSelection(options[highlight]);
        e.preventDefault();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Tab") {
      const upper = query.trim().toUpperCase();
      const exact = options.find((o) => o.code.toUpperCase() === upper);
      if (exact) commitSelection(exact);
    }
  };

  const borderColor = invalid ? "#DC2626" : undefined;
  const computedStyle = useMemo<React.CSSProperties>(
    () => ({
      ...(style ?? {}),
      ...(borderColor ? { borderColor, boxShadow: "0 0 0 1px rgba(220,38,38,0.18)" } : {}),
    }),
    [style, borderColor],
  );

  const hintText = !open && resolvedDescription && value.trim() ? resolvedDescription : null;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <input
        ref={inputRef}
        className={className}
        style={computedStyle}
        value={query}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        title={hintText ? `${value.trim().toUpperCase()} — ${hintText}` : invalid ? invalidTitle : undefined}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          const next = e.target.value.toUpperCase();
          setQuery(next);
          onChange(next);
          if (!open) setOpen(true);
        }}
        onKeyDown={handleKey}
      />
      {hintText ? (
        <div
          style={{
            marginTop: 2,
            fontSize: 10.5,
            color: "#64748B",
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={hintText}
        >
          {hintText}
        </div>
      ) : null}
      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            minWidth: 260,
            maxHeight: 240,
            overflowY: "auto",
            background: "#fff",
            border: "1px solid #CBD5E1",
            borderRadius: 6,
            boxShadow: "0 6px 18px rgba(15,23,42,0.12)",
            zIndex: 30,
            fontSize: 12.5,
          }}
        >
          {loading ? (
            <div style={{ padding: "8px 10px", color: "#64748B" }}>Searching…</div>
          ) : options.length === 0 ? (
            <div style={{ padding: "8px 10px", color: "#64748B" }}>
              {query.trim() ? "No matches" : "Type to search…"}
            </div>
          ) : (
            options.map((opt, i) => {
              const classification = classifyOption(kind, opt);
              const inactive = classification.status !== "active";
              const reason = classification.status === "active" ? null : classification.reason;
              return (
                <div
                  key={`${opt.code_system ?? ""}:${opt.code}`}
                  role="option"
                  aria-selected={i === highlight}
                  aria-disabled={inactive ? true : undefined}
                  title={reason ?? undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSelection(opt);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  style={{
                    padding: "6px 10px",
                    cursor: "pointer",
                    background: i === highlight ? "#EFF6FF" : "transparent",
                    borderBottom: "1px solid #F1F5F9",
                    display: "flex",
                    gap: 10,
                    alignItems: "baseline",
                    opacity: inactive ? 0.55 : 1,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontWeight: 600,
                      color: inactive ? "#64748B" : "#0F172A",
                      minWidth: 64,
                      textDecoration: inactive ? "line-through" : undefined,
                    }}
                  >
                    {opt.code}
                  </span>
                  <span style={{ color: "#475569", flex: 1 }}>
                    {opt.description}
                    {reason ? (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10.5,
                          color: "#B45309",
                          fontStyle: "italic",
                        }}
                      >
                        ({classification.status === "retired"
                          ? `retired ${classification.expirationDate ?? ""}`.trim()
                          : classification.status === "header"
                            ? (kind === "diagnosis" ? "header — not billable" : "not billable")
                            : ""})
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
