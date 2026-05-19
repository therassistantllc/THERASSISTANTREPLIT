"use client";

import { useState, useMemo, useRef } from "react";

export type Diagnosis = {
  id: string;
  diagnosis_code: string;
  diagnosis_description: string;
  is_primary: boolean;
};

type Props = {
  diagnoses: Diagnosis[];
  onChange: (updated: Diagnosis[]) => void;
  disabled?: boolean;
};

// Common ICD-10 diagnoses for quick reference (behavioral health focus)
const COMMON_DIAGNOSES = [
  { code: "F32.9", description: "Major depressive disorder, single episode, unspecified" },
  { code: "F41.1", description: "Generalized anxiety disorder" },
  { code: "F41.9", description: "Anxiety disorder, unspecified" },
  { code: "F60.3", description: "Borderline personality disorder" },
  { code: "F91.9", description: "Conduct disorder, unspecified" },
  { code: "F93.0", description: "Separation anxiety disorder of childhood" },
  { code: "F99", description: "Mental disorder, not otherwise specified" },
  { code: "Z71.9", description: "Counseling, unspecified" },
  { code: "Z81.8", description: "Family history of other mental and behavioral disorders" },
  { code: "Z56.9", description: "Problems related to employment, unspecified" },
];

export default function DiagnosisPicker({ diagnoses, onChange, disabled = false }: Props) {
  const idCounter = useRef(0);
  const [searchText, setSearchText] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const filteredSuggestions = useMemo(() => {
    if (!searchText.trim()) return [];
    const lower = searchText.toLowerCase();
    return COMMON_DIAGNOSES.filter(
      (d) =>
        (d.code.toLowerCase().includes(lower) || d.description.toLowerCase().includes(lower)) &&
        !diagnoses.some((existing) => existing.diagnosis_code === d.code)
    ).slice(0, 5);
  }, [searchText, diagnoses]);

  function addDiagnosis(code: string, description: string) {
    if (!code.trim()) return;
    if (diagnoses.some((d) => d.diagnosis_code === code)) return;

    const newDiagnosis: Diagnosis = {
      id: `diag-${++idCounter.current}`,
      diagnosis_code: code.trim().toUpperCase(),
      diagnosis_description: description.trim() || code.trim(),
      is_primary: diagnoses.length === 0,
    };

    onChange([...diagnoses, newDiagnosis]);
    setNewCode("");
    setNewDesc("");
    setSearchText("");
    setShowSuggestions(false);
  }

  function removeDiagnosis(id: string) {
    const updated = diagnoses.filter((d) => d.id !== id);
    // Re-mark first as primary if the removed diagnosis was primary
    if (diagnoses.find((d) => d.id === id)?.is_primary && updated.length > 0) {
      updated[0].is_primary = true;
    }
    onChange(updated);
  }

  function setPrimary(id: string) {
    const updated = diagnoses.map((d) => ({ ...d, is_primary: d.id === id }));
    onChange(updated);
  }

  return (
    <article className="panel">
      <h2>Diagnoses</h2>
      <p className="muted">Add ICD-10 codes. Mark one as primary.</p>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          <strong>Search or Add Diagnosis</strong>
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
                  addDiagnosis(suggestion.code, suggestion.description);
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: "0.5rem", alignItems: "flex-end" }}>
          <input
            type="text"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder="Code (e.g., F32.9)"
            disabled={disabled}
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            disabled={disabled}
          />
          <button
            type="button"
            className="button"
            onClick={() => addDiagnosis(newCode, newDesc)}
            disabled={disabled || !newCode.trim()}
          >
            Add
          </button>
        </div>
      </div>

      {diagnoses.length === 0 ? (
        <p className="muted">No diagnoses added yet.</p>
      ) : (
        <div className="stack-list">
          {diagnoses.map((diagnosis) => (
            <div key={diagnosis.id} className="stack-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <strong>{diagnosis.diagnosis_code}</strong>
                <span>{diagnosis.diagnosis_description}</span>
                {diagnosis.is_primary && <span className="status status-green">Primary</span>}
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {!diagnosis.is_primary && (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setPrimary(diagnosis.id)}
                    disabled={disabled}
                  >
                    Make Primary
                  </button>
                )}
                <button
                  type="button"
                  className="button button-small button-danger"
                  onClick={() => removeDiagnosis(diagnosis.id)}
                  disabled={disabled}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <style jsx>{`
        input[type="text"] {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid var(--line);
          border-radius: 4px;
        }

        input[type="text"]:disabled {
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
      `}</style>
    </article>
  );
}
