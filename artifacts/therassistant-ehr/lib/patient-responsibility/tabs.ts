export type PatientResponsibilityTab =
  | "ready_for_invoice"
  | "needs_review"
  | "deductible"
  | "copay"
  | "coinsurance"
  | "noncovered";

export const PATIENT_RESPONSIBILITY_TABS: Array<{
  id: PatientResponsibilityTab;
  label: string;
}> = [
  { id: "ready_for_invoice", label: "Ready for Invoice" },
  { id: "needs_review", label: "Needs Review" },
  { id: "deductible", label: "Deductible" },
  { id: "copay", label: "Copay" },
  { id: "coinsurance", label: "Coinsurance" },
  { id: "noncovered", label: "Noncovered" },
];
