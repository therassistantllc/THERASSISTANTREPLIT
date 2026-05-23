/**
 * RBAC Module - Role-Based Access Control
 * Exports all RBAC utilities for easy importing.
 *
 * NOTE: This is the public RBAC API surface. Symbols here may appear unused
 * to static analysis (e.g. knip) when consumers import directly from the
 * sibling modules; the barrel is kept intentionally so external callers have
 * one stable entry point.
 */

// Constants and type definitions
export {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_CATEGORY_LABELS,
  PERMISSION_LABELS,
  PERMISSION_TO_CATEGORY,
  PERMISSIONS,
  STAFF_ROLE_LABELS,
  STAFF_ROLES,
  type PermissionCode,
  type StaffRoleCode,
} from "./constants";

// Server-side utilities
export {
  enforcePermission,
  enforceRole,
  getStaffContext,
  hasAllPermissions,
  hasAnyPermission,
  hasAnyRole,
  hasPermission,
  hasRole,
  isAdmin,
  type StaffContextData,
} from "./server";

// Client-side utilities
export {
  PermissionGate,
  StaffContextProvider,
  useHasAllPermissions,
  useHasAllRoles,
  useHasAnyPermission,
  useHasPermission,
  useHasRole,
  useIsAdmin,
  useStaffContext,
  type ClientStaffContext,
} from "./client";

// Seed data
export { initializeRBAC, seedPermissions, seedRolePermissions, seedRoles } from "./seed";
