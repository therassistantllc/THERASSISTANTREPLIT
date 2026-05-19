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

export const STAFF_ROLE_LABELS: Record<StaffRoleCode, string> = {
  admin: "Administrator",
  clinician: "Clinician",
  biller: "Biller",
  supervisor: "Supervisor",
  read_only: "Read-Only Access",
  support: "Support Staff",
};

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

  // Patients
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

export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  // Scheduling
  view_calendar: "View Calendar",
  create_appointments: "Create Appointments",
  edit_appointments: "Edit Appointments",
  cancel_appointments: "Cancel Appointments",
  manage_availability: "Manage Availability",

  // Patients
  view_patient_chart: "View Patient Chart",
  edit_patient_demographics: "Edit Patient Demographics",
  view_patient_billing: "View Patient Billing Info",
  access_patient_messages: "Access Patient Messages",

  // Clinical
  create_notes: "Create Clinical Notes",
  edit_notes: "Edit Clinical Notes",
  sign_notes: "Sign Clinical Notes",
  view_diagnoses: "View Diagnoses",
  edit_diagnoses: "Edit Diagnoses",

  // Billing
  view_billing: "View Billing",
  post_payments: "Post Payments",
  view_claims: "View Claims",
  submit_claims: "Submit Claims",
  review_denials: "Review Denials",
  manage_eligibility: "Manage Eligibility",

  // Operations
  view_workqueue: "View Work Queue",
  manage_workqueue: "Manage Work Queue",
  process_payments: "Process Payments",

  // Admin
  manage_work_schedules: "Manage Work Schedules",
  manage_staff: "Manage Staff",
  manage_users: "Manage Users",
  manage_roles: "Manage Roles",
  edit_settings: "Edit Settings",
  view_audit_logs: "View Audit Logs",
};

/**
 * Default role-permission mappings
 * Maps each role to its included permissions
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<StaffRoleCode, PermissionCode[]> = {
  admin: [
    // Full access to everything
    PERMISSIONS.VIEW_CALENDAR,
    PERMISSIONS.CREATE_APPOINTMENTS,
    PERMISSIONS.EDIT_APPOINTMENTS,
    PERMISSIONS.CANCEL_APPOINTMENTS,
    PERMISSIONS.MANAGE_AVAILABILITY,
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS,
    PERMISSIONS.VIEW_PATIENT_BILLING,
    PERMISSIONS.ACCESS_PATIENT_MESSAGES,
    PERMISSIONS.CREATE_NOTES,
    PERMISSIONS.EDIT_NOTES,
    PERMISSIONS.SIGN_NOTES,
    PERMISSIONS.VIEW_DIAGNOSES,
    PERMISSIONS.EDIT_DIAGNOSES,
    PERMISSIONS.VIEW_BILLING,
    PERMISSIONS.POST_PAYMENTS,
    PERMISSIONS.VIEW_CLAIMS,
    PERMISSIONS.SUBMIT_CLAIMS,
    PERMISSIONS.REVIEW_DENIALS,
    PERMISSIONS.MANAGE_ELIGIBILITY,
    PERMISSIONS.VIEW_WORKQUEUE,
    PERMISSIONS.MANAGE_WORKQUEUE,
    PERMISSIONS.PROCESS_PAYMENTS,
    PERMISSIONS.MANAGE_WORK_SCHEDULES,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_ROLES,
    PERMISSIONS.EDIT_SETTINGS,
    PERMISSIONS.VIEW_AUDIT_LOGS,
  ],

  clinician: [
    // Clinical staff can schedule, view patients, create/sign notes, view billing
    PERMISSIONS.VIEW_CALENDAR,
    PERMISSIONS.CREATE_APPOINTMENTS,
    PERMISSIONS.EDIT_APPOINTMENTS,
    PERMISSIONS.CANCEL_APPOINTMENTS,
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS,
    PERMISSIONS.VIEW_PATIENT_BILLING,
    PERMISSIONS.ACCESS_PATIENT_MESSAGES,
    PERMISSIONS.CREATE_NOTES,
    PERMISSIONS.EDIT_NOTES,
    PERMISSIONS.SIGN_NOTES,
    PERMISSIONS.VIEW_DIAGNOSES,
    PERMISSIONS.EDIT_DIAGNOSES,
    PERMISSIONS.VIEW_BILLING,
    PERMISSIONS.MANAGE_ELIGIBILITY,
  ],

  biller: [
    // Billers focus on billing, claims, payments, and work queue management
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.VIEW_PATIENT_BILLING,
    PERMISSIONS.VIEW_BILLING,
    PERMISSIONS.POST_PAYMENTS,
    PERMISSIONS.VIEW_CLAIMS,
    PERMISSIONS.SUBMIT_CLAIMS,
    PERMISSIONS.REVIEW_DENIALS,
    PERMISSIONS.MANAGE_ELIGIBILITY,
    PERMISSIONS.VIEW_WORKQUEUE,
    PERMISSIONS.MANAGE_WORKQUEUE,
    PERMISSIONS.PROCESS_PAYMENTS,
  ],

  supervisor: [
    // Supervisors have broad access to manage staff, schedules, and review operations
    PERMISSIONS.VIEW_CALENDAR,
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.VIEW_PATIENT_BILLING,
    PERMISSIONS.CREATE_NOTES,
    PERMISSIONS.SIGN_NOTES,
    PERMISSIONS.VIEW_DIAGNOSES,
    PERMISSIONS.VIEW_BILLING,
    PERMISSIONS.VIEW_CLAIMS,
    PERMISSIONS.REVIEW_DENIALS,
    PERMISSIONS.VIEW_WORKQUEUE,
    PERMISSIONS.MANAGE_WORKQUEUE,
    PERMISSIONS.MANAGE_WORK_SCHEDULES,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.VIEW_AUDIT_LOGS,
  ],

  read_only: [
    // Read-only access to view core information
    PERMISSIONS.VIEW_CALENDAR,
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.VIEW_PATIENT_BILLING,
    PERMISSIONS.VIEW_BILLING,
    PERMISSIONS.VIEW_CLAIMS,
    PERMISSIONS.VIEW_WORKQUEUE,
  ],

  support: [
    // Support staff can help with scheduling and general inquiries
    PERMISSIONS.VIEW_CALENDAR,
    PERMISSIONS.VIEW_PATIENT_CHART,
    PERMISSIONS.ACCESS_PATIENT_MESSAGES,
    PERMISSIONS.VIEW_WORKQUEUE,
  ],
};

/**
 * Permission categories for UI organization
 */
export const PERMISSION_CATEGORIES = {
  SCHEDULING: "scheduling",
  PATIENTS: "patients",
  CLINICAL: "clinical",
  BILLING: "billing",
  OPERATIONS: "operations",
  ADMINISTRATION: "administration",
} as const;

export const PERMISSION_CATEGORY_LABELS: Record<
  (typeof PERMISSION_CATEGORIES)[keyof typeof PERMISSION_CATEGORIES],
  string
> = {
  scheduling: "Scheduling & Appointments",
  patients: "Patient Management",
  clinical: "Clinical Documentation",
  billing: "Billing & Claims",
  operations: "Operations & Work Queue",
  administration: "Administration",
};

/**
 * Maps permissions to their categories
 */
export const PERMISSION_TO_CATEGORY: Record<PermissionCode, string> = {
  // Scheduling
  view_calendar: PERMISSION_CATEGORIES.SCHEDULING,
  create_appointments: PERMISSION_CATEGORIES.SCHEDULING,
  edit_appointments: PERMISSION_CATEGORIES.SCHEDULING,
  cancel_appointments: PERMISSION_CATEGORIES.SCHEDULING,
  manage_availability: PERMISSION_CATEGORIES.SCHEDULING,

  // Patients
  view_patient_chart: PERMISSION_CATEGORIES.PATIENTS,
  edit_patient_demographics: PERMISSION_CATEGORIES.PATIENTS,
  view_patient_billing: PERMISSION_CATEGORIES.PATIENTS,
  access_patient_messages: PERMISSION_CATEGORIES.PATIENTS,

  // Clinical
  create_notes: PERMISSION_CATEGORIES.CLINICAL,
  edit_notes: PERMISSION_CATEGORIES.CLINICAL,
  sign_notes: PERMISSION_CATEGORIES.CLINICAL,
  view_diagnoses: PERMISSION_CATEGORIES.CLINICAL,
  edit_diagnoses: PERMISSION_CATEGORIES.CLINICAL,

  // Billing
  view_billing: PERMISSION_CATEGORIES.BILLING,
  post_payments: PERMISSION_CATEGORIES.BILLING,
  view_claims: PERMISSION_CATEGORIES.BILLING,
  submit_claims: PERMISSION_CATEGORIES.BILLING,
  review_denials: PERMISSION_CATEGORIES.BILLING,
  manage_eligibility: PERMISSION_CATEGORIES.BILLING,

  // Operations
  view_workqueue: PERMISSION_CATEGORIES.OPERATIONS,
  manage_workqueue: PERMISSION_CATEGORIES.OPERATIONS,
  process_payments: PERMISSION_CATEGORIES.OPERATIONS,

  // Administration
  manage_work_schedules: PERMISSION_CATEGORIES.ADMINISTRATION,
  manage_staff: PERMISSION_CATEGORIES.ADMINISTRATION,
  manage_users: PERMISSION_CATEGORIES.ADMINISTRATION,
  manage_roles: PERMISSION_CATEGORIES.ADMINISTRATION,
  edit_settings: PERMISSION_CATEGORIES.ADMINISTRATION,
  view_audit_logs: PERMISSION_CATEGORIES.ADMINISTRATION,
};
