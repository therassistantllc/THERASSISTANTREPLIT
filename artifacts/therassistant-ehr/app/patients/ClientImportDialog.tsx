"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./clientImportDialog.module.css";

type Stage = "select" | "preview" | "result" | "error";

type CanonicalField = string;

type RowValidation = {
  rowNumber: number;
  importStatus: "valid" | "invalid" | "duplicate" | "pending" | "imported" | "failed" | "skipped";
  errors: string[];
  warnings: string[];
  sourceClientId: string | null;
  isDuplicate: boolean;
  duplicateReason: string | null;
  duplicateStrategy: string | null;
  mappedValues?: Record<string, unknown> | null;
};

type UploadResponse = {
  ok: boolean;
  jobId: string;
  headers: string[];
  totalRows: number;
  proposedMapping: Record<CanonicalField, string | null>;
  error?: string;
};

type ValidateResponse = {
  ok: boolean;
  validationSummary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
  };
  rowValidations: RowValidation[];
  error?: string;
};

type ImportResponse = {
  ok: boolean;
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
    promoted: number;
    skipped: number;
    failed: number;
    failedRows: Array<{ rowNumber: number; error: string }>;
  };
  failedRows: Array<{ rowNumber: number; error: string }> | null;
  error?: string;
};

const CANONICAL_FIELDS: CanonicalField[] = [
  "source_client_id",
  "first_name",
  "last_name",
  "date_of_birth",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "primary_insurance_name",
  "primary_member_id",
  "primary_group_id",
  "primary_policy_number",
  "secondary_insurance_name",
  "secondary_member_id",
  "secondary_policy_number",
  "responsible_party_name",
  "emergency_contact_name",
  "emergency_contact_phone",
  "assigned_clinician_name",
  "status",
];

export default function ClientImportDialog({
  open,
  organizationId,
  onClose,
  onImported,
}: {
  open: boolean;
  organizationId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [stage, setStage] = useState<Stage>("select");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<CanonicalField, string | null>>(
    {} as Record<CanonicalField, string | null>,
  );
  const [rowValidations, setRowValidations] = useState<RowValidation[]>([]);
  const [validationSummary, setValidationSummary] =
    useState<ValidateResponse["validationSummary"] | null>(null);
  const [importSummary, setImportSummary] =
    useState<ImportResponse["summary"] | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset on close
      setStage("select");
      setFile(null);
      setBusy(false);
      setError(null);
      setJobId(null);
      setHeaders([]);
      setMapping({} as Record<CanonicalField, string | null>);
      setRowValidations([]);
      setValidationSummary(null);
      setImportSummary(null);
    }
  }, [open]);

  const counts = useMemo(() => {
    let valid = 0;
    let invalid = 0;
    let duplicate = 0;
    for (const row of rowValidations) {
      if (row.importStatus === "valid") valid += 1;
      else if (row.importStatus === "invalid") invalid += 1;
      else if (row.importStatus === "duplicate") duplicate += 1;
    }
    return { valid, invalid, duplicate };
  }, [rowValidations]);

  async function handleUpload() {
    if (!file) {
      setError("Please choose a CSV file to upload.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source_system", "csv_upload");
      if (organizationId) fd.append("organization_id", organizationId);

      const uploadRes = await fetch("/api/imports/clients/upload", {
        method: "POST",
        body: fd,
      });
      const uploadJson = (await uploadRes.json()) as UploadResponse;
      if (!uploadRes.ok || !uploadJson.ok) {
        throw new Error(uploadJson.error ?? "Failed to upload file");
      }

      setJobId(uploadJson.jobId);
      setHeaders(uploadJson.headers);
      setMapping(uploadJson.proposedMapping);

      // Immediately validate with the proposed mapping
      const mapRes = await fetch(
        `/api/imports/clients/${uploadJson.jobId}/map`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping: uploadJson.proposedMapping }),
        },
      );
      const mapJson = (await mapRes.json()) as ValidateResponse;
      if (!mapRes.ok || !mapJson.ok) {
        throw new Error(mapJson.error ?? "Failed to validate rows");
      }
      setValidationSummary(mapJson.validationSummary);
      setRowValidations(mapJson.rowValidations);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevalidate(nextMapping: Record<CanonicalField, string | null>) {
    if (!jobId) return;
    setBusy(true);
    setError(null);
    try {
      const mapRes = await fetch(`/api/imports/clients/${jobId}/map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping: nextMapping }),
      });
      const mapJson = (await mapRes.json()) as ValidateResponse;
      if (!mapRes.ok || !mapJson.ok) {
        throw new Error(mapJson.error ?? "Failed to revalidate rows");
      }
      setValidationSummary(mapJson.validationSummary);
      setRowValidations(mapJson.rowValidations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revalidation failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmImport() {
    if (!jobId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/imports/clients/${jobId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importDuplicates: false, allowUpdateExisting: false }),
      });
      const json = (await res.json()) as ImportResponse;
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "Failed to import rows");
      }
      setImportSummary(json.summary);
      setStage("result");
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Import clients from CSV">
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 className={styles.title}>Import clients from CSV</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          {error ? <div className={styles.error}>{error}</div> : null}

          {stage === "select" ? (
            <div className={styles.stage}>
              <p className={styles.help}>
                Upload a CSV file of clients to bulk-load them into your organization.
                Rows that already exist (same first name, last name, and DOB) will be
                skipped automatically.
              </p>
              <p className={styles.help}>
                Not sure what columns to include?{" "}
                <a
                  className={styles.link}
                  href="/api/imports/clients/template"
                  download
                >
                  Download the CSV template
                </a>
                .
              </p>
              <label className={styles.fileLabel}>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file ? (
                  <span className={styles.fileName}>{file.name}</span>
                ) : (
                  <span className={styles.fileMuted}>Choose a .csv file</span>
                )}
              </label>
            </div>
          ) : null}

          {stage === "preview" ? (
            <div className={styles.stage}>
              <div className={styles.summaryRow}>
                <span className={`${styles.pill} ${styles.pillValid}`}>
                  {counts.valid} valid
                </span>
                <span className={`${styles.pill} ${styles.pillDup}`}>
                  {counts.duplicate} duplicate
                </span>
                <span className={`${styles.pill} ${styles.pillInvalid}`}>
                  {counts.invalid} invalid
                </span>
                <span className={styles.totalLabel}>
                  of {validationSummary?.totalRows ?? rowValidations.length} rows
                </span>
              </div>

              <details className={styles.mappingDetails}>
                <summary className={styles.mappingSummary}>
                  Column mapping ({headers.length} columns detected)
                </summary>
                <div className={styles.mappingGrid}>
                  {CANONICAL_FIELDS.map((field) => (
                    <label key={field} className={styles.mappingRow}>
                      <span className={styles.mappingField}>{field}</span>
                      <select
                        className={styles.mappingSelect}
                        value={mapping[field] ?? ""}
                        onChange={(e) => {
                          const next = {
                            ...mapping,
                            [field]: e.target.value || null,
                          };
                          setMapping(next);
                        }}
                      >
                        <option value="">— Not mapped —</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => handleRevalidate(mapping)}
                  disabled={busy}
                >
                  {busy ? "Re-validating…" : "Re-validate with this mapping"}
                </button>
              </details>

              <div className={styles.tableWrap}>
                <table className={styles.previewTable}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Status</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowValidations.slice(0, 200).map((row) => {
                      const tone =
                        row.importStatus === "valid"
                          ? styles.statusValid
                          : row.importStatus === "duplicate"
                            ? styles.statusDup
                            : styles.statusInvalid;
                      const messages = [
                        ...(row.errors ?? []),
                        ...(row.warnings ?? []),
                      ];
                      return (
                        <tr key={row.rowNumber}>
                          <td>{row.rowNumber}</td>
                          <td>
                            <span className={`${styles.statusBadge} ${tone}`}>
                              {row.importStatus}
                            </span>
                          </td>
                          <td className={styles.notesCell}>
                            {messages.length > 0 ? messages.join("; ") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rowValidations.length > 200 ? (
                  <p className={styles.tableFootnote}>
                    Showing the first 200 rows. All {rowValidations.length} rows will be
                    processed on confirm.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {stage === "result" && importSummary ? (
            <div className={styles.stage}>
              <div className={styles.resultGrid}>
                <div className={styles.resultStat}>
                  <span className={styles.resultStatLabel}>Imported</span>
                  <span className={styles.resultStatValueOk}>
                    {importSummary.promoted}
                  </span>
                </div>
                <div className={styles.resultStat}>
                  <span className={styles.resultStatLabel}>Skipped</span>
                  <span className={styles.resultStatValue}>
                    {importSummary.skipped}
                  </span>
                </div>
                <div className={styles.resultStat}>
                  <span className={styles.resultStatLabel}>Failed</span>
                  <span className={styles.resultStatValueBad}>
                    {importSummary.failed}
                  </span>
                </div>
                <div className={styles.resultStat}>
                  <span className={styles.resultStatLabel}>Total rows</span>
                  <span className={styles.resultStatValue}>
                    {importSummary.total}
                  </span>
                </div>
              </div>

              {importSummary.failed > 0 || importSummary.invalid > 0 ? (
                <div className={styles.failedBlock}>
                  <p className={styles.help}>
                    {importSummary.failed + importSummary.invalid} row
                    {importSummary.failed + importSummary.invalid === 1 ? "" : "s"}{" "}
                    did not import. Download the failed-rows CSV, fix the issues, and
                    re-upload to retry.
                  </p>
                  {jobId ? (
                    <a
                      className={styles.secondaryBtn}
                      href={`/api/imports/clients/${jobId}/failed-rows`}
                      download
                    >
                      Download failed rows CSV
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className={styles.help}>All eligible rows imported successfully.</p>
              )}
            </div>
          ) : null}
        </div>

        <footer className={styles.footer}>
          {stage === "select" ? (
            <>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleUpload}
                disabled={busy || !file}
              >
                {busy ? "Uploading…" : "Upload & preview"}
              </button>
            </>
          ) : null}

          {stage === "preview" ? (
            <>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleConfirmImport}
                disabled={busy || counts.valid === 0}
              >
                {busy
                  ? "Importing…"
                  : `Import ${counts.valid} valid row${counts.valid === 1 ? "" : "s"}`}
              </button>
            </>
          ) : null}

          {stage === "result" ? (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={onClose}
            >
              Done
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
