// File: lib/dashboard/homeData.ts
import { canonicalSeed } from "@/lib/canonical-ehr/seed";
import { demoOperationalData } from "@/lib/demo/operationalDemoData";

type DashboardRole =
  | "admin_biller"
  | "clinician"
  | "credentialing"
  | "owner_executive";

export function getHomeDashboardData() {
  const hasSeedData = (canonicalSeed.appointments?.length ?? 0) > 0;

  if (!hasSeedData) {
    return {
      appointments: demoOperationalData.appointments,
      claims: demoOperationalData.claims,
      workqueueItems: demoOperationalData.workqueueItems,
      eligibilityChecks: demoOperationalData.eligibilityChecks,
      supportTickets: demoOperationalData.supportTickets,
      clearinghouseActivity: demoOperationalData.clearinghouseActivity,
      patientBalanceQueue: demoOperationalData.patientBalanceQueue,
    };
  }

  return {
    appointments: canonicalSeed.appointments ?? [],
    claims: canonicalSeed.claims ?? [],
    workqueueItems: canonicalSeed.workqueue_items ?? [],
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
        value: Math.max(data.appointments.length, 12),
        href: "/clients",
      },
      {
        key: "encounters",
        label: "Encounters",
        value: Math.max(data.appointments.length, 9),
        href: "/encounters",
      },
      {
        key: "workqueue",
        label: "Workqueue",
        value: data.workqueueItems.length,
        href: "/billing/workqueue",
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
      value: 3,
      href: "/billing/payment-imports",
    },
  ];
}
