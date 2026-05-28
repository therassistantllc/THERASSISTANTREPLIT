/**
 * RBAC Constants & Enums
 * Defines roles, permissions, and their relationships
 */

/**
 * Staff roles supported in the system
 */
export const STAFF_ROLES = {
  ADMIN: "admin",
  CLINICIAN: "clinician",
  BILLER: "biller",
  SUPERVISOR: "supervisor",
  READ_ONLY: "read_only",
  SUPPORT: "support",
} as const;

export type StaffRoleCode = (typeof STAFF_ROLES)[keyof typeof STAFF_ROLES];

/**
 * Permission codes for fine-grained access control
 */
export const PERMISSIONS = {
  // Scheduling & Appointments
  VIEW_CALENDAR: "view_calendar",
  CREATE_APPOINTMENTS: "create_appointments",
  EDIT_APPOINTMENTS: "edit_appointments",
  CANCEL_APPOINTMENTS: "cancel_appointments",
  MANAGE_AVAILABILITY: "manage_availability",

  // Clients
  VIEW_PATIENT_CHART: "view_patient_chart",
  EDIT_PATIENT_DEMOGRAPHICS: "edit_patient_demographics",
  VIEW_PATIENT_BILLING: "view_patient_billing",
  ACCESS_PATIENT_MESSAGES: "access_patient_messages",

  // Clinical Documentation
  CREATE_NOTES: "create_notes",
  EDIT_NOTES: "edit_notes",
  SIGN_NOTES: "sign_notes",
  VIEW_DIAGNOSES: "view_diagnoses",
  EDIT_DIAGNOSES: "edit_diagnoses",

  // Billing & Claims
  VIEW_BILLING: "view_billing",
  POST_PAYMENTS: "post_payments",
  VIEW_CLAIMS: "view_claims",
  SUBMIT_CLAIMS: "submit_claims",
  REVIEW_DENIALS: "review_denials",
  MANAGE_ELIGIBILITY: "manage_eligibility",
  RUN_ELIGIBILITY: "eligibility:run",

  // Work Queue & Operations
  VIEW_WORKQUEUE: "view_workqueue",
  MANAGE_WORKQUEUE: "manage_workqueue",
  PROCESS_PAYMENTS: "process_payments",

  // Administration
  MANAGE_WORK_SCHEDULES: "manage_work_schedules",
  MANAGE_STAFF: "manage_staff",
  MANAGE_USERS: "manage_users",
  MANAGE_ROLES: "manage_roles",
  EDIT_SETTINGS: "edit_settings",
  VIEW_AUDIT_LOGS: "view_audit_logs",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
