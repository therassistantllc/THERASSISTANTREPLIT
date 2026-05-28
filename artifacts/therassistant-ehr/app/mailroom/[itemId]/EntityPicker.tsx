"use client";

import { useEffect, useId, useRef, useState } from "react";

export type EntityType = "client" | "claim" | "encounter";

export type EntityResult = {
  id: string;
  label: string;
  sublabel: string;
};

type EntityPickerProps = {
  entityType: EntityType;
  organizationId: string;
  value: EntityResult | null;
  onChange: (value: EntityResult | null) => void;
  placeholder?: string;
  disabled?: boolean;
};

const TYPE_LABELS: Record<EntityType, string> = {
  client: "Search clients by name…",
  claim: "Search claims by number or account…",
  encounter: "Search encounters by client name…",
};

export default function EntityPicker({ entityType, organizationId, value, onChange, placeholder, disabled }: EntityPickerProps) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntityResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeq = useRef(0);

  // Reset internal state when the picker switches between entity types.
  useEffect(() => {
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
    setError(null);
  }, [entityType]);

  // Debounced search.
  useEffect(() => {
    if (value) return; // Don't search while a chip is shown.
    if (!open) return;
    const handle = setTimeout(async () => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          organizationId,
          type: entityType,
          q: query.trim(),
          limit: "10",
        });
        const response = await fetch(`/api/mailroom/search?${params.toString()}`);
        const json = (await response.json()) as { success?: boolean; results?: EntityResult[]; error?: string };
        if (seq !== requestSeq.current) return;
        if (!response.ok || !json.success) {
          setResults([]);
          setError(json.error || "Search failed");
        } else {
          setResults(json.results ?? []);
          setActiveIndex((json.results ?? []).length ? 0 : -1);
        }
      } catch (caughtError) {
        if (seq !== requestSeq.current) return;
        setResults([]);
        setError(caughtError instanceof Error ? caughtError.message : "Search failed");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, entityType, organizationId, open, value]);

  // Close the dropdown on outside clicks.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function selectResult(result: EntityResult) {
    onChange(result);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  function clearSelection() {
    onChange(null);
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (results.length ? (prev + 1) % results.length : -1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (results.length ? (prev - 1 + results.length) % results.length : -1));
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        selectResult(results[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="entity-picker entity-picker-chip" ref={containerRef}>
        <div className="entity-chip">
          <div className="entity-chip-text">
            <strong>{value.label}</strong>
            {value.sublabel ? <span>{value.sublabel}</span> : null}
          </div>
          <button type="button" className="button button-tertiary" onClick={clearSelection} disabled={disabled}>
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="entity-picker" ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 && results[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder || TYPE_LABELS[entityType]}
        disabled={disabled}
        autoComplete="off"
      />
      {open ? (
        <ul id={listboxId} role="listbox" className="entity-picker-listbox">
          {loading ? <li className="entity-picker-empty">Searching…</li> : null}
          {!loading && error ? <li className="entity-picker-empty entity-picker-error">{error}</li> : null}
          {!loading && !error && results.length === 0 ? (
            <li className="entity-picker-empty">No matches</li>
          ) : null}
          {!loading && !error
            ? results.map((result, index) => (
                <li
                  key={result.id}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`entity-picker-option${index === activeIndex ? " is-active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectResult(result);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <div className="entity-picker-option-label">{result.label}</div>
                  {result.sublabel ? <div className="entity-picker-option-sublabel">{result.sublabel}</div> : null}
                </li>
              ))
            : null}
        </ul>
      ) : null}
    </div>
  );
}
