"use client";

import { useState } from "react";

export type SignNoteModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  currentUser?: { name: string; role: string } | null;
  isLoading?: boolean;
};

export default function SignNoteModal({ isOpen, onClose, onConfirm, currentUser, isLoading = false }: SignNoteModalProps) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSign() {
    setError(null);
    try {
      await onConfirm();
      setAgreed(false);
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Failed to sign note");
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Sign Clinical Note</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          <section className="sign-section">
            <h3>Attestation</h3>
            <p>
              By signing this clinical note, you certify that you have personally provided or directly supervised the care documented above,
              and that the information is accurate to the best of your knowledge.
            </p>
          </section>

          <section className="sign-section">
            <h3>Signer Information</h3>
            <div className="signer-info">
              <p>
                <strong>Name:</strong> {currentUser?.name || "Current User"}
              </p>
              <p>
                <strong>Role:</strong> {currentUser?.role || "Healthcare Provider"}
              </p>
              <p>
                <strong>Time:</strong> {new Date().toLocaleString()}
              </p>
            </div>
          </section>

          <section className="sign-section">
            <label className="sign-checkbox">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                disabled={isLoading}
              />
              <span>
                I certify that I have reviewed this note and that the clinical information documented is accurate and complete.
              </span>
            </label>
          </section>

          {error && <div className="sign-error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={handleSign}
            disabled={!agreed || isLoading}
          >
            {isLoading ? "Signing…" : "Sign Note"}
          </button>
        </div>
      </div>

      <style jsx>{`
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-content {
          background-color: white;
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
          max-width: 600px;
          width: 90%;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
        }

        .modal-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--line);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .modal-header h2 {
          margin: 0;
          font-size: 1.25rem;
          color: var(--navy);
        }

        .modal-close {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: var(--muted);
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          transition: background-color 0.2s;
        }

        .modal-close:hover:not(:disabled) {
          background-color: var(--bg-muted);
        }

        .modal-close:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        .modal-body {
          padding: 1.5rem;
          overflow-y: auto;
          flex: 1;
        }

        .sign-section {
          margin-bottom: 1.5rem;
        }

        .sign-section h3 {
          margin: 0 0 0.5rem 0;
          font-size: 0.95rem;
          color: var(--navy);
          font-weight: 600;
        }

        .sign-section p {
          margin: 0;
          font-size: 0.9rem;
          line-height: 1.5;
          color: var(--text);
        }

        .signer-info {
          background-color: var(--bg-muted);
          padding: 0.75rem;
          border-radius: 4px;
          border-left: 3px solid var(--sage);
        }

        .signer-info p {
          margin: 0.25rem 0;
          font-size: 0.875rem;
        }

        .sign-checkbox {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          cursor: pointer;
          font-size: 0.9rem;
          line-height: 1.5;
        }

        .sign-checkbox input[type="checkbox"] {
          margin-top: 2px;
          cursor: pointer;
          accent-color: var(--sage);
        }

        .sign-error {
          background-color: #f8d7da;
          border: 1px solid #f5c6cb;
          color: #721c24;
          padding: 0.75rem;
          border-radius: 4px;
          font-size: 0.875rem;
          margin-bottom: 1rem;
        }

        .modal-footer {
          padding: 1.5rem;
          border-top: 1px solid var(--line);
          display: flex;
          gap: 0.75rem;
          justify-content: flex-end;
        }

        .button {
          padding: 0.75rem 1.5rem;
          border-radius: 4px;
          border: none;
          cursor: pointer;
          font-weight: 500;
          font-size: 0.9rem;
          transition: opacity 0.2s;
        }

        .button:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}
