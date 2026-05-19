"use client";

import { useState, useMemo, useRef } from "react";

export type ServiceLine = {
  id: string;
  service_date: string;
  cpt_hcpcs_code: string;
  modifier_1: string;
  modifier_2: string;
  modifier_3: string;
  modifier_4: string;
  units: number;
  charge_amount: number;
  place_of_service_code: string;
};

type Props = {
  serviceLines: ServiceLine[];
  onChange: (updated: ServiceLine[]) => void;
  disabled?: boolean;
  serviceDate?: string;
};

// Common CPT codes for behavioral health
const COMMON_CPT_CODES = [
  { code: "90834", description: "Psychotherapy, 45 minutes" },
  { code: "90837", description: "Psychotherapy, 60 minutes" },
  { code: "90847", description: "Family psychotherapy (conjoint with patient), 50 minutes" },
  { code: "90899", description: "Unlisted psychiatric service or procedure" },
  { code: "99213", description: "Office visit, established patient, 20-29 min" },
  { code: "99214", description: "Office visit, established patient, 30-39 min" },
  { code: "90833", description: "Psychotherapy, 30 minutes" },
  { code: "99203", description: "Office visit, new patient, 30-39 min" },
  { code: "99204", description: "Office visit, new patient, 40-54 min" },
  { code: "96160", description: "Psychological testing evaluation service" },
];

const PLACE_OF_SERVICE_OPTIONS = [
  { code: "10", name: "Office" },
  { code: "02", name: "Telehealth" },
  { code: "21", name: "Inpatient Hospital" },
  { code: "22", name: "Outpatient Hospital" },
  { code: "23", name: "Emergency Dept" },
  { code: "11", name: "Patient Home" },
  { code: "31", name: "Skilled Nursing Facility" },
];

export default function CptCodePanel({ serviceLines, onChange, disabled = false, serviceDate = "" }: Props) {
  const idCounter = useRef(0);
  const [searchText, setSearchText] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [newCode, setNewCode] = useState("");

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultDate = serviceDate || today;

  const filteredSuggestions = useMemo(() => {
    if (!searchText.trim()) return [];
    const lower = searchText.toLowerCase();
    return COMMON_CPT_CODES.filter(
      (c) =>
        (c.code.includes(lower) || c.description.toLowerCase().includes(lower)) &&
        !serviceLines.some((existing) => existing.cpt_hcpcs_code === c.code)
    ).slice(0, 5);
  }, [searchText, serviceLines]);

  function addServiceLine(code: string) {
    if (!code.trim()) return;
    if (serviceLines.some((s) => s.cpt_hcpcs_code === code)) return;

    const newLine: ServiceLine = {
      id: `service-${++idCounter.current}`,
      service_date: defaultDate,
      cpt_hcpcs_code: code.trim().toUpperCase(),
      modifier_1: "",
      modifier_2: "",
      modifier_3: "",
      modifier_4: "",
      units: 1,
      charge_amount: 0,
      place_of_service_code: "10",
    };

    onChange([...serviceLines, newLine]);
    setNewCode("");
    setSearchText("");
    setShowSuggestions(false);
  }

  function updateServiceLine(id: string, patch: Partial<ServiceLine>) {
    onChange(
      serviceLines.map((line) => (line.id === id ? { ...line, ...patch } : line))
    );
  }

  function removeServiceLine(id: string) {
    onChange(serviceLines.filter((s) => s.id !== id));
  }

  return (
    <article className="panel">
      <h2>Service Lines (CPT/HCPCS)</h2>
      <p className="muted">Add procedure codes. Modifiers and units are optional.</p>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          <strong>Search or Add Code</strong>
        </label>
        <input
          type="text"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Type code or description..."
          disabled={disabled}
          style={{ marginBottom: "0.5rem" }}
        />

        {showSuggestions && filteredSuggestions.length > 0 && (
          <div style={{ backgroundColor: "var(--bg-muted)", borderRadius: "4px", padding: "0.5rem", marginBottom: "0.5rem" }}>
            {filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion.code}
                type="button"
                className="button button-small"
                onClick={() => {
                  addServiceLine(suggestion.code);
                  setShowSuggestions(false);
                }}
                disabled={disabled}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: "0.25rem",
                  fontSize: "0.875rem",
                }}
              >
                <strong>{suggestion.code}</strong> — {suggestion.description}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.5rem", alignItems: "flex-end" }}>
          <input
            type="text"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder="CPT/HCPCS code (e.g., 90837)"
            disabled={disabled}
          />
          <button
            type="button"
            className="button"
            onClick={() => addServiceLine(newCode)}
            disabled={disabled || !newCode.trim()}
          >
            Add
          </button>
        </div>
      </div>

      {serviceLines.length === 0 ? (
        <p className="muted">No service lines added yet.</p>
      ) : (
        <div className="service-lines-list">
          {serviceLines.map((line) => (
            <div key={line.id} className="service-line-row" style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid var(--line)" }}>
              <div style={{ marginBottom: "0.75rem" }}>
                <strong>{line.cpt_hcpcs_code}</strong>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <div>
                  <label style={{ fontSize: "0.875rem", display: "block", marginBottom: "0.25rem" }}>Service Date</label>
                  <input
                    type="date"
                    value={line.service_date}
                    onChange={(e) => updateServiceLine(line.id, { service_date: e.target.value })}
                    disabled={disabled}
                  />
                </div>

                <div>
                  <label style={{ fontSize: "0.875rem", display: "block", marginBottom: "0.25rem" }}>Units</label>
                  <input
                    type="number"
                    value={line.units}
                    onChange={(e) => updateServiceLine(line.id, { units: Math.max(1, parseInt(e.target.value) || 1) })}
                    disabled={disabled}
                    min="1"
                  />
                </div>

                <div>
                  <label style={{ fontSize: "0.875rem", display: "block", marginBottom: "0.25rem" }}>Charge Amount ($)</label>
                  <input
                    type="number"
                    value={line.charge_amount}
                    onChange={(e) => updateServiceLine(line.id, { charge_amount: Math.max(0, parseFloat(e.target.value) || 0) })}
                    disabled={disabled}
                    min="0"
                    step="0.01"
                  />
                </div>

                <div>
                  <label style={{ fontSize: "0.875rem", display: "block", marginBottom: "0.25rem" }}>Place of Service</label>
                  <select
                    value={line.place_of_service_code}
                    onChange={(e) => updateServiceLine(line.id, { place_of_service_code: e.target.value })}
                    disabled={disabled}
                  >
                    {PLACE_OF_SERVICE_OPTIONS.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.code} - {option.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem", marginBottom: "0.75rem" }}>
                {[1, 2, 3, 4].map((modNum) => (
                  <div key={modNum}>
                    <label style={{ fontSize: "0.875rem", display: "block", marginBottom: "0.25rem" }}>Mod {modNum}</label>
                    <input
                      type="text"
                      value={line[`modifier_${modNum}` as keyof ServiceLine] || ""}
                      onChange={(e) => updateServiceLine(line.id, { [`modifier_${modNum}`]: e.target.value } as Partial<ServiceLine>)}
                      placeholder={`Mod ${modNum}`}
                      disabled={disabled}
                      maxLength={2}
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="button button-small button-danger"
                onClick={() => removeServiceLine(line.id)}
                disabled={disabled}
              >
                Remove Service Line
              </button>
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        input[type="text"],
        input[type="date"],
        input[type="number"],
        select {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid var(--line);
          border-radius: 4px;
          font-size: 0.9rem;
        }

        input:disabled,
        select:disabled {
          background-color: var(--bg-muted);
          color: var(--muted);
          cursor: not-allowed;
        }

        .button-danger {
          background-color: var(--danger);
          color: white;
        }

        .button-danger:hover:not(:disabled) {
          opacity: 0.9;
        }

        .service-line-row {
          background-color: var(--bg-muted);
          padding: 0.75rem;
          border-radius: 4px;
        }
      `}</style>
    </article>
  );
}
