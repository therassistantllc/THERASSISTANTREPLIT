"use client";

import { useEffect, useState } from "react";
import styles from "./clientImportDialog.module.css";

type Props = {
  open: boolean;
  organizationId: string;
  onClose: () => void;
  onCreated: () => void;
};

type CreateResponse = {
  success: boolean;
  error?: string;
};

export default function AddClientDialog({ open, organizationId, onClose, onCreated }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFirstName("");
      setLastName("");
      setDateOfBirth("");
      setPhone("");
      setEmail("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const canSubmit =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    dateOfBirth.trim().length > 0 &&
    phone.trim().length > 0 &&
    !busy;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          dateOfBirth: dateOfBirth.trim(),
          phone: phone.trim(),
          email: email.trim() || undefined,
        }),
      });
      const json = (await res.json()) as CreateResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to create client");
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create client");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Add new client"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form className={styles.modal} onSubmit={handleSubmit} style={{ width: "min(560px, 100%)" }}>
        <header className={styles.header}>
          <h2 className={styles.title}>Add new client</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.stage}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                  First name <span style={{ color: "#B91C1C" }}>*</span>
                </span>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  autoFocus
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                  Last name <span style={{ color: "#B91C1C" }}>*</span>
                </span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                  Date of birth <span style={{ color: "#B91C1C" }}>*</span>
                </span>
                <input
                  type="date"
                  value={dateOfBirth}
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  required
                  max={new Date().toISOString().slice(0, 10)}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                  Primary phone <span style={{ color: "#B91C1C" }}>*</span>
                </span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  style={inputStyle}
                />
              </label>
              <label style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                />
              </label>
            </div>
          </div>
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={!canSubmit}
          >
            {busy ? "Saving…" : "Save client"}
          </button>
        </footer>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 36,
  border: "1px solid #CBD5E1",
  borderRadius: 6,
  padding: "0 10px",
  fontSize: 13,
  color: "#0F172A",
  background: "#ffffff",
  outline: "none",
};
