/**
 * Client-side RBAC utilities
 * React hooks for permission/role checking in client components
 */

"use client";

import { createContext, ReactNode, useContext, useState, useEffect } from "react";
import { PermissionCode, StaffRoleCode } from "./constants";

export interface ClientStaffContext {
  staffId: string | null;
  organizationId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  jobTitle: string | null;
  roles: StaffRoleCode[];
  permissions: PermissionCode[];
  isLoading: boolean;
  error: string | null;
}

const StaffContextContext = createContext<ClientStaffContext | undefined>(undefined);

interface StaffContextProviderProps {
  children: ReactNode;
  organizationId: string;
  staffId: string;
}

/**
 * Provider component to supply staff context to child components
 * Fetch staff permissions on mount and provide via context
 */
export function StaffContextProvider({
  children,
  organizationId,
  staffId,
}: StaffContextProviderProps) {
  const [context, setContext] = useState<ClientStaffContext>({
    staffId: staffId || null,
    organizationId: organizationId || null,
    firstName: null,
    lastName: null,
    email: null,
    jobTitle: null,
    roles: [],
    permissions: [],
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    async function loadStaffContext() {
      try {
        const response = await fetch("/api/staff/context", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error("Failed to load staff context");
        }

        const data = await response.json();

        setContext({
          staffId: data.staffId || null,
          organizationId: data.organizationId || null,
          firstName: data.firstName || null,
          lastName: data.lastName || null,
          email: data.email || null,
          jobTitle: data.jobTitle || null,
          roles: data.roles || [],
          permissions: data.permissions || [],
          isLoading: false,
          error: null,
        });
      } catch (error) {
        setContext((prev) => ({
          ...prev,
          isLoading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        }));
      }
    }

    if (organizationId && staffId) {
      loadStaffContext();
    }
  }, [organizationId, staffId]);

  return (
    <StaffContextContext.Provider value={context}>{children}</StaffContextContext.Provider>
  );
}

/**
 * Hook to access the current staff context
 */
export function useStaffContext(): ClientStaffContext {
  const context = useContext(StaffContextContext);
  if (context === undefined) {
    throw new Error("useStaffContext must be used within StaffContextProvider");
  }
  return context;
}

/**
 * Hook to check if current staff has a specific permission
 */
export function useHasPermission(permission: PermissionCode | PermissionCode[]): boolean {
  const { permissions } = useStaffContext();
  const permissionsToCheck = Array.isArray(permission) ? permission : [permission];
  return permissionsToCheck.some((p) => permissions.includes(p));
}

/**
 * Hook to check if current staff has ALL of the specified permissions
 */
export function useHasAllPermissions(permissions: PermissionCode[]): boolean {
  const { permissions: staffPermissions } = useStaffContext();
  return permissions.every((p) => staffPermissions.includes(p));
}

/**
 * Hook to check if current staff has ANY of the specified permissions
 */
export function useHasAnyPermission(permissions: PermissionCode[]): boolean {
  const { permissions: staffPermissions } = useStaffContext();
  return permissions.some((p) => staffPermissions.includes(p));
}

/**
 * Hook to check if current staff has a specific role
 */
export function useHasRole(role: StaffRoleCode | StaffRoleCode[]): boolean {
  const { roles } = useStaffContext();
  const rolesToCheck = Array.isArray(role) ? role : [role];
  return rolesToCheck.some((r) => roles.includes(r));
}

/**
 * Hook to check if current staff has ALL of the specified roles
 */
export function useHasAllRoles(roles: StaffRoleCode[]): boolean {
  const { roles: staffRoles } = useStaffContext();
  return roles.every((r) => staffRoles.includes(r));
}

/**
 * Hook to check if current staff is an admin
 */
export function useIsAdmin(): boolean {
  return useHasRole("admin");
}

/**
 * Conditionally render component based on permission
 */
interface GateProps {
  permission?: PermissionCode | PermissionCode[];
  role?: StaffRoleCode | StaffRoleCode[];
  requireAll?: boolean;
  children: ReactNode;
  fallback?: ReactNode;
}

export function PermissionGate({
  permission,
  role,
  requireAll = false,
  children,
  fallback = null,
}: GateProps) {
  const { permissions, roles } = useStaffContext();

  let hasAccess = true;

  if (permission) {
    const perms = Array.isArray(permission) ? permission : [permission];
    hasAccess = requireAll
      ? perms.every((p) => permissions.includes(p))
      : perms.some((p) => permissions.includes(p));
  }

  if (role && hasAccess) {
    const roleList = Array.isArray(role) ? role : [role];
    hasAccess = requireAll
      ? roleList.every((r) => roles.includes(r))
      : roleList.some((r) => roles.includes(r));
  }

  return hasAccess ? children : fallback;
}
