import type { NextConfig } from "next";

/**
 * Legacy billing queue routes — all redirect to the unified
 * /billing/claims workspace (Task #771: workflow-centric IA).
 *
 * Source = legacy /billing/<queue> route
 * Target = /billing/claims?tab=<lifecycle>&filter=<chip>
 *
 * Lifecycle tabs: needs_attention, submitted, denials, follow_up,
 * resolutions. Chip ids are declared in components/billing/ClaimsWorkspace.tsx.
 *
 * Payments-class routes (era-import, paper-checks, partial-payments,
 * unposted-payments, vcc, reconciliation-exceptions, payments) live
 * under the Payments nav item and are intentionally NOT redirected.
 *
 * The detail route /billing/claims/[claimId] is excluded (it's the
 * per-claim drill-in for the new workspace, not a legacy queue).
 */
const claimRedirects: Array<{ from: string; tab: string; filter?: string }> = [
  // ── Needs Attention ──────────────────────────────────────────────
  { from: "/billing/charge-capture", tab: "needs_attention" },
  { from: "/billing/documentation-pending", tab: "needs_attention" },
  { from: "/billing/eligibility-issues", tab: "needs_attention" },
  { from: "/billing/authorization-required", tab: "needs_attention" },
  { from: "/billing/provider-enrollment-issues", tab: "needs_attention" },
  { from: "/billing/claim-build-errors", tab: "needs_attention" },
  { from: "/billing/claim-hold", tab: "needs_attention" },
  { from: "/billing/ready-to-generate", tab: "needs_attention" },
  { from: "/billing/duplicate-claim-review", tab: "needs_attention" },
  { from: "/billing/no-response", tab: "needs_attention", filter: "no_payer_response" },
  { from: "/billing/claim-readiness", tab: "needs_attention", filter: "no_payer_response" },
  { from: "/billing/rejections-999", tab: "needs_attention", filter: "no_999" },
  { from: "/billing/rejections-277ca", tab: "needs_attention", filter: "no_277ca" },
  { from: "/billing/claim-edit-dashboard", tab: "needs_attention", filter: "no_277ca" },
  { from: "/billing/timely-filing", tab: "needs_attention", filter: "timely_filing" },
  { from: "/billing/fax-queue", tab: "needs_attention" },
  { from: "/billing/adjustments-review", tab: "needs_attention" },
  { from: "/billing/blocked-claims", tab: "needs_attention" },
  // ── Submitted ────────────────────────────────────────────────────
  { from: "/billing/837p-batches", tab: "submitted" },
  { from: "/billing/batches", tab: "submitted" },
  { from: "/billing/submitted-claims", tab: "submitted" },
  { from: "/billing/payer-received", tab: "submitted", filter: "awaiting_payer" },
  { from: "/billing/transmission-failures", tab: "submitted" },
  // ── Denials ──────────────────────────────────────────────────────
  { from: "/billing/denials", tab: "denials" },
  { from: "/billing/denials-by-carc", tab: "denials", filter: "by_carc" },
  { from: "/billing/denials-by-rarc", tab: "denials", filter: "by_rarc" },
  { from: "/billing/claim-submission", tab: "denials" },
  { from: "/billing/partial-denials", tab: "denials", filter: "partial" },
  { from: "/billing/medical-necessity", tab: "denials", filter: "medical_necessity" },
  { from: "/billing/medical-review", tab: "denials", filter: "medical_necessity" },
  { from: "/billing/aging", tab: "denials" },
  { from: "/billing/payer-rejections", tab: "denials" },
  { from: "/billing/underpayments", tab: "denials", filter: "underpayments" },
  // ── Follow-Up ────────────────────────────────────────────────────
  { from: "/billing/appeals", tab: "follow_up", filter: "appeals" },
  { from: "/billing/corrected-claims", tab: "follow_up", filter: "corrected" },
  { from: "/billing/resubmissions", tab: "follow_up", filter: "resubmissions" },
  { from: "/billing/cob-issues", tab: "follow_up", filter: "cob" },
  { from: "/billing/secondary-billing", tab: "follow_up", filter: "secondary" },
  // ── Resolutions (patient-balance + write-off class) ──────────────
  { from: "/billing/patient-responsibility", tab: "resolutions", filter: "patient_resp" },
  { from: "/billing/patient-billing", tab: "resolutions", filter: "patient_resp" },
  { from: "/billing/bad-debt-review", tab: "resolutions", filter: "bad_debt" },
  { from: "/billing/write-offs", tab: "resolutions", filter: "write_offs" },
  { from: "/billing/credit-balances", tab: "resolutions", filter: "credit_balance" },
  { from: "/billing/recoupments", tab: "resolutions", filter: "recoupments" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins: [
    "*.janeway.replit.dev",
    "*.replit.dev",
    "*.repl.co",
  ],
  async redirects() {
    return claimRedirects.map(({ from, tab, filter }) => {
      const qs = new URLSearchParams();
      qs.set("tab", tab);
      if (filter) qs.set("filter", filter);
      return {
        source: from,
        destination: `/billing/claims?${qs.toString()}`,
        permanent: false,
      };
    });
  },
};

export default nextConfig;

