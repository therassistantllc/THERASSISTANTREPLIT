"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type OrgFields = {
  name: string;
  legal_name: string;
  slug: string;
  default_state: string;
  timezone: string;
  tax_id_last4: string;
  is_active: boolean;
};

type BillingProfile = {
  billing_provider_name: string;
  billing_provider_npi: string;
  billing_tax_id: string;
  billing_tax_id_type: string;
  billing_address_line1: string;
  billing_address_line2: string;
  billing_city: string;
  billing_state: string;
  billing_zip: string;
  billing_phone: string;
  billing_fax: string;
  billing_email: string;
  letterhead_logo_bucket: string;
  letterhead_logo_path: string;
  default_pos_office: string;
  default_pos_telehealth: string;
  default_service_location_id: string;
};

type BillingErrors = Partial<Record<keyof BillingProfile, string>>;

const EMPTY_ORG: OrgFields = {
  name: "",
  legal_name: "",
  slug: "",
  default_state: "",
  timezone: "America/New_York",
  tax_id_last4: "",
  is_active: true,
};

const EMPTY_BILLING: BillingProfile = {
  billing_provider_name: "",
  billing_provider_npi: "",
  billing_tax_id: "",
  billing_tax_id_type: "EIN",
  billing_address_line1: "",
  billing_address_line2: "",
  billing_city: "",
  billing_state: "",
  billing_zip: "",
  billing_phone: "",
  billing_fax: "",
  billing_email: "",
  letterhead_logo_bucket: "",
  letterhead_logo_path: "",
  default_pos_office: "11",
  default_pos_telehealth: "10",
  default_service_location_id: "",
};

/* ── Validation rules ── */
const DIGITS_ONLY = (v: string) => v.replace(/\D/g, "");

function validateField(field: keyof BillingProfile, value: string): string {
  const v = value.trim();
  if (!v) return ""; // empty is allowed; required enforcement is server-side

  switch (field) {
    case "billing_provider_npi": {
      const digits = DIGITS_ONLY(v);
      if (digits.length !== 10) return "NPI must be exactly 10 digits.";
      return "";
    }
    case "billing_tax_id": {
      const digits = DIGITS_ONLY(v);
      if (digits.length !== 9) return "Tax ID / EIN must be exactly 9 digits.";
      return "";
    }
    case "billing_zip": {
      if (!/^\d{5}(-\d{4})?$|^\d{9}$/.test(v)) return "ZIP must be 5 digits, 9 digits, or ZIP+4 (e.g. 80202, 802021234, or 80202-1234).";
      return "";
    }
    case "billing_phone": {
      const digits = DIGITS_ONLY(v);
      if (digits.length !== 10) return "Phone must be a 10-digit US number.";
      return "";
    }
    case "billing_fax": {
      const digits = DIGITS_ONLY(v);
      if (digits.length !== 10) return "Fax must be a 10-digit US number.";
      return "";
    }
    case "billing_email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Billing email is not a valid address.";
      return "";
    }
    default:
      return "";
  }
}

function validateAll(billing: BillingProfile): BillingErrors {
  const checked: Array<keyof BillingProfile> = [
    "billing_provider_npi",
    "billing_tax_id",
    "billing_zip",
    "billing_phone",
    "billing_fax",
    "billing_email",
  ];
  const errs: BillingErrors = {};
  for (const field of checked) {
    const msg = validateField(field, billing[field]);
    if (msg) errs[field] = msg;
  }
  return errs;
}

function hasErrors(errors: BillingErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/* ── Preview formatting helpers ── */
function fmtPhone(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length !== 10) return v || "—";
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function fmtTaxId(v: string, type: string): string {
  const d = v.replace(/\D/g, "");
  if (!d) return "—";
  if (type === "EIN" && d.length === 9) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return v;
}

const POS_LABELS: Record<string, string> = {
  "11": "11 – Office",
  "12": "12 – Home",
  "49": "49 – Independent Clinic",
  "02": "02 – Telehealth",
  "10": "10 – Telehealth (patient home)",
};

/* ── Small presentational helpers for the CMS-1500 preview ── */
function PlaceholderText({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "#94A3B8", fontStyle: "italic" }}>{children}</span>;
}

function CmsBox({
  boxNum,
  label,
  children,
  style,
}: {
  boxNum: string;
  label: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ padding: "8px 10px", minHeight: 64, ...style }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#5c6e82", marginBottom: 5 }}>
        <span style={{ background: "#e8edf2", borderRadius: 3, padding: "1px 5px", marginRight: 5 }}>{boxNum}</span>
        {label}
      </div>
      <div style={{ lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function LetterheadLogoField({
  organizationId,
  bucket,
  path,
  onChange,
}: {
  organizationId: string;
  bucket: string;
  path: string;
  onChange: (bucket: string | null, path: string | null) => void;
}) {
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const hasLogo = Boolean(bucket && path);

  // Render a local preview from whatever the server has on file. We use a
  // signed-url-style proxy through the existing storage if available; if not,
  // skip the preview rather than block the form.
  useEffect(() => {
    let cancelled = false;
    if (!hasLogo) { setPreviewUrl(null); return; }
    // Bust the cache when the path changes so a re-upload shows immediately.
    const cacheBust = encodeURIComponent(path);
    const url = `/api/settings/organization/logo/preview?organizationId=${encodeURIComponent(organizationId)}&v=${cacheBust}`;
    if (!cancelled) setPreviewUrl(url);
    return () => { cancelled = true; };
  }, [hasLogo, organizationId, path]);

  async function handleFile(file: File) {
    if (!/^image\/(jpe?g|png|webp|gif)$/i.test(file.type)) {
      setMsg("Logo must be a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    setBusy("upload");
    setMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        `/api/settings/organization/logo?organizationId=${encodeURIComponent(organizationId)}`,
        { method: "POST", body: form },
      );
      const json = (await res.json()) as {
        success?: boolean; error?: string;
        logo?: { bucket: string; path: string };
      };
      if (!res.ok || !json.success || !json.logo) {
        throw new Error(json.error || "Upload failed");
      }
      onChange(json.logo.bucket, json.logo.path);
      setMsg("Logo uploaded.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy("remove");
    setMsg(null);
    try {
      const res = await fetch(
        `/api/settings/organization/logo?organizationId=${encodeURIComponent(organizationId)}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error || "Remove failed");
      onChange(null, null);
      setMsg("Logo removed.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <label className="field-label" style={{ display: "block", marginBottom: "var(--space-2)" }}>
        Letterhead Logo (JPEG, PNG, WebP, or GIF — up to 2 MB)
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        {hasLogo && previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Letterhead logo preview"
            style={{
              maxHeight: 64, maxWidth: 200,
              border: "1px solid var(--line, #d8e1e9)",
              borderRadius: 4, background: "#fff", padding: 4,
            }}
          />
        ) : (
          <div style={{
            width: 200, height: 64,
            border: "1px dashed var(--line, #d8e1e9)",
            borderRadius: 4, display: "flex",
            alignItems: "center", justifyContent: "center",
            color: "var(--muted, #5c6e82)", fontSize: 12,
          }}>
            No logo uploaded
          </div>
        )}
        <input
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
          disabled={busy !== null || !organizationId}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) { void handleFile(f); e.target.value = ""; }
          }}
        />
        {hasLogo && (
          <button
            type="button"
            className="button button-secondary"
            onClick={handleRemove}
            disabled={busy !== null}
          >
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        )}
      </div>
      {busy === "upload" && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted, #5c6e82)" }}>Uploading…</div>
      )}
      {msg && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted, #5c6e82)" }}>{msg}</div>
      )}
    </div>
  );
}

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function OrganizationSettingsClient() {
  const router = useRouter();
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [org, setOrg] = useState<OrgFields>(EMPTY_ORG);
  const [billing, setBilling] = useState<BillingProfile>(EMPTY_BILLING);
  const [errors, setErrors] = useState<BillingErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof BillingProfile, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [previewOpen, setPreviewOpen] = useState(true);

  useEffect(() => {
    if (!organizationId) { setLoading(false); return; }
    fetch(`/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((json: { organization?: Partial<OrgFields>; billing_profile?: Partial<BillingProfile> }) => {
        if (json.organization) setOrg((prev) => ({ ...prev, ...json.organization }));
        if (json.billing_profile) setBilling((prev) => ({ ...prev, ...json.billing_profile }));
      })
      .catch(() => setStatusMsg("Failed to load settings."))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const handleSave = useCallback(async () => {
    // Mark all validated fields as touched so errors become visible
    setTouched({
      billing_provider_npi: true,
      billing_tax_id: true,
      billing_zip: true,
      billing_phone: true,
      billing_fax: true,
      billing_email: true,
    });

    const errs = validateAll(billing);
    setErrors(errs);
    if (hasErrors(errs)) return; // block save

    setSaving(true);
    setStatus("idle");
    try {
      const res = await fetch(
        `/api/settings/organization?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...org, billing_profile: billing }),
        },
      );
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatus("saved");
      setStatusMsg("Settings saved. Returning to organizations list…");
      setTimeout(() => router.push("/settings/organizations"), 600);
    } catch (err) {
      setStatus("error");
      setStatusMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [organizationId, org, billing]);

  /* Update a billing field, re-validate it immediately if it's been touched */
  function updateBilling<K extends keyof BillingProfile>(field: K, value: string) {
    setBilling((prev) => {
      const next = { ...prev, [field]: value };
      if (touched[field]) {
        const msg = validateField(field, value);
        setErrors((e) => ({ ...e, [field]: msg }));
      }
      return next;
    });
  }

  function markTouched(field: keyof BillingProfile) {
    if (touched[field]) return;
    setTouched((t) => ({ ...t, [field]: true }));
    const msg = validateField(field, billing[field]);
    setErrors((e) => ({ ...e, [field]: msg }));
  }

  /* Org field helper */
  function tf(field: keyof OrgFields, label: string, type = "text") {
    return (
      <label className="field-label">
        {label}
        <input
          type={type}
          value={String(org[field] ?? "")}
          onChange={(e) => setOrg((prev) => ({ ...prev, [field]: e.target.value }))}
        />
      </label>
    );
  }

  /* Billing field helper — shows inline error when touched */
  function bf(field: keyof BillingProfile, label: string, type = "text") {
    const errMsg = errors[field];
    const hasErr = Boolean(errMsg);
    return (
      <label className="field-label">
        {label}
        <input
          type={type}
          value={String(billing[field] ?? "")}
          style={hasErr ? { borderColor: "var(--danger, #b02020)", boxShadow: "0 0 0 2px rgba(176,32,32,0.12)" } : undefined}
          onChange={(e) => updateBilling(field, e.target.value)}
          onBlur={() => markTouched(field)}
          aria-invalid={hasErr}
          aria-describedby={hasErr ? `err-${field}` : undefined}
        />
        {hasErr && (
          <span
            id={`err-${field}`}
            role="alert"
            style={{
              display: "block",
              marginTop: 4,
              fontSize: "var(--text-xs, 11px)",
              color: "var(--danger, #b02020)",
              fontWeight: 500,
            }}
          >
            {errMsg}
          </span>
        )}
      </label>
    );
  }

  const saveBlocked = hasErrors(validateAll(billing)) || saving || !organizationId;

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Organization Settings</h1>
          <p className="hero-copy">Practice identity, billing provider details, and transmission defaults.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings/organizations">← Organizations</Link>
        </div>
      </section>

      {!organizationId && (
        <div className="alert-panel">
          No organization context. Add <code>?organizationId=…</code> or set <code>NEXT_PUBLIC_ORGANIZATION_ID</code>.
        </div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel form-panel">
            <h2>Practice Identity</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {tf("name", "Display / Practice Name")}
              {tf("legal_name", "Legal Name")}
              {tf("slug", "Slug")}
              {tf("default_state", "Default State (2-letter)")}
              {tf("timezone", "Timezone")}
              {tf("tax_id_last4", "Tax ID Last 4 Digits")}
            </div>
            <label className="checkbox-label" style={{ marginTop: "var(--space-3)" }}>
              <input
                type="checkbox"
                checked={org.is_active}
                onChange={(e) => setOrg((prev) => ({ ...prev, is_active: e.target.checked }))}
              />
              Organization is active
            </label>
          </section>

          <section className="panel form-panel">
            <h2>Billing Provider Profile</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              These values populate claim headers. Stored in system settings under{" "}
              <code>organization.billing_profile</code>.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {bf("billing_provider_name", "Billing Provider Name")}
              {bf("billing_provider_npi", "Billing Provider NPI (10 digits)")}
              {bf("billing_tax_id", "Tax ID / EIN (9 digits)")}
              <label className="field-label">
                Tax ID Type
                <select
                  value={billing.billing_tax_id_type}
                  onChange={(e) => setBilling((prev) => ({ ...prev, billing_tax_id_type: e.target.value }))}
                >
                  <option value="EIN">EIN</option>
                  <option value="SSN">SSN</option>
                </select>
              </label>
              {bf("billing_phone", "Billing Phone")}
              <label className="field-label">
                Default POS – Office
                <select
                  value={billing.default_pos_office}
                  onChange={(e) => setBilling((prev) => ({ ...prev, default_pos_office: e.target.value }))}
                >
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="49">49 – Independent Clinic</option>
                  <option value="02">02 – Telehealth</option>
                  <option value="10">10 – Telehealth (patient home)</option>
                </select>
              </label>
              <label className="field-label">
                Default POS – Telehealth
                <select
                  value={billing.default_pos_telehealth}
                  onChange={(e) => setBilling((prev) => ({ ...prev, default_pos_telehealth: e.target.value }))}
                >
                  <option value="10">10 – Telehealth (patient home)</option>
                  <option value="02">02 – Telehealth</option>
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="49">49 – Independent Clinic</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Billing Address</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {bf("billing_address_line1", "Address Line 1")}
              {bf("billing_address_line2", "Address Line 2")}
              {bf("billing_city", "City")}
              {bf("billing_state", "State (2-letter)")}
              {bf("billing_zip", "ZIP Code")}
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Billing Letterhead</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              These contact details and logo appear on generated billing PDFs (cover
              letters, appeal packets) so payers can reach the practice and recognise
              its brand. The billing address and phone above are reused; add fax,
              email, and an optional logo (JPEG, PNG, WebP, or GIF) here.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              {bf("billing_fax", "Billing Fax")}
              {bf("billing_email", "Billing Email", "email")}
            </div>
            <LetterheadLogoField
              organizationId={organizationId}
              bucket={billing.letterhead_logo_bucket}
              path={billing.letterhead_logo_path}
              onChange={(b, p) =>
                setBilling((prev) => ({
                  ...prev,
                  letterhead_logo_bucket: b ?? "",
                  letterhead_logo_path: p ?? "",
                }))
              }
            />
          </section>

          {/* ── Claim Header Preview ── */}
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            {/* Toggle header */}
            <button
              type="button"
              onClick={() => setPreviewOpen((o) => !o)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--space-4) var(--space-5)",
                background: "none",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
              aria-expanded={previewOpen}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, borderRadius: 6, background: "var(--navy, #10243f)",
                  color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>
                  ☰
                </span>
                <span style={{ fontSize: "var(--text-base, 15px)", fontWeight: 700, color: "var(--text, #1a2332)" }}>
                  Claim Header Preview
                </span>
                <span style={{ fontSize: "var(--text-xs, 11px)", color: "var(--muted, #5c6e82)", fontWeight: 400 }}>
                  — live view of how these values appear on an 837P / CMS-1500
                </span>
              </span>
              <span style={{ fontSize: 12, color: "var(--muted, #5c6e82)", transform: previewOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
            </button>

            {previewOpen && (
              <div style={{ borderTop: "1px solid var(--line, #d8e1e9)", padding: "var(--space-5)" }}>
                {/* CMS-1500 mock — rendered as a bordered grid */}
                <div style={{
                  fontFamily: "'Courier New', Courier, monospace",
                  fontSize: 12,
                  border: "1.5px solid #1a2332",
                  borderRadius: 4,
                  overflow: "hidden",
                  maxWidth: 760,
                }}>
                  {/* Form header bar */}
                  <div style={{
                    background: "#1a2332", color: "#fff",
                    padding: "6px 12px", fontSize: 11, fontWeight: 700,
                    letterSpacing: "0.08em", textTransform: "uppercase",
                  }}>
                    CMS-1500 (02-12) · Billing Provider Boxes
                  </div>

                  {/* Box rows */}
                  {/* Row 1: Box 33 (Billing Provider Info) spanning full width */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #c8d4de" }}>
                    {/* Box 33 */}
                    <CmsBox
                      boxNum="33"
                      label="BILLING PROVIDER INFO & PH#"
                      style={{ borderRight: "1px solid #c8d4de" }}
                    >
                      <div style={{ fontWeight: 700 }}>{billing.billing_provider_name || <PlaceholderText>Billing Provider Name</PlaceholderText>}</div>
                      <div>{billing.billing_address_line1 || <PlaceholderText>Address Line 1</PlaceholderText>}</div>
                      {billing.billing_address_line2 && <div>{billing.billing_address_line2}</div>}
                      <div>
                        {billing.billing_city || <PlaceholderText>City</PlaceholderText>}
                        {billing.billing_city ? ", " : " "}
                        {billing.billing_state || <PlaceholderText>ST</PlaceholderText>}
                        {" "}
                        {billing.billing_zip || <PlaceholderText>ZIP</PlaceholderText>}
                      </div>
                      <div style={{ marginTop: 4 }}>{fmtPhone(billing.billing_phone)}</div>
                    </CmsBox>

                    {/* Box 33a + 33b stacked */}
                    <div>
                      <CmsBox boxNum="33a" label="NPI" style={{ borderBottom: "1px solid #c8d4de" }}>
                        <span style={{ letterSpacing: "0.12em", fontWeight: 700 }}>
                          {billing.billing_provider_npi || <PlaceholderText>0000000000</PlaceholderText>}
                        </span>
                      </CmsBox>
                      <CmsBox boxNum="33b" label="OTHER ID #">
                        <PlaceholderText>—</PlaceholderText>
                      </CmsBox>
                    </div>
                  </div>

                  {/* Row 2: Box 25 (Tax ID) + Default POS */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid #c8d4de" }}>
                    <CmsBox boxNum="25" label="FEDERAL TAX I.D. NUMBER" style={{ borderRight: "1px solid #c8d4de" }}>
                      <span style={{ letterSpacing: "0.1em", fontWeight: 700 }}>
                        {fmtTaxId(billing.billing_tax_id, billing.billing_tax_id_type)}
                      </span>
                      <span style={{ marginLeft: 12, fontSize: 11, color: "#5c6e82" }}>
                        ☑ {billing.billing_tax_id_type || "EIN"}
                      </span>
                    </CmsBox>

                    <CmsBox boxNum="24B" label="DEFAULT PLACE OF SERVICE">
                      <div>
                        <span style={{ fontSize: 11, color: "#5c6e82" }}>Office: </span>
                        {(POS_LABELS[billing.default_pos_office] ?? billing.default_pos_office) || <PlaceholderText>—</PlaceholderText>}
                      </div>
                      <div style={{ marginTop: 3 }}>
                        <span style={{ fontSize: 11, color: "#5c6e82" }}>Telehealth: </span>
                        {(POS_LABELS[billing.default_pos_telehealth] ?? billing.default_pos_telehealth) || <PlaceholderText>—</PlaceholderText>}
                      </div>
                    </CmsBox>
                  </div>

                  {/* Footer note */}
                  <div style={{ padding: "6px 12px", background: "#f2f4f7", fontSize: 10, color: "#5c6e82" }}>
                    Read-only preview — save the form to persist changes. Greyed values indicate empty fields.
                  </div>
                </div>
              </div>
            )}
          </section>

          {status !== "idle" && (
            <div className={status === "saved" ? "alert-panel alert-panel-success" : "alert-panel"}>
              {statusMsg}
            </div>
          )}

          <div style={{ padding: "0 var(--space-6) var(--space-6)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <button
              className="button button-primary"
              onClick={handleSave}
              disabled={saveBlocked}
              title={hasErrors(errors) ? "Fix validation errors before saving" : undefined}
            >
              {saving ? "Saving…" : "Save Organization Settings"}
            </button>
            {hasErrors(errors) && (
              <span style={{ fontSize: "var(--text-sm, 13px)", color: "var(--danger, #b02020)", fontWeight: 500 }}>
                Fix the errors above before saving.
              </span>
            )}
          </div>
        </>
      )}
    </main>
  );
}
