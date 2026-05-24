import type { PatientResponsibilityTab } from "./tabs";

export type PatientResponsibilityReason =
  | "deductible"
  | "copay"
  | "coinsurance"
  | "noncovered"
  | "mixed"
  | "unknown";

export interface PrReasonBreakdown {
  deductible: number;
  copay: number;
  coinsurance: number;
  noncovered: number;
  other: number;
}

export interface ExistingPatientBalance {
  currentBalance: number;
  inCollections: boolean;
  lastPaymentAmount: number | null;
  lastPaymentDate: string | null;
  lastStatementDate: string | null;
}

export interface PaymentMethodOnFile {
  hasEmail: boolean;
  hasPhone: boolean;
  hasMailingAddress: boolean;
  portalStatus: string | null;
}

export interface ExistingInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  amount: number;
  balanceAmount: number;
  paidAmount: number;
  createdAt: string;
}

export interface PatientResponsibilityRow {
  /** Stable id (era_claim_payments.id) */
  id: string;
  eraClaimPaymentId: string;

  // Claim / patient
  claimId: string | null;
  claimNumber: string | null;
  clientId: string | null;
  clientName: string;
  payerProfileId: string | null;
  payerName: string;
  appointmentId: string | null;
  providerId: string | null;
  practiceId: string | null;
  dateOfService: string | null;

  // Money
  patientAmount: number;
  totalCharge: number;
  insurancePaid: number;
  contractualAdjustment: number;
  breakdown: PrReasonBreakdown;
  reason: PatientResponsibilityReason;
  reasonLabel: string;
  carcRarcCodes: string[];

  // Invoice
  invoice: ExistingInvoice | null;
  invoiceStatusLabel: string;
  statementDate: string | null;
  autopayStatusLabel: string;
  onHold: boolean;

  // Flow
  eraReceivedAt: string;
  ageDays: number;
  isUrgent: boolean;
  followUpDueAt: string | null;
  assignedBillerId: string | null;
  tabs: PatientResponsibilityTab[];
}

export interface PatientResponsibilityFilters {
  practice?: string;
  clinician?: string;
  client?: string;
  payer?: string;
  dosFrom?: string;
  dosTo?: string;
  status?: string;
  priority?: string;
  minAmount?: string;
  maxAmount?: string;
  agingBucket?: string;
  assignedBiller?: string;
  carcRarc?: string;
  followUpDue?: string;
}

export interface PatientResponsibilityContext {
  eraBreakdown: {
    totalCharge: number;
    allowedAmount: number | null;
    insurancePaid: number;
    contractualAdjustment: number;
    patientResponsibility: number;
    breakdown: PrReasonBreakdown;
    carcCodes: string[];
    rarcCodes: string[];
    serviceLines: Array<{
      cpt: string | null;
      charge: number;
      paid: number;
      patientResp: number;
      adjustments: Array<{ group: string; code: string; amount: number }>;
    }>;
    checkEftNumber: string | null;
    checkIssueDate: string | null;
  };
  reason: {
    primary: PatientResponsibilityReason;
    label: string;
    explanations: string[];
  };
  existingBalance: ExistingPatientBalance | null;
  paymentMethod: PaymentMethodOnFile;
  invoicePreview: {
    invoiceNumberPreview: string;
    amount: number;
    proposedSource: string;
    lineDescription: string;
    clientName: string;
    clientEmail: string | null;
  };
  existingInvoice: ExistingInvoice | null;
}
