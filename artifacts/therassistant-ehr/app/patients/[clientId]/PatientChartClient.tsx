"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import {
  US_STATE_OPTIONS,
  US_STATE_CODES,
  SEX_AT_BIRTH_OPTIONS,
  SEX_AT_BIRTH_VALUES,
  GENDER_IDENTITY_OPTIONS,
  GENDER_IDENTITY_VALUES,
  GENDER_IDENTITY_FREE_TEXT_PREFIX,
  PREFERRED_LANGUAGE_OPTIONS,
  PREFERRED_LANGUAGE_VALUES,
  PREFERRED_LANGUAGE_FREE_TEXT_PREFIX,
} from "@/lib/demographics/options";
import CasesPanel from "./CasesPanel";
import {
  ENTRY_TYPES,
  entryTypeLabel,
  type EntryType,
  type JournalEntry,
} from "@/lib/portal/journal";

type JournalHighlights = {
  since: string | null;
  total: number;
  counts: Partial<Record<EntryType, number>>;
};

function splitPickerValue(
  raw: string | null | undefined,
  allowed: ReadonlySet<string>,
  freeTextPrefix: string,
): { choice: string; other: string } {
  const value = (raw ?? "").trim();
  if (!value) return { choice: "", other: "" };
  if (allowed.has(value)) return { choice: value, other: "" };
  if (value.startsWith(freeTextPrefix)) {
    return { choice: "other", other: value.slice(freeTextPrefix.length).trim() };
  }
  return { choice: "other", other: value };
}

function combinePickerValue(choice: string, other: string, freeTextPrefix: string): string {
  if (choice !== "other") return choice;
  const trimmed = other.trim();
  return trimmed ? `${freeTextPrefix}${trimmed}` : "";
}

function formatSexAtBirth(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match = SEX_AT_BIRTH_OPTIONS.find((o) => o.value === value);
  return match ? match.label : value;
}

function formatGenderIdentity(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith(GENDER_IDENTITY_FREE_TEXT_PREFIX)) {
    const rest = value.slice(GENDER_IDENTITY_FREE_TEXT_PREFIX.length).trim();
    return rest || null;
  }
  const match = GENDER_IDENTITY_OPTIONS.find((o) => o.value === value);
  return match ? match.label : value;
}

function formatPreferredLanguage(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith(PREFERRED_LANGUAGE_FREE_TEXT_PREFIX)) {
    const rest = value.slice(PREFERRED_LANGUAGE_FREE_TEXT_PREFIX.length).trim();
    return rest || null;
  }
  const match = PREFERRED_LANGUAGE_OPTIONS.find((o) => o.value === value);
  return match ? match.label : value;
}

function formatStateForDisplay(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  return value;
}

function normalizeStateInput(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const upper = value.toUpperCase();
  if (US_STATE_CODES.has(upper)) return upper;
  const match = US_STATE_OPTIONS.find((s) => s.name.toLowerCase() === value.toLowerCase());
  return match ? match.code : "";
}

type InsurancePolicySummary = {
  id: string;
  plan_name?: string | null;
  policy_number?: string | null;
  group_number?: string | null;
  priority?: string | null;
  active_flag?: boolean | null;
  payer_id?: string | null;
  payer_name?: string | null;
  effective_date?: string | null;
  termination_date?: string | null;
  copay_amount?: string | number | null;
};

type PayerOption = {
  id: string;
  payer_name: string;
  payer_id?: string | null;
};

type PolicyEditDraft = {
  planName: string;
  payerId: string;
  policyNumber: string;
  groupNumber: string;
  effectiveDate: string;
  terminationDate: string;
  copayAmount: string;
};

type EligibilitySummary = {
  id?: string;
  eligibility_status?: string | null;
  checked_at?: string | null;
  copay_amount?: string | number | null;
  deductible_remaining?: string | number | null;
};

type CaseRowSummary = {
  id: string;
  name: string;
  caseType: string;
  activeFlag: boolean;
  isDefault: boolean;
  policies: Array<{
    policyId: string;
    priority: "primary" | "secondary" | "tertiary";
    planName: string | null;
    payerName: string | null;
    policyNumber: string | null;
  }>;
};

type InvoiceSummary = {
  id: string;
  invoice_number?: string | null;
  invoice_status?: string | null;
  balance_amount?: string | number | null;
};

type EncounterSummary = {
  id: string;
  encounter_status?: string | null;
  service_date?: string | null;
};

type WorkqueueSummary = {
  id: string;
  title?: string | null;
  work_type?: string | null;
  status?: string | null;
  priority?: string | null;
  created_at?: string | null;
};

type PatientSummary = {
  success: boolean;
  error?: string;
  client?: {
    id: string;
    name: string;
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    preferredName?: string | null;
    dateOfBirth?: string | null;
    email?: string | null;
    phone?: string | null;
    pronouns?: string | null;
    mrn?: string | null;
    sexAtBirth?: string | null;
    genderIdentity?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    preferredLanguage?: string | null;
    sourceClientId?: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
    primaryProviderId?: string | null;
  };
  insurance?: {
    policies: InsurancePolicySummary[];
    latestEligibility: EligibilitySummary | null;
  };
  balance?: {
    total: number;
    invoices: InvoiceSummary[];
  };
  creditOnAccount?: number | null;
  encounters?: EncounterSummary[];
  workqueueItems?: WorkqueueSummary[];
};

type AppointmentSummary = {
  id: string;
  scheduledStart?: string | null;
  status?: string | null;
  type?: string | null;
  reason?: string | null;
  encounter?: { id: string; status?: string | null } | null;
};

type ClinicianOption = {
  providerId: string;
  displayName: string;
};

type ConditionSummary = {
  id: string;
  code: string;
  description?: string | null;
  encounterId: string;
  encounterDate?: string | null;
};

type ClaimSummary = {
  id: string;
  claimNumber?: string | null;
  status?: string | null;
  totalCharge?: number | null;
  createdAt?: string | null;
};

type NoteSummary = {
  id: string;
  encounterId: string;
  encounterDate?: string | null;
  noteStatus?: string | null;
  noteType?: string | null;
};

type DocumentSummary = {
  id: string;
  type?: string | null;
  title?: string | null;
  fileName?: string | null;
  filedAt?: string | null;
  createdAt?: string | null;
  mailroomItemId?: string | null;
};

type MailroomSummary = {
  id: string;
  fileName?: string;
  status?: string;
  documentType?: string;
  createdAt?: string;
};

type CreditSourceSummary = {
  id: string;
  paymentMethod: string | null;
  referenceNumber: string | null;
  paidAt: string | null;
  amount: string | number | null;
  postingStatus: string | null;
  reversedAt: string | null;
  refundable: boolean;
};

type CreditRow = {
  id: string;
  client_id: string;
  source_payment_id: string | null;
  initial_amount: string | number | null;
  applied_amount: string | number | null;
  balance_amount: string | number | null;
  note: string | null;
  created_at: string | null;
  source: CreditSourceSummary | null;
};

type OpenInvoiceOption = {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  balanceAmount: number;
};

type OpenClaimOption = {
  id: string;
  claimNumber: string | null;
  status: string | null;
  patientResponsibilityAmount: number;
};

type DetailState = {
  appointments: AppointmentSummary[];
  conditions: ConditionSummary[];
  claims: ClaimSummary[];
  notes: NoteSummary[];
  documents: DocumentSummary[];
  mailroomItems: MailroomSummary[];
};

function getOrganizationIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId");
}

function resolveOrganizationId(initialOrganizationId?: string): string {
  // Prefer the server-resolved org (from the authenticated staff session),
  // then a URL query override (kept for back-compat / direct links),
  // then the public env fallback, then the hard-coded default.
  if (initialOrganizationId) return initialOrganizationId;
  const fromUrl = getOrganizationIdFromUrl();
  if (fromUrl) return fromUrl;
  return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(`${value}`.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function statusClass(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("active") && !normalized.includes("inactive")) return "status status-green";
  if (normalized.includes("paid") || normalized.includes("accepted") || normalized.includes("resolved")) return "status status-green";
  if (normalized.includes("inactive") || normalized.includes("blocked") || normalized.includes("denied") || normalized.includes("rejected")) return "status status-red";
  if (normalized.includes("open") || normalized.includes("sent") || normalized.includes("draft") || normalized.includes("submitted") || normalized.includes("in_progress")) return "status status-yellow";
  return "status";
}

type DemographicAuditEntry = {
  id: string;
  createdAt: string;
  field: string | null;
  fieldLabel: string;
  beforeValue: string | null;
  afterValue: string | null;
  actorName: string | null;
  actorEmail: string | null;
  userRole: string | null;
  objectType?: string;
  objectId?: string | null;
  objectLabel?: string;
  section?: string;
  action?: string | null;
};

async function fetchList<T>(url: string, field: string): Promise<T[]> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const json = (await response.json()) as Record<string, unknown> & { success?: boolean };
    if (!response.ok || !json.success) return [];
    return (Array.isArray(json[field]) ? (json[field] as T[]) : []);
  } catch {
    return [];
  }
}

export default function PatientChartClient({
  clientId,
  initialOrganizationId,
}: {
  clientId: string;
  initialOrganizationId?: string;
}) {
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [details, setDetails] = useState<DetailState>({
    appointments: [],
    conditions: [],
    claims: [],
    notes: [],
    documents: [],
    mailroomItems: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cases, setCases] = useState<CaseRowSummary[]>([]);
  const [casesModalOpen, setCasesModalOpen] = useState(false);
  const [demoEditing, setDemoEditing] = useState(false);
  const [demoSaving, setDemoSaving] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoMessage, setDemoMessage] = useState<string | null>(null);
  const [demoDraft, setDemoDraft] = useState<Record<string, string>>({});
  const [demoOriginal, setDemoOriginal] = useState<Record<string, string>>({});
  const [auditEntries, setAuditEntries] = useState<DemographicAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [policyEditId, setPolicyEditId] = useState<string | null>(null);
  const [policyEditDraft, setPolicyEditDraft] = useState<PolicyEditDraft | null>(null);
  const [policySavingId, setPolicySavingId] = useState<string | null>(null);
  const [policyEditError, setPolicyEditError] = useState<string | null>(null);
  const [eligibilityRefreshPolicyId, setEligibilityRefreshPolicyId] = useState<string | null>(null);
  const [eligibilityRefreshBusy, setEligibilityRefreshBusy] = useState(false);
  const [eligibilityRefreshError, setEligibilityRefreshError] = useState<string | null>(null);
  const [eligibilityRefreshMessage, setEligibilityRefreshMessage] = useState<string | null>(null);
  const [payerOptions, setPayerOptions] = useState<PayerOption[]>([]);
  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [creditsMessage, setCreditsMessage] = useState<string | null>(null);
  const [openInvoices, setOpenInvoices] = useState<OpenInvoiceOption[]>([]);
  const [openClaims, setOpenClaims] = useState<OpenClaimOption[]>([]);
  const [creditDraft, setCreditDraft] = useState<
    Record<
      string,
      {
        mode: "apply" | "refund";
        target: "invoice" | "claim";
        invoiceId: string;
        claimId: string;
        amount: string;
        reason: string;
      }
    >
  >({});
  const [creditBusy, setCreditBusy] = useState<string | null>(null);
  const [journalHighlights, setJournalHighlights] = useState<JournalHighlights | null>(null);
  const [journalHighlightsLoading, setJournalHighlightsLoading] = useState(false);
  const [clinicianOptions, setClinicianOptions] = useState<ClinicianOption[]>([]);
  const organizationId = useMemo(
    () => resolveOrganizationId(initialOrganizationId),
    [initialOrganizationId],
  );

  function startDemoEdit() {
    if (!summary?.client) return;
    const p = summary.client;
    const rawSex = (p.sexAtBirth ?? "").trim();
    const rawGender = (p.genderIdentity ?? "").trim();
    const rawLang = (p.preferredLanguage ?? "").trim();
    const rawState = (p.state ?? "").trim();
    // Coerce legacy values so the dropdowns show something sensible and the
    // drafted value will pass server-side validation if saved unchanged.
    const sexAtBirth = SEX_AT_BIRTH_VALUES.has(rawSex) ? rawSex : "";
    const genderIdentity = !rawGender
      ? ""
      : GENDER_IDENTITY_VALUES.has(rawGender)
        ? rawGender
        : rawGender.startsWith(GENDER_IDENTITY_FREE_TEXT_PREFIX)
          ? rawGender
          : `${GENDER_IDENTITY_FREE_TEXT_PREFIX}${rawGender}`;
    const preferredLanguage = !rawLang
      ? ""
      : PREFERRED_LANGUAGE_VALUES.has(rawLang)
        ? rawLang
        : rawLang.startsWith(PREFERRED_LANGUAGE_FREE_TEXT_PREFIX)
          ? rawLang
          : `${PREFERRED_LANGUAGE_FREE_TEXT_PREFIX}${rawLang}`;
    const state = rawState ? normalizeStateInput(rawState) : "";
    const initial = {
      preferredName: p.preferredName ?? "",
      mrn: p.mrn ?? "",
      firstName: p.firstName ?? "",
      lastName: p.lastName ?? "",
      middleName: p.middleName ?? "",
      dateOfBirth: p.dateOfBirth ?? "",
      sexAtBirth,
      genderIdentity,
      addressLine1: p.addressLine1 ?? "",
      addressLine2: p.addressLine2 ?? "",
      city: p.city ?? "",
      state,
      postalCode: p.postalCode ?? "",
      phone: p.phone ?? "",
      email: p.email ?? "",
      preferredLanguage,
      sourceClientId: p.sourceClientId ?? "",
      emergencyContactName: p.emergencyContactName ?? "",
      emergencyContactPhone: p.emergencyContactPhone ?? "",
      primaryProviderId: p.primaryProviderId ?? "",
    };
    setDemoDraft(initial);
    setDemoOriginal(initial);
    setDemoError(null);
    setDemoMessage(null);
    setDemoEditing(true);
  }

  function cancelDemoEdit() {
    setDemoEditing(false);
    setDemoError(null);
    setDemoDraft({});
    setDemoOriginal({});
  }

  function setDemoField(field: string, value: string) {
    setDemoDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function reloadCredits() {
    if (!organizationId) return;
    setCreditsLoading(true);
    setCreditsError(null);
    try {
      const [creditsRes, balanceRes, summaryRes, claimsRes] = await Promise.all([
        fetch(
          `/api/billing/clients/${encodeURIComponent(clientId)}/credits?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/patients/${encodeURIComponent(clientId)}/balance?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/patients/${encodeURIComponent(clientId)}/summary?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/patients/${encodeURIComponent(clientId)}/claims?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: "no-store" },
        ),
      ]);
      const creditsJson = await creditsRes.json().catch(() => ({}));
      const balanceJson = await balanceRes.json().catch(() => ({}));
      const summaryJson = await summaryRes.json().catch(() => ({}));
      const claimsJson = await claimsRes.json().catch(() => ({}));
      if (!creditsRes.ok || creditsJson.ok === false) {
        throw new Error(creditsJson.error ?? "Failed to load credits");
      }
      setCredits((creditsJson.credits ?? []) as CreditRow[]);
      if (balanceRes.ok && balanceJson.success) {
        const invoices: OpenInvoiceOption[] = (balanceJson.invoices ?? [])
          .filter((inv: { status?: string | null; balanceAmount?: number }) =>
            ["open", "sent", "collections"].includes(String(inv.status ?? "")) &&
            Number(inv.balanceAmount ?? 0) > 0,
          )
          .map((inv: {
            id: string;
            invoiceNumber?: string | null;
            status?: string | null;
            balanceAmount?: number;
          }) => ({
            id: String(inv.id),
            invoiceNumber: inv.invoiceNumber ?? null,
            status: inv.status ?? null,
            balanceAmount: Number(inv.balanceAmount ?? 0),
          }));
        setOpenInvoices(invoices);
      }
      if (summaryRes.ok && summaryJson.success) {
        setSummary(summaryJson as PatientSummary);
      }
      if (claimsRes.ok && claimsJson.success) {
        const claims: OpenClaimOption[] = (claimsJson.claims ?? [])
          .filter(
            (cl: { patientResponsibilityAmount?: number | null }) =>
              Number(cl.patientResponsibilityAmount ?? 0) > 0,
          )
          .map((cl: {
            id: string;
            claimNumber?: string | null;
            status?: string | null;
            patientResponsibilityAmount?: number | null;
          }) => ({
            id: String(cl.id),
            claimNumber: cl.claimNumber ?? null,
            status: cl.status ?? null,
            patientResponsibilityAmount: Number(cl.patientResponsibilityAmount ?? 0),
          }));
        setOpenClaims(claims);
      }
    } catch (err) {
      setCreditsError(err instanceof Error ? err.message : "Failed to load credits");
    } finally {
      setCreditsLoading(false);
    }
  }

  function getCreditDraft(creditId: string, defaultAmount: number) {
    return (
      creditDraft[creditId] ?? {
        mode: "apply" as const,
        target: "invoice" as const,
        invoiceId: "",
        claimId: "",
        amount: defaultAmount > 0 ? defaultAmount.toFixed(2) : "",
        reason: "",
      }
    );
  }

  function updateCreditDraft(
    creditId: string,
    patch: Partial<{
      mode: "apply" | "refund";
      target: "invoice" | "claim";
      invoiceId: string;
      claimId: string;
      amount: string;
      reason: string;
    }>,
    defaultAmount: number,
  ) {
    setCreditDraft((prev) => ({
      ...prev,
      [creditId]: { ...getCreditDraft(creditId, defaultAmount), ...patch },
    }));
  }

  async function submitCreditAction(credit: CreditRow) {
    const balance = Number(credit.balance_amount ?? 0);
    const draft = getCreditDraft(credit.id, balance);
    const amount = Number(draft.amount);
    if (!(amount > 0)) {
      setCreditsMessage("Enter an amount greater than zero.");
      return;
    }
    setCreditBusy(credit.id);
    setCreditsMessage(null);
    setCreditsError(null);
    try {
      const body: Record<string, unknown> = {
        organizationId,
        clientCreditId: credit.id,
        amount,
      };
      if (draft.mode === "refund") {
        body.action = "refund";
        if (!draft.reason.trim()) {
          throw new Error("Enter a refund reason.");
        }
        body.reason = draft.reason.trim();
      } else if (draft.target === "claim") {
        if (!draft.claimId) {
          throw new Error("Choose a claim to apply the credit to.");
        }
        body.action = "apply";
        body.professionalClaimId = draft.claimId;
      } else {
        if (!draft.invoiceId) {
          throw new Error("Choose an invoice to apply the credit to.");
        }
        body.action = "apply";
        body.patientInvoiceId = draft.invoiceId;
      }
      const response = await fetch(
        `/api/billing/clients/${encodeURIComponent(clientId)}/credits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) {
        const errMsg =
          json.error ??
          (Array.isArray(json.errors) && json.errors.length
            ? json.errors.map((e: { message?: string }) => e.message ?? "Error").join("; ")
            : `Request failed (${response.status})`);
        throw new Error(errMsg);
      }
      setCreditsMessage(
        draft.mode === "refund"
          ? `Refund of $${amount.toFixed(2)} recorded${json.refundStatus ? ` (${json.refundStatus})` : ""}.`
          : `Applied $${amount.toFixed(2)} to invoice.`,
      );
      setCreditDraft((prev) => {
        const next = { ...prev };
        delete next[credit.id];
        return next;
      });
      await reloadCredits();
    } catch (err) {
      setCreditsError(err instanceof Error ? err.message : "Credit action failed");
    } finally {
      setCreditBusy(null);
    }
  }

  // Refresh the client summary (insurance policies, demographics, etc.)
  // and the cases list. Called after CasesPanel mutates so the upper
  // "Insurance information" panel reflects newly saved policies.
  async function reloadSummaryAndCases() {
    try {
      const [summaryRes, casesList] = await Promise.all([
        fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" }),
        fetchList<CaseRowSummary>(`/api/clients/${clientId}/cases?organizationId=${encodeURIComponent(organizationId)}`, "cases"),
      ]);
      const summaryJson = (await summaryRes.json().catch(() => ({}))) as PatientSummary;
      if (summaryRes.ok && summaryJson.success) {
        setSummary(summaryJson);
      }
      setCases(casesList);
    } catch {
      // best-effort refresh; CasesPanel surfaces its own save errors
    }
  }

  async function reloadDemoAudit() {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const response = await fetch(`/api/patients/${clientId}/audit?limit=50`, {
        cache: "no-store",
      });
      const json = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        entries?: DemographicAuditEntry[];
      };
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load recent changes.");
      }
      setAuditEntries(json.entries ?? []);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Failed to load recent changes.");
    } finally {
      setAuditLoading(false);
    }
  }

  async function saveDemoEdit() {
    if (!summary?.client) return;
    setDemoSaving(true);
    setDemoError(null);
    setDemoMessage(null);
    try {
      // Only send fields the user actually changed. This avoids re-submitting
      // legacy values for constrained fields (state, sex_at_birth, etc.) that
      // would otherwise be rejected by server validation, and prevents silently
      // clearing a field the user never touched.
      const changed: Record<string, string> = {};
      for (const [field, value] of Object.entries(demoDraft)) {
        if ((demoOriginal[field] ?? "") !== (value ?? "")) {
          changed[field] = value;
        }
      }
      if (Object.keys(changed).length === 0) {
        setDemoMessage("No changes to save.");
        setDemoEditing(false);
        setDemoDraft({});
        setDemoOriginal({});
        return;
      }
      const response = await fetch(`/api/patients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: changed }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to save demographics");
      }
      const summaryResponse = await fetch(
        `/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const refreshed = (await summaryResponse.json()) as PatientSummary;
      if (summaryResponse.ok && refreshed.success) {
        setSummary(refreshed);
      }
      setDemoEditing(false);
      setDemoDraft({});
      setDemoOriginal({});
      setDemoMessage("Demographics saved.");
      void reloadDemoAudit();
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : "Failed to save demographics");
    } finally {
      setDemoSaving(false);
    }
  }

  async function refreshSummary() {
    try {
      const response = await fetch(
        `/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const refreshed = (await response.json()) as PatientSummary;
      if (response.ok && refreshed.success) {
        setSummary(refreshed);
      }
    } catch {
      // best-effort refresh
    }
  }

  function startPolicyEdit(policy: InsurancePolicySummary | null | undefined) {
    if (!policy) return;
    setPolicyEditError(null);
    setPolicyEditId(policy.id);
    const copay = policy.copay_amount;
    setPolicyEditDraft({
      planName: policy.plan_name ?? "",
      payerId: policy.payer_id ?? "",
      policyNumber: policy.policy_number ?? "",
      groupNumber: policy.group_number ?? "",
      effectiveDate: policy.effective_date ?? "",
      terminationDate: policy.termination_date ?? "",
      copayAmount:
        copay === null || copay === undefined || copay === "" ? "" : String(copay),
    });
  }

  function cancelPolicyEdit() {
    setPolicyEditId(null);
    setPolicyEditDraft(null);
    setPolicyEditError(null);
  }

  function updatePolicyDraft(patch: Partial<PolicyEditDraft>) {
    setPolicyEditDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function savePolicyEdit(policy: InsurancePolicySummary) {
    if (!policyEditDraft) return;
    const draft = policyEditDraft;
    const policyNumber = draft.policyNumber.trim();
    if (!policyNumber) {
      setPolicyEditError("Policy number is required");
      return;
    }
    if (!draft.payerId) {
      setPolicyEditError("Payer is required");
      return;
    }
    if (
      draft.effectiveDate &&
      draft.terminationDate &&
      draft.effectiveDate > draft.terminationDate
    ) {
      setPolicyEditError("Effective date must be on or before termination date");
      return;
    }
    if (draft.copayAmount.trim()) {
      const n = Number(draft.copayAmount.trim());
      if (!Number.isFinite(n) || n < 0) {
        setPolicyEditError("Copay must be a non-negative number");
        return;
      }
    }
    setPolicySavingId(policy.id);
    setPolicyEditError(null);
    try {
      const response = await fetch(
        `/api/clients/${clientId}/policies/${policy.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            planName: draft.planName.trim() || null,
            payerId: draft.payerId,
            policyNumber,
            groupNumber: draft.groupNumber.trim() || null,
            effectiveDate: draft.effectiveDate.trim() || null,
            terminationDate: draft.terminationDate.trim() || null,
            copayAmount: draft.copayAmount.trim() || null,
          }),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to update policy");
      }
      await refreshSummary();
      void reloadDemoAudit();
      cancelPolicyEdit();
      if (json.eligibilityRefreshSuggested) {
        // Payer / effective / termination just changed — surface a
        // one-click prompt so the latest eligibility check gets re-run
        // against the corrected policy inputs.
        setEligibilityRefreshPolicyId(String(json.policyId ?? policy.id));
        setEligibilityRefreshError(null);
        setEligibilityRefreshMessage(null);
      }
    } catch (err) {
      setPolicyEditError(err instanceof Error ? err.message : "Failed to update policy");
    } finally {
      setPolicySavingId(null);
    }
  }

  async function runEligibilityRefresh(policyId: string) {
    setEligibilityRefreshBusy(true);
    setEligibilityRefreshError(null);
    setEligibilityRefreshMessage(null);
    try {
      const response = await fetch(`/api/clearinghouse/eligibility/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: clientId,
          insurancePolicyId: policyId,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to refresh eligibility");
      }
      await refreshSummary();
      setEligibilityRefreshPolicyId(null);
      setEligibilityRefreshMessage("Eligibility refreshed.");
    } catch (err) {
      setEligibilityRefreshError(
        err instanceof Error ? err.message : "Failed to refresh eligibility",
      );
    } finally {
      setEligibilityRefreshBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    (async () => {
      const payers = await fetchList<PayerOption>(
        `/api/insurance-payers?organizationId=${encodeURIComponent(organizationId)}`,
        "payers",
      );
      if (!cancelled) setPayerOptions(payers);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;

    async function loadClient() {
      if (!organizationId) {
        // Should not happen in practice — the server now resolves the org from
        // the authenticated session and falls back to ORGANIZATION_ID. Leave a
        // gentler message in case both resolution paths somehow fail.
        setError("Could not determine your organization. Please sign in again.");
        setLoading(false);
        return;
      }

      try {
        const summaryResponse = await fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const summaryJson = (await summaryResponse.json()) as PatientSummary;
        if (!summaryResponse.ok || !summaryJson.success) throw new Error(summaryJson.error ?? "Failed to load client chart");

        const [appointments, conditions, claims, notes, documents, mailroomItems, casesList, clinicians] = await Promise.all([
          fetchList<AppointmentSummary>(`/api/patients/${clientId}/appointments?organizationId=${encodeURIComponent(organizationId)}`, "appointments"),
          fetchList<ConditionSummary>(`/api/patients/${clientId}/conditions?organizationId=${encodeURIComponent(organizationId)}`, "conditions"),
          fetchList<ClaimSummary>(`/api/patients/${clientId}/claims?organizationId=${encodeURIComponent(organizationId)}`, "claims"),
          fetchList<NoteSummary>(`/api/patients/${clientId}/notes?organizationId=${encodeURIComponent(organizationId)}`, "notes"),
          fetchList<DocumentSummary>(`/api/patients/${clientId}/documents?organizationId=${encodeURIComponent(organizationId)}`, "documents"),
          fetchList<MailroomSummary>(`/api/mailroom/items?organizationId=${encodeURIComponent(organizationId)}&clientId=${encodeURIComponent(clientId)}&status=all&limit=10`, "items"),
          fetchList<CaseRowSummary>(`/api/clients/${clientId}/cases?organizationId=${encodeURIComponent(organizationId)}`, "cases"),
          fetchList<ClinicianOption>(`/api/users/clinicians?organizationId=${encodeURIComponent(organizationId)}`, "clinicians"),
        ]);

        if (cancelled) return;

        setSummary(summaryJson);
        setCases(casesList);
        setClinicianOptions(clinicians);
        setDetails({
          appointments,
          conditions,
          claims,
          notes,
          documents,
          mailroomItems,
        });
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load client chart");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function loadJournalHighlights() {
      if (!organizationId) return;
      setJournalHighlightsLoading(true);
      try {
        const res = await fetch(
          `/api/clients/${encodeURIComponent(clientId)}/journal?organizationId=${encodeURIComponent(organizationId)}&windowSinceLastSigned=1`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          success?: boolean;
          since?: string | null;
          entries?: JournalEntry[];
        };
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setJournalHighlights({ since: null, total: 0, counts: {} });
          return;
        }
        const entries = json.entries ?? [];
        const counts: Partial<Record<EntryType, number>> = {};
        for (const e of entries) {
          counts[e.entryType] = (counts[e.entryType] ?? 0) + 1;
        }
        setJournalHighlights({
          since: json.since ?? null,
          total: entries.length,
          counts,
        });
      } catch {
        if (!cancelled) setJournalHighlights({ since: null, total: 0, counts: {} });
      } finally {
        if (!cancelled) setJournalHighlightsLoading(false);
      }
    }

    void loadClient();
    void loadJournalHighlights();
    void reloadDemoAudit();
    void reloadCredits();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, organizationId]);

  const client = summary?.client;
  const latestEligibility = summary?.insurance?.latestEligibility ?? null;
  const policies = summary?.insurance?.policies ?? [];
  const workqueueItems = summary?.workqueueItems ?? [];

  const deniedOrRejectedCount = details.claims.filter((claim) => {
    const status = String(claim.status ?? "").toLowerCase();
    return status.includes("denied") || status.includes("rejected");
  }).length;

  const alerts: string[] = [];
  if (!latestEligibility) alerts.push("No recent eligibility check on file.");
  if (latestEligibility && String(latestEligibility.eligibility_status ?? "").toLowerCase().includes("inactive")) {
    alerts.push("Coverage is marked inactive. Verify eligibility before next visit.");
  }
  if ((summary?.balance?.total ?? 0) > 0) alerts.push("Outstanding client balance requires follow-up.");
  if (deniedOrRejectedCount > 0) alerts.push(`${deniedOrRejectedCount} denied/rejected claim(s) need billing action.`);
  if (workqueueItems.length > 0) alerts.push(`${workqueueItems.length} open workqueue item(s) linked to this client.`);

  const orgQ = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  if (loading) return <div className="empty-state">Loading client chart…</div>;
  if (error) return <div className="alert-panel">{error}</div>;
  if (!client) return <div className="alert-panel">Client record not found.</div>;

  const dash = "—";
  const dashIfNullish = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return dash;
    return String(value);
  };
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const formatMoneyOrDash = (v: unknown): string => {
    const n = numOrNull(v);
    return n === null ? dash : n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  };

  const primaryPolicy = policies.find((p) => p.priority === "primary") ?? policies[0] ?? null;
  const secondaryPolicy = policies.find((p) => p.priority === "secondary") ?? null;
  const eligibilityCopay = numOrNull(latestEligibility?.copay_amount);
  const policyCopay = numOrNull(primaryPolicy?.copay_amount);
  const copay = eligibilityCopay ?? policyCopay;
  const deductibleRemaining = numOrNull(latestEligibility?.deductible_remaining);
  const previousBalance = numOrNull(summary?.balance?.total);
  const creditOnAccount = numOrNull(summary?.creditOnAccount);
  const totalDue =
    (copay ?? 0) + (deductibleRemaining ?? 0) + (previousBalance ?? 0) - (creditOnAccount ?? 0);
  const hasAnyTotalInput =
    copay !== null || deductibleRemaining !== null || previousBalance !== null;
  const cityStateZip = [
    [client.city, formatStateForDisplay(client.state)].filter(Boolean).join(", "),
    client.postalCode ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const addressLine2 = client.addressLine2 ?? "";
  const formattedAddress = [client.addressLine1, addressLine2, cityStateZip]
    .filter((s) => s && s.length > 0)
    .join(" · ");
  const assignedClinicianName = (() => {
    const providerId = String(client.primaryProviderId ?? "").trim();
    if (!providerId) return null;
    return clinicianOptions.find((c) => c.providerId === providerId)?.displayName ?? providerId;
  })();

  const railActions: Array<{ key: string; label: string; href: string }> = [
    { key: "notes", label: "Notes", href: `/clients/${client.id}/notes${orgQ}` },
    { key: "portal", label: "Portal access", href: `/clients/${client.id}/portal${orgQ}` },
  ];
  const railDisabled: Record<string, boolean> = {};

  return (
    <>
      <section className="summary-shell" aria-label="Client chart summary">
        <aside className="summary-rail" aria-label="Quick actions">
          <h3>Quick actions</h3>
          {railActions.map((action) =>
            railDisabled[action.key] ? (
              <span
                key={action.key}
                className="summary-rail-action"
                aria-disabled="true"
                title="Coming soon"
              >
                {action.label}
              </span>
            ) : (
              <Link key={action.key} href={action.href} className="summary-rail-action">
                {action.label}
              </Link>
            ),
          )}
          <Link
            href={`/clients/${client.id}/intake${orgQ}`}
            className="summary-rail-action"
          >
            Client intake
          </Link>
        </aside>

        <div className="summary-center">
          <section className="summary-block" aria-label="Demographics">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Demographics</h3>
              {demoEditing ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={cancelDemoEdit}
                    disabled={demoSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={saveDemoEdit}
                    disabled={demoSaving}
                  >
                    {demoSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              ) : (
                <button type="button" className="button button-secondary" onClick={startDemoEdit}>
                  Edit
                </button>
              )}
            </div>
            {demoError ? (
              <div className="alert-panel" role="alert" style={{ marginBottom: 8 }}>
                {demoError}
              </div>
            ) : null}
            {demoMessage && !demoEditing ? (
              <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
                {demoMessage}
              </div>
            ) : null}
            {demoEditing ? (
              <div className="summary-form-grid">
                <div className="summary-field">
                  <label htmlFor="demo-preferredName">Preferred name</label>
                  <input
                    id="demo-preferredName"
                    type="text"
                    value={demoDraft.preferredName ?? ""}
                    onChange={(e) => setDemoField("preferredName", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-mrn">MRN</label>
                  <input
                    id="demo-mrn"
                    type="text"
                    value={demoDraft.mrn ?? ""}
                    onChange={(e) => setDemoField("mrn", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-firstName">First</label>
                  <input
                    id="demo-firstName"
                    type="text"
                    value={demoDraft.firstName ?? ""}
                    onChange={(e) => setDemoField("firstName", e.target.value)}
                    required
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-lastName">Last</label>
                  <input
                    id="demo-lastName"
                    type="text"
                    value={demoDraft.lastName ?? ""}
                    onChange={(e) => setDemoField("lastName", e.target.value)}
                    required
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-middleName">Middle</label>
                  <input
                    id="demo-middleName"
                    type="text"
                    value={demoDraft.middleName ?? ""}
                    onChange={(e) => setDemoField("middleName", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-dateOfBirth">DOB</label>
                  <input
                    id="demo-dateOfBirth"
                    type="date"
                    value={demoDraft.dateOfBirth ?? ""}
                    onChange={(e) => setDemoField("dateOfBirth", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-sexAtBirth">Sex at birth</label>
                  <select
                    id="demo-sexAtBirth"
                    value={SEX_AT_BIRTH_VALUES.has(demoDraft.sexAtBirth ?? "") ? demoDraft.sexAtBirth ?? "" : ""}
                    onChange={(e) => setDemoField("sexAtBirth", e.target.value)}
                  >
                    <option value="">—</option>
                    {SEX_AT_BIRTH_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const split = splitPickerValue(
                    demoDraft.genderIdentity,
                    GENDER_IDENTITY_VALUES,
                    GENDER_IDENTITY_FREE_TEXT_PREFIX,
                  );
                  return (
                    <div className="summary-field">
                      <label htmlFor="demo-genderIdentity">Gender</label>
                      <select
                        id="demo-genderIdentity"
                        value={split.choice}
                        onChange={(e) =>
                          setDemoField(
                            "genderIdentity",
                            combinePickerValue(e.target.value, split.other, GENDER_IDENTITY_FREE_TEXT_PREFIX),
                          )
                        }
                      >
                        <option value="">—</option>
                        {GENDER_IDENTITY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      {split.choice === "other" ? (
                        <input
                          type="text"
                          placeholder="Please specify"
                          value={split.other}
                          onChange={(e) =>
                            setDemoField(
                              "genderIdentity",
                              combinePickerValue("other", e.target.value, GENDER_IDENTITY_FREE_TEXT_PREFIX),
                            )
                          }
                          style={{ marginTop: 4 }}
                        />
                      ) : null}
                    </div>
                  );
                })()}
                <div className="summary-field summary-field-wide">
                  <label htmlFor="demo-addressLine1">Address line 1</label>
                  <input
                    id="demo-addressLine1"
                    type="text"
                    value={demoDraft.addressLine1 ?? ""}
                    onChange={(e) => setDemoField("addressLine1", e.target.value)}
                  />
                </div>
                <div className="summary-field summary-field-wide">
                  <label htmlFor="demo-addressLine2">Address line 2</label>
                  <input
                    id="demo-addressLine2"
                    type="text"
                    value={demoDraft.addressLine2 ?? ""}
                    onChange={(e) => setDemoField("addressLine2", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-city">City</label>
                  <input
                    id="demo-city"
                    type="text"
                    value={demoDraft.city ?? ""}
                    onChange={(e) => setDemoField("city", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-state">State</label>
                  <select
                    id="demo-state"
                    value={US_STATE_CODES.has((demoDraft.state ?? "").toUpperCase()) ? (demoDraft.state ?? "").toUpperCase() : ""}
                    onChange={(e) => setDemoField("state", e.target.value)}
                  >
                    <option value="">—</option>
                    {US_STATE_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.code}>{opt.code} — {opt.name}</option>
                    ))}
                  </select>
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-postalCode">Postal code</label>
                  <input
                    id="demo-postalCode"
                    type="text"
                    value={demoDraft.postalCode ?? ""}
                    onChange={(e) => setDemoField("postalCode", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-phone">Home phone</label>
                  <input
                    id="demo-phone"
                    type="tel"
                    value={demoDraft.phone ?? ""}
                    onChange={(e) => setDemoField("phone", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-email">Email</label>
                  <input
                    id="demo-email"
                    type="email"
                    value={demoDraft.email ?? ""}
                    onChange={(e) => setDemoField("email", e.target.value)}
                  />
                </div>
                {(() => {
                  const split = splitPickerValue(
                    demoDraft.preferredLanguage,
                    PREFERRED_LANGUAGE_VALUES,
                    PREFERRED_LANGUAGE_FREE_TEXT_PREFIX,
                  );
                  return (
                    <div className="summary-field">
                      <label htmlFor="demo-preferredLanguage">Language</label>
                      <select
                        id="demo-preferredLanguage"
                        value={split.choice}
                        onChange={(e) =>
                          setDemoField(
                            "preferredLanguage",
                            combinePickerValue(e.target.value, split.other, PREFERRED_LANGUAGE_FREE_TEXT_PREFIX),
                          )
                        }
                      >
                        <option value="">—</option>
                        {PREFERRED_LANGUAGE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      {split.choice === "other" ? (
                        <input
                          type="text"
                          placeholder="Please specify"
                          value={split.other}
                          onChange={(e) =>
                            setDemoField(
                              "preferredLanguage",
                              combinePickerValue("other", e.target.value, PREFERRED_LANGUAGE_FREE_TEXT_PREFIX),
                            )
                          }
                          style={{ marginTop: 4 }}
                        />
                      ) : null}
                    </div>
                  );
                })()}
                <div className="summary-field">
                  <label htmlFor="demo-sourceClientId">Source client ID</label>
                  <input
                    id="demo-sourceClientId"
                    type="text"
                    value={demoDraft.sourceClientId ?? ""}
                    onChange={(e) => setDemoField("sourceClientId", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-primaryProviderId">Assigned clinician</label>
                  <select
                    id="demo-primaryProviderId"
                    value={demoDraft.primaryProviderId ?? ""}
                    onChange={(e) => setDemoField("primaryProviderId", e.target.value)}
                  >
                    <option value="">—</option>
                    {clinicianOptions.map((option) => (
                      <option key={option.providerId} value={option.providerId}>{option.displayName}</option>
                    ))}
                  </select>
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-emergencyContactName">Emergency contact</label>
                  <input
                    id="demo-emergencyContactName"
                    type="text"
                    value={demoDraft.emergencyContactName ?? ""}
                    onChange={(e) => setDemoField("emergencyContactName", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label htmlFor="demo-emergencyContactPhone">Emergency phone</label>
                  <input
                    id="demo-emergencyContactPhone"
                    type="tel"
                    value={demoDraft.emergencyContactPhone ?? ""}
                    onChange={(e) => setDemoField("emergencyContactPhone", e.target.value)}
                  />
                </div>
                <div className="summary-field">
                  <label>Client ID</label>
                  <span>{client.id}</span>
                </div>
              </div>
            ) : (
              <div className="summary-form-grid">
                <div className="summary-field">
                  <label>Initial</label>
                  <span>{dashIfNullish(client.preferredName ?? client.firstName)}</span>
                </div>
                <div className="summary-field">
                  <label>MRN</label>
                  <span>{dashIfNullish(client.mrn)}</span>
                </div>
                <div className="summary-field">
                  <label>First</label>
                  <span>{dashIfNullish(client.firstName)}</span>
                </div>
                <div className="summary-field">
                  <label>Last</label>
                  <span>{dashIfNullish(client.lastName)}</span>
                </div>
                <div className="summary-field">
                  <label>Middle</label>
                  <span>{dashIfNullish(client.middleName)}</span>
                </div>
                <div className="summary-field">
                  <label>DOB</label>
                  <span>{client.dateOfBirth ? formatDate(client.dateOfBirth) : dash}</span>
                </div>
                <div className="summary-field">
                  <label>Sex at birth</label>
                  <span>{dashIfNullish(formatSexAtBirth(client.sexAtBirth))}</span>
                </div>
                <div className="summary-field">
                  <label>Gender</label>
                  <span>{dashIfNullish(formatGenderIdentity(client.genderIdentity) ?? client.pronouns)}</span>
                </div>
                <div className="summary-field summary-field-wide">
                  <label>Address</label>
                  <span>{formattedAddress || dash}</span>
                </div>
                <div className="summary-field">
                  <label>Home phone</label>
                  <span>{dashIfNullish(client.phone)}</span>
                </div>
                <div className="summary-field">
                  <label>Email</label>
                  <span>{dashIfNullish(client.email)}</span>
                </div>
                <div className="summary-field">
                  <label>Language</label>
                  <span>{dashIfNullish(formatPreferredLanguage(client.preferredLanguage))}</span>
                </div>
                <div className="summary-field">
                  <label>Source client ID</label>
                  <span>{dashIfNullish(client.sourceClientId)}</span>
                </div>
                <div className="summary-field">
                  <label>Assigned clinician</label>
                  <span>{dashIfNullish(assignedClinicianName)}</span>
                </div>
                <div className="summary-field">
                  <label>Emergency contact</label>
                  <span>{dashIfNullish(client.emergencyContactName)}</span>
                </div>
                <div className="summary-field">
                  <label>Emergency phone</label>
                  <span>{dashIfNullish(client.emergencyContactPhone)}</span>
                </div>
                <div className="summary-field">
                  <label>Client ID</label>
                  <span>{client.id}</span>
                </div>
              </div>
            )}

            <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h4 style={{ margin: 0, fontSize: 14 }}>
                  Recent changes{auditEntries.length > 0 ? ` (${auditEntries.length})` : ""}
                </h4>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void reloadDemoAudit()}
                    disabled={auditLoading}
                  >
                    {auditLoading ? "Loading…" : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setAuditExpanded((prev) => !prev)}
                    aria-expanded={auditExpanded}
                  >
                    {auditExpanded ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {auditError ? (
                <div className="alert-panel" role="alert" style={{ marginTop: 8 }}>
                  {auditError}
                </div>
              ) : null}
              {auditExpanded ? (
                auditEntries.length === 0 && !auditLoading ? (
                  <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                    No chart changes recorded yet.
                  </p>
                ) : (
                  <table className="summary-cases-table" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Who</th>
                        <th>Section</th>
                        <th>Field</th>
                        <th>Before</th>
                        <th>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditEntries.map((entry) => {
                        const actor =
                          entry.actorName ||
                          entry.actorEmail ||
                          (entry.userRole ? `(${entry.userRole})` : "System");
                        const section = entry.section ?? entry.objectLabel ?? "Demographics";
                        return (
                          <tr key={entry.id}>
                            <td>{formatDateTime(entry.createdAt)}</td>
                            <td>{actor}</td>
                            <td>{section}</td>
                            <td>{entry.fieldLabel}</td>
                            <td>{entry.beforeValue ?? dash}</td>
                            <td>{entry.afterValue ?? dash}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              ) : null}
            </div>
          </section>

          <section className="summary-block" aria-label="Insurance information">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Insurance information</h3>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setCasesModalOpen(true)}
              >
                Open cases
              </button>
            </div>
            {policyEditError ? <div className="alert-panel">{policyEditError}</div> : null}
            {cases.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No cases on file yet.{" "}
                <a href="#cases-editor">Add a case</a> to start tracking coverage.
              </p>
            ) : (
              <table className="summary-cases-table">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Payer</th>
                    <th>Member ID</th>
                    <th>Copay</th>
                    <th>Active</th>
                    <th aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {((): ReactElement | ReactElement[] => {
                    // Flatten every policy across every active case, dedupe
                    // by policyId, then keep only ones whose matching policy
                    // record is still active. Sort primary → secondary → tertiary.
                    const order = { primary: 0, secondary: 1, tertiary: 2 } as const;
                    const flat = cases
                      .filter((c) => c.activeFlag)
                      .flatMap((c) => c.policies.map((p) => ({ c, p })));
                    const seen = new Set<string>();
                    const activeRows = flat
                      .filter(({ p }) => {
                        const m = policies.find((x) => x.id === p.policyId);
                        return m == null ? true : m.active_flag !== false;
                      })
                      .filter(({ p }) => {
                        if (seen.has(p.policyId)) return false;
                        seen.add(p.policyId);
                        return true;
                      })
                      .sort(
                        (a, b) =>
                          (order[a.p.priority] ?? 9) - (order[b.p.priority] ?? 9),
                      );

                    if (activeRows.length === 0) {
                      return (
                        <tr key="no-active">
                          <td colSpan={6} style={{ color: "var(--muted-color, #6b7280)" }}>
                            No active insurance policies on file.
                          </td>
                        </tr>
                      );
                    }

                    return activeRows.flatMap(({ c, p: casePolicy }) => {
                      const matchingPolicy =
                        policies.find((p) => p.id === casePolicy.policyId) ?? null;
                      const isEditing =
                        matchingPolicy != null && policyEditId === matchingPolicy.id;
                      const policyActive =
                        matchingPolicy == null
                          ? true
                          : matchingPolicy.active_flag !== false;
                      const rows: ReactElement[] = [
                        <tr key={`${c.id}:${casePolicy.policyId}`}>
                          <td style={{ textTransform: "capitalize" }}>{casePolicy.priority}</td>
                          <td>{casePolicy.payerName ?? casePolicy.planName ?? dash}</td>
                          <td>{casePolicy.policyNumber ?? dash}</td>
                          <td>{formatMoneyOrDash(matchingPolicy?.copay_amount ?? null)}</td>
                          <td>
                            <span
                              className={policyActive ? "status status-green" : "status status-yellow"}
                            >
                              {policyActive ? "Yes" : "No"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <span style={{ display: "inline-flex", gap: 6, justifyContent: "flex-end" }}>
                              {matchingPolicy ? (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={() =>
                                    isEditing ? cancelPolicyEdit() : startPolicyEdit(matchingPolicy)
                                  }
                                  aria-label={`${isEditing ? "Close" : "Edit"} ${casePolicy.priority} policy`}
                                >
                                  {isEditing ? "Close" : "Edit policy"}
                                </button>
                              ) : null}
                            </span>
                          </td>
                        </tr>,
                      ];

                      if (isEditing && matchingPolicy && policyEditDraft) {
                        const saving = policySavingId === matchingPolicy.id;
                        rows.push(
                          <tr key={`${c.id}:${casePolicy.policyId}:edit`}>
                            <td colSpan={6} style={{ background: "var(--surface-muted, #f9fafb)" }}>
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                                  gap: 12,
                                  padding: "12px 4px",
                                }}
                              >
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Payer
                                  </span>
                                  <select
                                    value={policyEditDraft.payerId}
                                    onChange={(e) => updatePolicyDraft({ payerId: e.target.value })}
                                    disabled={saving}
                                  >
                                    <option value="">Select a payer…</option>
                                    {payerOptions.some((p) => p.id === policyEditDraft.payerId) ||
                                    !policyEditDraft.payerId ? null : (
                                      <option value={policyEditDraft.payerId}>
                                        {matchingPolicy.payer_name ?? "Current payer"}
                                      </option>
                                    )}
                                    {payerOptions.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.payer_name}
                                        {p.payer_id ? ` (${p.payer_id})` : ""}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Plan name
                                  </span>
                                  <input
                                    type="text"
                                    maxLength={200}
                                    value={policyEditDraft.planName}
                                    onChange={(e) => updatePolicyDraft({ planName: e.target.value })}
                                    disabled={saving}
                                  />
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Policy #
                                  </span>
                                  <input
                                    type="text"
                                    maxLength={80}
                                    value={policyEditDraft.policyNumber}
                                    onChange={(e) =>
                                      updatePolicyDraft({ policyNumber: e.target.value })
                                    }
                                    disabled={saving}
                                    required
                                  />
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Group #
                                  </span>
                                  <input
                                    type="text"
                                    maxLength={80}
                                    value={policyEditDraft.groupNumber}
                                    onChange={(e) =>
                                      updatePolicyDraft({ groupNumber: e.target.value })
                                    }
                                    disabled={saving}
                                  />
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Effective date
                                  </span>
                                  <input
                                    type="date"
                                    value={policyEditDraft.effectiveDate}
                                    onChange={(e) =>
                                      updatePolicyDraft({ effectiveDate: e.target.value })
                                    }
                                    disabled={saving}
                                  />
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Termination date
                                  </span>
                                  <input
                                    type="date"
                                    value={policyEditDraft.terminationDate}
                                    onChange={(e) =>
                                      updatePolicyDraft({ terminationDate: e.target.value })
                                    }
                                    disabled={saving}
                                  />
                                </label>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <span style={{ fontSize: 12, color: "var(--muted-color, #6b7280)" }}>
                                    Copay ($)
                                  </span>
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min={0}
                                    step="0.01"
                                    value={policyEditDraft.copayAmount}
                                    onChange={(e) =>
                                      updatePolicyDraft({ copayAmount: e.target.value })
                                    }
                                    disabled={saving}
                                  />
                                </label>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  justifyContent: "flex-end",
                                  padding: "0 4px 8px",
                                }}
                              >
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  onClick={cancelPolicyEdit}
                                  disabled={saving}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  className="button"
                                  onClick={() => savePolicyEdit(matchingPolicy)}
                                  disabled={saving}
                                >
                                  {saving ? "Saving…" : "Save policy"}
                                </button>
                              </div>
                            </td>
                          </tr>,
                        );
                      }

                      return rows;
                    });
                  })()}
                </tbody>
              </table>
            )}
          </section>

          <section className="summary-block" aria-label="Credit on account">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Credit on account</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong>{formatMoneyOrDash(creditOnAccount)}</strong>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void reloadCredits()}
                  disabled={creditsLoading}
                >
                  {creditsLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </div>
            {creditsError ? (
              <div className="alert-panel" role="alert" style={{ marginBottom: 8 }}>{creditsError}</div>
            ) : null}
            {creditsMessage ? (
              <div className="alert-panel" style={{ marginBottom: 8 }}>{creditsMessage}</div>
            ) : null}
            {credits.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {creditsLoading ? "Loading credits…" : "No unapplied credits on file."}
              </p>
            ) : (
              <table className="summary-cases-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Initial</th>
                    <th>Applied</th>
                    <th>Balance</th>
                    <th>Created</th>
                    <th>Note</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {credits.map((credit) => {
                    const balance = Number(credit.balance_amount ?? 0);
                    const draft = getCreditDraft(credit.id, balance);
                    const busy = creditBusy === credit.id;
                    const sourceLabel = credit.source
                      ? [
                          credit.source.paymentMethod ?? "payment",
                          credit.source.referenceNumber ? `#${credit.source.referenceNumber}` : null,
                          credit.source.paidAt ? formatDate(credit.source.paidAt) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : credit.source_payment_id
                        ? `Payment ${credit.source_payment_id.slice(0, 8)}`
                        : "—";
                    const refundDisabled =
                      draft.mode === "refund" && !(credit.source?.refundable ?? false);
                    return (
                      <tr key={credit.id}>
                        <td>
                          <div>{sourceLabel}</div>
                          {credit.source && !credit.source.refundable ? (
                            <small className="muted">
                              {credit.source.reversedAt
                                ? "Source payment reversed — refund disabled"
                                : "Source payment not posted — refund disabled"}
                            </small>
                          ) : null}
                        </td>
                        <td>{formatMoneyOrDash(credit.initial_amount)}</td>
                        <td>{formatMoneyOrDash(credit.applied_amount)}</td>
                        <td>
                          <strong>{formatMoneyOrDash(balance)}</strong>
                        </td>
                        <td>{credit.created_at ? formatDate(credit.created_at) : dash}</td>
                        <td>{credit.note ?? dash}</td>
                        <td style={{ minWidth: 280 }}>
                          {balance <= 0 ? (
                            <span className="muted">Fully used</span>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <select
                                  value={draft.mode}
                                  onChange={(e) =>
                                    updateCreditDraft(
                                      credit.id,
                                      { mode: e.target.value as "apply" | "refund" },
                                      balance,
                                    )
                                  }
                                  disabled={busy}
                                >
                                  <option value="apply">Apply to invoice</option>
                                  <option value="refund" disabled={!(credit.source?.refundable ?? false)}>
                                    Refund to source
                                  </option>
                                </select>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  max={balance}
                                  value={draft.amount}
                                  onChange={(e) =>
                                    updateCreditDraft(credit.id, { amount: e.target.value }, balance)
                                  }
                                  disabled={busy}
                                  style={{ width: 96 }}
                                  aria-label="Amount"
                                />
                              </div>
                              {draft.mode === "apply" ? (
                                <>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    <select
                                      value={draft.target}
                                      onChange={(e) =>
                                        updateCreditDraft(
                                          credit.id,
                                          { target: e.target.value as "invoice" | "claim" },
                                          balance,
                                        )
                                      }
                                      disabled={busy}
                                      aria-label="Apply to"
                                    >
                                      <option value="invoice">Invoice</option>
                                      <option value="claim">Claim (client resp.)</option>
                                    </select>
                                  </div>
                                  {draft.target === "claim" ? (
                                    <select
                                      value={draft.claimId}
                                      onChange={(e) =>
                                        updateCreditDraft(credit.id, { claimId: e.target.value }, balance)
                                      }
                                      disabled={busy || openClaims.length === 0}
                                      aria-label="Target claim"
                                    >
                                      <option value="">
                                        {openClaims.length === 0
                                          ? "No claims with client responsibility"
                                          : "Select claim…"}
                                      </option>
                                      {openClaims.map((cl) => (
                                        <option key={cl.id} value={cl.id}>
                                          {(cl.claimNumber ?? cl.id.slice(0, 8))} — {cl.patientResponsibilityAmount.toLocaleString(undefined, { style: "currency", currency: "USD" })} resp.
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <select
                                      value={draft.invoiceId}
                                      onChange={(e) =>
                                        updateCreditDraft(credit.id, { invoiceId: e.target.value }, balance)
                                      }
                                      disabled={busy || openInvoices.length === 0}
                                      aria-label="Target invoice"
                                    >
                                      <option value="">
                                        {openInvoices.length === 0
                                          ? "No open invoices"
                                          : "Select invoice…"}
                                      </option>
                                      {openInvoices.map((inv) => (
                                        <option key={inv.id} value={inv.id}>
                                          {(inv.invoiceNumber ?? inv.id.slice(0, 8))} — {inv.balanceAmount.toLocaleString(undefined, { style: "currency", currency: "USD" })} open
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </>
                              ) : (
                                <input
                                  type="text"
                                  placeholder="Refund reason (required)"
                                  value={draft.reason}
                                  onChange={(e) =>
                                    updateCreditDraft(credit.id, { reason: e.target.value }, balance)
                                  }
                                  disabled={busy || refundDisabled}
                                  aria-label="Refund reason"
                                />
                              )}
                              <button
                                type="button"
                                className="button"
                                onClick={() => void submitCreditAction(credit)}
                                disabled={busy || refundDisabled}
                              >
                                {busy
                                  ? "Working…"
                                  : draft.mode === "refund"
                                    ? "Issue refund"
                                    : "Apply credit"}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="summary-block" aria-label="Between-session journal highlights">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Between-session journal</h3>
              <Link
                href={`/clients/${client.id}/journal${orgQ}`}
                className="button button-secondary"
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                Review journal
              </Link>
            </div>
            {journalHighlightsLoading && !journalHighlights ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Loading journal highlights…</p>
            ) : !journalHighlights || journalHighlights.total === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {journalHighlights?.since
                  ? `No new entries since the last signed note (${formatDateTime(journalHighlights.since)}).`
                  : "No journal entries yet."}
              </p>
            ) : (
              <>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  {journalHighlights.since
                    ? `${journalHighlights.total} new entr${journalHighlights.total === 1 ? "y" : "ies"} since the last signed note (${formatDateTime(journalHighlights.since)}).`
                    : `${journalHighlights.total} entr${journalHighlights.total === 1 ? "y" : "ies"} on file — no signed note yet.`}
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {ENTRY_TYPES.filter((t) => (journalHighlights.counts[t] ?? 0) > 0).map((t) => (
                    <li
                      key={t}
                      className="status"
                      style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999 }}
                    >
                      {entryTypeLabel(t)}: <strong>{journalHighlights.counts[t]}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <aside className="summary-financial" aria-label="Client financial summary">
          <section className="summary-financial-section">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Eligibility</h3>
              <Link
                href={`/clients/${client.id}/eligibility${orgQ}`}
                className="button button-secondary"
                style={{ fontSize: 12, padding: "4px 10px" }}
              >
                Eligibility check
              </Link>
            </div>
            <div className="summary-financial-row">
              <span>Status</span>
              <strong className={statusClass(latestEligibility?.eligibility_status)}>
                {latestEligibility?.eligibility_status ?? "not checked"}
              </strong>
            </div>
            <div className="summary-financial-row">
              <span>Last checked</span>
              <strong>
                {latestEligibility?.checked_at ? formatDateTime(latestEligibility.checked_at) : dash}
              </strong>
            </div>
            {eligibilityRefreshPolicyId ? (
              <div
                className="alert-panel"
                style={{ marginTop: 8, fontSize: 13 }}
                role="status"
              >
                <div style={{ marginBottom: 6 }}>
                  Policy details changed. The last eligibility check may be stale.
                </div>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => runEligibilityRefresh(eligibilityRefreshPolicyId)}
                  disabled={eligibilityRefreshBusy}
                >
                  {eligibilityRefreshBusy ? "Refreshing…" : "Refresh eligibility"}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ marginLeft: 6 }}
                  onClick={() => setEligibilityRefreshPolicyId(null)}
                  disabled={eligibilityRefreshBusy}
                >
                  Dismiss
                </button>
                {eligibilityRefreshError ? (
                  <div style={{ marginTop: 6, color: "var(--danger, #b91c1c)" }}>
                    {eligibilityRefreshError}
                  </div>
                ) : null}
              </div>
            ) : eligibilityRefreshMessage ? (
              <div
                className="muted"
                style={{ marginTop: 8, fontSize: 12 }}
                role="status"
              >
                {eligibilityRefreshMessage}
              </div>
            ) : null}
          </section>

          <section className="summary-financial-section">
            <h3>Insurance</h3>
            <div className="summary-financial-row">
              <span>Primary</span>
              <strong>
                {primaryPolicy?.payer_name ?? primaryPolicy?.plan_name ?? dash}
              </strong>
            </div>
            <div className="summary-financial-row">
              <span>Secondary</span>
              <strong>
                {secondaryPolicy?.payer_name ?? secondaryPolicy?.plan_name ?? dash}
              </strong>
            </div>
          </section>

          <section className="summary-financial-section">
            <h3>Collect from client today</h3>
            <div className="summary-financial-row">
              <span>Co-pay for today</span>
              <strong>{formatMoneyOrDash(copay)}</strong>
            </div>
            <div className="summary-financial-row">
              <span>Deductible remaining</span>
              <strong>{formatMoneyOrDash(deductibleRemaining)}</strong>
            </div>
            <div className="summary-financial-row">
              <span>Previous balance</span>
              <strong>{formatMoneyOrDash(previousBalance)}</strong>
            </div>
            <div className="summary-financial-row">
              <span>Credit on account</span>
              <strong>{formatMoneyOrDash(creditOnAccount)}</strong>
            </div>
            <div className="summary-financial-row total">
              <span>Total due</span>
              <strong>{hasAnyTotalInput ? formatMoneyOrDash(totalDue) : dash}</strong>
            </div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
              <Link
                href={`/billing/payments${orgQ}`}
                className="button button-primary"
                style={{ fontSize: 12, padding: "6px 12px" }}
              >
                Enter payment
              </Link>
            </div>
          </section>

          <section className="summary-financial-section">
            <h3>Comments</h3>
            {alerts.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No active chart alerts.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text)" }}>
                {alerts.map((alert) => (
                  <li key={alert} style={{ marginBottom: 4 }}>{alert}</li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </section>

      {/* Client Intake section moved to its own tab at /clients/[id]/intake */}

      <section className="panel" style={{ marginBottom: "16px" }}>
        <h2>Mailroom Documents</h2>
        {(() => {
          const mailroomDocs = details.documents.filter((d) => !!d.mailroomItemId);
          if (mailroomDocs.length === 0) {
            return (
              <p className="muted" style={{ margin: 0 }}>
                No mailroom documents have been filed to this client yet.
              </p>
            );
          }
          return (
            <table className="data-table">
              <thead>
                <tr>
                  <th>File / Title</th>
                  <th>Type</th>
                  <th>Filed</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {mailroomDocs.map((doc) => {
                  const href = doc.mailroomItemId
                    ? `/mailroom/${doc.mailroomItemId}?organizationId=${encodeURIComponent(organizationId)}`
                    : null;
                  return (
                    <tr key={doc.id}>
                      <td>
                        <strong>{doc.title ?? doc.fileName ?? "Untitled"}</strong>
                        {doc.title && doc.fileName ? (
                          <div className="muted" style={{ fontSize: 12 }}>{doc.fileName}</div>
                        ) : null}
                      </td>
                      <td>{doc.type ?? dash}</td>
                      <td>{doc.filedAt ? formatDate(doc.filedAt) : (doc.createdAt ? formatDate(doc.createdAt) : dash)}</td>
                      <td style={{ textAlign: "right" }}>
                        {href ? (
                          <Link className="button button-secondary" href={href}>Open</Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        })()}
      </section>

      {casesModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cases"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCasesModalOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "48px 16px",
            zIndex: 1000,
            overflowY: "auto",
          }}
        >
          <div
            className="panel"
            style={{
              background: "var(--surface-color, #fff)",
              borderRadius: 8,
              width: "min(1100px, 100%)",
              maxHeight: "calc(100vh - 96px)",
              overflowY: "auto",
              padding: 20,
              boxShadow: "0 20px 50px rgba(15, 23, 42, 0.25)",
              position: "relative",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Cases</h2>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setCasesModalOpen(false)}
                aria-label="Close cases"
              >
                Close
              </button>
            </div>
            <CasesPanel
              clientId={client.id}
              organizationId={organizationId}
              availablePolicies={policies.map((p) => ({
                id: p.id,
                plan_name: p.plan_name ?? null,
                policy_number: p.policy_number ?? null,
                priority: p.priority ?? null,
                payer_name: p.payer_name ?? null,
              }))}
              onMutate={() => {
                void reloadSummaryAndCases();
                void reloadDemoAudit();
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
