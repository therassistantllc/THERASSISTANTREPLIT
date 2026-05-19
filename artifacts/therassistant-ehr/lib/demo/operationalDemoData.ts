// File: lib/demo/operationalDemoData.ts

export const demoOperationalData = {
  appointments: [
    {
      id: "demo-appt-001",
      time: "9:00 AM",
      clientName: "Jordan Miles",
      provider: "Dr. Avery Stone",
      appointmentType: "Telehealth psychotherapy",
      eligibilityLabel: "Active · $20 copay",
      eligibilitySeverity: "low",
      balanceLabel: "$20 due today",
      noteStatus: "Pre-check complete",
      patientId: "demo-client-001",
    },
    {
      id: "demo-appt-002",
      time: "10:30 AM",
      clientName: "Maya Chen",
      provider: "Lena Brooks, LPC",
      appointmentType: "In-office therapy",
      eligibilityLabel: "Needs verification",
      eligibilitySeverity: "medium",
      balanceLabel: "$0 balance",
      noteStatus: "Note not started",
      patientId: "demo-client-002",
    },
    {
      id: "demo-appt-003",
      time: "1:00 PM",
      clientName: "Sam Rivera",
      provider: "Noah Patel, LCSW",
      appointmentType: "Telehealth intake",
      eligibilityLabel: "Inactive response",
      eligibilitySeverity: "high",
      balanceLabel: "$145 insurance balance",
      noteStatus: "Assessment needed",
      patientId: "demo-client-003",
    },
  ],

  claims: [
    {
      id: "demo-claim-001",
      claim_number: "CLM-10021",
      clientName: "Jordan Miles",
      payerName: "Colorado Access",
      claim_status: "no_response",
      statusLabel: "No response · 34 days",
      priority: "high",
      total_charge_amount: 185,
      reason: "No 277/835 received after submission window.",
      href: "/claims/demo-claim-001",
    },
    {
      id: "demo-claim-002",
      claim_number: "CLM-10022",
      clientName: "Sam Rivera",
      payerName: "CCHA",
      claim_status: "rejected",
      statusLabel: "Rejected · subscriber mismatch",
      priority: "urgent",
      total_charge_amount: 240,
      reason: "Eligibility response does not match subscriber demographics.",
      href: "/claims/demo-claim-002",
    },
  ],

  workqueueItems: [
    {
      id: "demo-work-001",
      title: "Resolve rejected CCHA claim",
      work_type: "denial_followup",
      priority: "urgent",
      description: "Subscriber mismatch; verify member ID before resubmission.",
      href: "/billing/workqueue",
    },
    {
      id: "demo-work-002",
      title: "Run eligibility before 10:30 AM visit",
      work_type: "eligibility_needed",
      priority: "medium",
      description: "Coverage has not been verified in the last 30 days.",
      href: "/billing/workqueue",
    },
  ],

  eligibilityChecks: [
    {
      id: "demo-elig-001",
      clientName: "Maya Chen",
      payerName: "Carelon / Anthem",
      status: "not_checked",
      eligibility_status: "not_checked",
      label: "Not checked · appointment today",
      severity: "medium",
      message: "Run realtime eligibility before the 10:30 AM visit.",
      href: "/insurance/eligibility",
    },
    {
      id: "demo-elig-002",
      clientName: "Sam Rivera",
      payerName: "CCHA",
      status: "inactive",
      eligibility_status: "inactive",
      label: "Inactive · needs review",
      severity: "high",
      message: "Route to biller before claim creation.",
      href: "/insurance/eligibility",
    },
  ],

  supportTickets: [
    {
      id: "demo-ticket-001",
      title: "Client uploaded new Medicaid card",
      priority: "medium",
      status: "open",
      description: "Update policy and rerun eligibility before next session.",
      href: "/tickets",
    },
  ],

  clearinghouseActivity: [
    {
      id: "demo-ch-001",
      label: "Office Ally not connected",
      status: "configuration_needed",
      severity: "medium",
      message: "Demo mode is active. Add OFFICE_ALLY_EDI_API_KEY to enable live checks.",
      created_at: new Date().toISOString(),
    },
    {
      id: "demo-ch-002",
      label: "Demo eligibility check available",
      status: "demo_ready",
      severity: "low",
      message: "Buttons can simulate eligibility until live credentials are configured.",
      created_at: new Date().toISOString(),
    },
  ],

  patientBalanceQueue: [
    {
      id: "demo-bal-001",
      clientName: "Jordan Miles",
      balanceLabel: "$20 due today",
      priority: "low",
      message: "Collect copay from appointment card.",
      href: "/clients/demo-client-001/patient-billing",
    },
  ],
};
