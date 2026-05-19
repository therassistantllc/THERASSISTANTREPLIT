/**
 * Protected Route Configuration
 * Maps route patterns to required permissions and roles
 *
 * Usage:
 * - For route protection in middleware or layout
 * - For sidebar visibility/menuing
 * - For feature flag gating
 */

import { PERMISSIONS } from "./constants";
import type { PermissionCode, StaffRoleCode } from "./constants";

/**
 * Configuration for a protected route
 */
export interface ProtectedRouteConfig {
  path: string;
  description: string;
  requiredPermissions?: PermissionCode[];
  requiredAnyPermissions?: PermissionCode[];
  requiredRole?: StaffRoleCode;
  section: "scheduling" | "patients" | "billing" | "work_queue" | "clinical" | "admin" | "profile";
}

/**
 * Complete protected routes configuration
 */
export const PROTECTED_ROUTES: ProtectedRouteConfig[] = [
  // Scheduling
  {
    path: "/scheduling",
    description: "Scheduling & Calendar",
    requiredAnyPermissions: [PERMISSIONS.VIEW_CALENDAR, PERMISSIONS.CREATE_APPOINTMENTS],
    section: "scheduling",
  },
  {
    path: "/scheduling/new",
    description: "Create Appointment",
    requiredPermissions: [PERMISSIONS.CREATE_APPOINTMENTS],
    section: "scheduling",
  },

  // Patients / Client Chart
  {
    path: "/patients",
    description: "Patient Directory",
    requiredAnyPermissions: [PERMISSIONS.VIEW_PATIENT_CHART, PERMISSIONS.VIEW_PATIENT_BILLING],
    section: "patients",
  },
  {
    path: "/patients/[id]",
    description: "Patient Chart",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_CHART],
    section: "patients",
  },
  {
    path: "/clients/[id]",
    description: "Patient Chart",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_CHART],
    section: "patients",
  },
  {
    path: "/patients/[id]/edit",
    description: "Edit Patient Demographics",
    requiredPermissions: [
      PERMISSIONS.VIEW_PATIENT_CHART,
      PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS,
    ],
    section: "patients",
  },
  {
    path: "/clients/[id]/edit",
    description: "Edit Patient Demographics",
    requiredPermissions: [
      PERMISSIONS.VIEW_PATIENT_CHART,
      PERMISSIONS.EDIT_PATIENT_DEMOGRAPHICS,
    ],
    section: "patients",
  },
  {
    path: "/patients/[id]/billing-settings",
    description: "Patient Billing Settings",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_BILLING],
    section: "patients",
  },
  {
    path: "/clients/[id]/billing-settings",
    description: "Patient Billing Settings",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_BILLING],
    section: "patients",
  },
  {
    path: "/patients/[id]/patient-billing",
    description: "Patient Billing View",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_BILLING],
    section: "patients",
  },
  {
    path: "/clients/[id]/patient-billing",
    description: "Patient Billing View",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_BILLING],
    section: "patients",
  },

  // Encounters / Clinical Documentation
  {
    path: "/encounters",
    description: "Encounters",
    requiredAnyPermissions: [PERMISSIONS.CREATE_NOTES, PERMISSIONS.VIEW_PATIENT_CHART],
    section: "clinical",
  },
  {
    path: "/encounters/[id]",
    description: "Encounter Details",
    requiredPermissions: [PERMISSIONS.VIEW_PATIENT_CHART],
    section: "clinical",
  },
  {
    path: "/encounters/new",
    description: "Create Encounter",
    requiredPermissions: [PERMISSIONS.CREATE_NOTES, PERMISSIONS.VIEW_PATIENT_CHART],
    section: "clinical",
  },

  // Billing
  {
    path: "/billing/workqueue",
    description: "Billing Work Queue",
    requiredPermissions: [PERMISSIONS.VIEW_BILLING],
    section: "billing",
  },
  {
    path: "/billing/claims/[id]",
    description: "Claim Details",
    requiredAnyPermissions: [PERMISSIONS.VIEW_BILLING, PERMISSIONS.VIEW_CLAIMS],
    section: "billing",
  },
  {
    path: "/claims",
    description: "Claims",
    requiredAnyPermissions: [PERMISSIONS.VIEW_CLAIMS, PERMISSIONS.VIEW_BILLING],
    section: "billing",
  },
  {
    path: "/claims/[id]",
    description: "Claim Detail",
    requiredAnyPermissions: [PERMISSIONS.VIEW_CLAIMS, PERMISSIONS.VIEW_BILLING],
    section: "billing",
  },

  // Work Schedule
  {
    path: "/work-schedule",
    description: "Work Schedule",
    requiredPermissions: [PERMISSIONS.MANAGE_WORK_SCHEDULES],
    section: "work_queue",
  },

  // Staff / User Management (Admin Only)
  {
    path: "/staff",
    description: "Staff Directory",
    requiredPermissions: [PERMISSIONS.MANAGE_STAFF, PERMISSIONS.MANAGE_USERS],
    section: "admin",
  },

  // Settings (Admin Only)
  {
    path: "/settings",
    description: "Settings",
    requiredPermissions: [PERMISSIONS.EDIT_SETTINGS],
    section: "admin",
  },
  {
    path: "/settings/practice",
    description: "Practice Settings",
    requiredPermissions: [PERMISSIONS.EDIT_SETTINGS],
    section: "admin",
  },
  {
    path: "/settings/appointment-types",
    description: "Appointment Types",
    requiredPermissions: [PERMISSIONS.EDIT_SETTINGS],
    section: "admin",
  },
  {
    path: "/settings/reminder-settings",
    description: "Reminder Settings",
    requiredPermissions: [PERMISSIONS.EDIT_SETTINGS],
    section: "admin",
  },

  // Profile
  {
    path: "/profile",
    description: "My Profile",
    section: "profile",
  },
];

/**
 * Get configuration for a route path
 */
export function getRouteConfig(path: string): ProtectedRouteConfig | undefined {
  // Exact match first
  let config = PROTECTED_ROUTES.find((r) => r.path === path);
  if (config) return config;

  // Dynamic route match (e.g., /clients/[id] matches /clients/abc123)
  config = PROTECTED_ROUTES.find((r) => {
    const pattern = r.path.replace(/\[id\]/g, "[^/]+").replace(/\//g, "\\/");
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(path);
  });

  return config;
}

/**
 * Routes that do NOT require authentication
 * (public/guest routes)
 */
export const PUBLIC_ROUTES = ["/", "/help", "/contact-us", "/patient-portal"];

/**
 * Routes that require specific permissions for visibility
 * Used for sidebar/menu rendering
 */
export const MENU_ITEMS: Array<{
  label: string;
  path: string;
  section: string;
  requiredPermissions?: PermissionCode[];
  requiredAnyPermissions?: PermissionCode[];
  children?: Array<{ label: string; path: string }>;
}> = [
  {
    label: "Calendar",
    path: "/scheduling",
    section: "scheduling",
    requiredAnyPermissions: [
      PERMISSIONS.VIEW_CALENDAR,
      PERMISSIONS.CREATE_APPOINTMENTS,
    ],
  },
  {
    label: "Patients",
    path: "/patients",
    section: "patients",
    requiredAnyPermissions: [
      PERMISSIONS.VIEW_PATIENT_CHART,
      PERMISSIONS.VIEW_PATIENT_BILLING,
    ],
  },
  {
    label: "Encounters",
    path: "/encounters",
    section: "clinical",
    requiredAnyPermissions: [PERMISSIONS.CREATE_NOTES, PERMISSIONS.VIEW_PATIENT_CHART],
  },
  {
    label: "Billing",
    path: "/billing/workqueue",
    section: "billing",
    requiredPermissions: [PERMISSIONS.VIEW_BILLING],
    children: [
      { label: "Work Queue", path: "/billing/workqueue" },
      { label: "Claims", path: "/claims" },
    ],
  },
  {
    label: "Work Schedule",
    path: "/work-schedule",
    section: "work_queue",
    requiredPermissions: [PERMISSIONS.MANAGE_WORK_SCHEDULES],
  },
  {
    label: "Staff",
    path: "/staff",
    section: "admin",
    requiredPermissions: [PERMISSIONS.MANAGE_STAFF, PERMISSIONS.MANAGE_USERS],
  },
  {
    label: "Settings",
    path: "/settings",
    section: "admin",
    requiredPermissions: [PERMISSIONS.EDIT_SETTINGS],
  },
];

/**
 * Helper to check if a route is public
 */
export function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some((publicPath) => path.startsWith(publicPath));
}

/**
 * Helper to check if a route requires protection
 */
export function isProtectedRoute(path: string): boolean {
  return !isPublicRoute(path) && !path.startsWith("/api/auth");
}
