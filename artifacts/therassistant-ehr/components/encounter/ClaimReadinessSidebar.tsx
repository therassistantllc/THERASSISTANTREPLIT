"use client";

export type ClaimReadinessCheck = {
  label: string;
  isComplete: boolean;
  required: boolean;
};

type Props = {
  checks: ClaimReadinessCheck[];
};

export default function ClaimReadinessSidebar({ checks }: Props) {
  const completedCount = checks.filter((c) => c.isComplete).length;
  const requiredCount = checks.filter((c) => c.required).length;
  const allRequiredComplete = checks.filter((c) => c.required).every((c) => c.isComplete);

  return (
    <aside className="claim-readiness-sidebar">
      <h3>Charge Capture Readiness</h3>

      <div className="readiness-summary">
        <p className="readiness-status">
          {completedCount} / {requiredCount} required
        </p>
        <div className={`readiness-badge ${allRequiredComplete ? "ready" : "incomplete"}`}>
          {allRequiredComplete ? "✓ Ready" : "Incomplete"}
        </div>
      </div>

      <div className="readiness-checklist">
        {checks.map((check, index) => (
          <div key={index} className={`readiness-item ${check.isComplete ? "complete" : ""} ${check.required ? "required" : "optional"}`}>
            <div className="readiness-checkbox">
              <input
                type="checkbox"
                checked={check.isComplete}
                readOnly
                aria-label={check.label}
              />
            </div>
            <label className="readiness-label">
              <span>{check.label}</span>
              {check.required && <span className="required-badge">Required</span>}
            </label>
          </div>
        ))}
      </div>

      <p className="readiness-note">
        Once all required fields are complete, you can sign and submit the claim.
      </p>

      <style jsx>{`
        .claim-readiness-sidebar {
          background-color: var(--bg-muted);
          border-left: 4px solid var(--sage);
          padding: 1rem;
          border-radius: 4px;
        }

        .claim-readiness-sidebar h3 {
          margin: 0 0 1rem 0;
          font-size: 1rem;
          color: var(--navy);
        }

        .readiness-summary {
          margin-bottom: 1rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid var(--line);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .readiness-status {
          margin: 0;
          font-size: 0.875rem;
          color: var(--muted);
        }

        .readiness-badge {
          padding: 0.25rem 0.75rem;
          border-radius: 16px;
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          background-color: #fef3cd;
          color: #856404;
        }

        .readiness-badge.ready {
          background-color: var(--success);
          color: white;
        }

        .readiness-checklist {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          margin-bottom: 1rem;
        }

        .readiness-item {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.5rem;
          border-radius: 4px;
          transition: background-color 0.2s;
        }

        .readiness-item.complete {
          background-color: rgba(76, 175, 80, 0.1);
        }

        .readiness-item.required {
          border-left: 2px solid var(--danger);
          padding-left: 0.75rem;
        }

        .readiness-checkbox {
          flex-shrink: 0;
          margin-top: 0.25rem;
        }

        .readiness-checkbox input[type="checkbox"] {
          cursor: pointer;
          width: 18px;
          height: 18px;
          accent-color: var(--sage);
        }

        .readiness-label {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          cursor: default;
        }

        .readiness-label span {
          font-size: 0.875rem;
          color: var(--text);
          line-height: 1.4;
        }

        .required-badge {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--danger);
          text-transform: uppercase;
          width: fit-content;
        }

        .readiness-note {
          font-size: 0.75rem;
          color: var(--muted);
          margin: 0;
          line-height: 1.4;
        }
      `}</style>
    </aside>
  );
}
