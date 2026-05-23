// File: lib/dashboard/homeData.ts
import { canonicalSeed } from "@/lib/canonical-ehr/seed";
import { demoOperationalData } from "@/lib/demo/operationalDemoData";

type DashboardRole =
  | "admin_biller"
  | "clinician"
  | "credentialing"
  | "owner_executive";

// Work/queue type values that represent clinical work (notes, signatures,
// chart review, intake follow-ups, etc.). Anything not in this set is treated
// as a billing/revenue-cycle item and is excluded from the Home dashboard so
// clinicians only see work they can actually act on. Billing items continue
// to surface in the Billing area unchanged.
const CLINICAL_WORK_TYPES = new Set<string>([
  "documentation_hold",
  "documentation_needed",
  "note_signature_needed",
  "signature_needed",
  "chart_review",
  "clinical_review",
  "intake_review",
  "intake_followup",
  "intake_follow_up",
  "phq_high_risk",
  "clinical_alert",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isClinicalWorkqueueItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const candidates = [item.queue_type, item.work_type, item.workType, item.category]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
  if (candidates.length === 0) return false;
  return candidates.some((value) => CLINICAL_WORK_TYPES.has(value));
}

function getHomeDashboardData() {
  const hasSeedData = (canonicalSeed.appointments?.length ?? 0) > 0;

  if (!hasSeedData) {
    return {
      appointments: demoOperationalData.appointments,
      claims: demoOperationalData.claims,
      workqueueItems: demoOperationalData.workqueueItems.filter(isClinicalWorkqueueItem),
      eligibilityChecks: demoOperationalData.eligibilityChecks,
      supportTickets: demoOperationalData.supportTickets,
      clearinghouseActivity: demoOperationalData.clearinghouseActivity,
      patientBalanceQueue: demoOperationalData.patientBalanceQueue,
    };
  }

  return {
    appointments: canonicalSeed.appointments ?? [],
    claims: canonicalSeed.claims ?? [],
    workqueueItems: (canonicalSeed.workqueue_items ?? []).filter(isClinicalWorkqueueItem),
    eligibilityChecks: canonicalSeed.eligibility_checks ?? [],
    supportTickets: canonicalSeed.support_tickets ?? [],
    clearinghouseActivity: [],
    patientBalanceQueue: [],
  };
}

export function buildHomeDashboardPayload(role: string) {
  const safeRole = normalizeRole(role);
  const data = getHomeDashboardData();

  return {
    role: safeRole,
    organization: {
      id: "demo-org",
      name: "THERASSISTANT Demo Organization",
    },

    commandBarMetrics: [
      {
        key: "today_schedule",
        label: "Today",
        value: data.appointments.length,
        href: "/scheduling",
      },
      {
        key: "clients",
        label: "Clients",
        value: data.appointments.length,
        href: "/clients",
      },
      {
        key: "encounters",
        label: "Encounters",
        value: data.appointments.length,
        href: "/encounters",
      },
      {
        key: "workqueue",
        label: "Clinical Tasks",
        value: data.workqueueItems.length,
        href: "/workqueue",
      },
      {
        key: "claims",
        label: "Claims",
        value: data.claims.length,
        href: "/claims",
      },
      {
        key: "eligibility",
        label: "Eligibility",
        value: data.eligibilityChecks.length,
        href: "/insurance/eligibility",
      },
      {
        key: "tickets",
        label: "Tickets",
        value: data.supportTickets.length,
        href: "/tickets",
      },
    ],

    todaySchedule: data.appointments,
    revenueCycleSnapshot: buildRevenueCycleSnapshot(data.claims),
    claimsNeedingAttention: data.claims,
    documentationQueue: canonicalSeed.encounters ?? demoOperationalData.appointments,
    eligibilityWatchlist: data.eligibilityChecks,
    patientBalanceQueue: data.patientBalanceQueue,
    tickets: data.supportTickets,
    credentialingTasks: [],
    clearinghouseActivity: data.clearinghouseActivity,
  };
}

function normalizeRole(role: string): DashboardRole {
  if (
    role === "admin_biller" ||
    role === "clinician" ||
    role === "credentialing" ||
    role === "owner_executive"
  ) {
    return role;
  }

  return "admin_biller";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRevenueCycleSnapshot(claims: any[]) {
  const totalCharges = claims.reduce((sum, claim) => {
    const amount =
      Number(claim.total_charge_amount) ||
      Number(claim.totalChargeAmount) ||
      Number(claim.charge_amount) ||
      0;

    return sum + amount;
  }, 0);

  return [
    {
      key: "total_charges",
      label: "Total charges",
      value: totalCharges,
      href: "/claims",
    },
    {
      key: "open_claims",
      label: "Open claims",
      value: claims.length,
      href: "/claims",
    },
    {
      key: "payment_imports",
      label: "Payment imports",
      value: 0,
      href: "/billing/payment-imports",
    },
  ];
}
