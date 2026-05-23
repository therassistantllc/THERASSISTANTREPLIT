export type AppRole = "admin_biller" | "clinician" | "credentialing" | "owner_executive" | "support_read_only";

type ModuleKey =
  | "scheduling"
  | "patients"
  | "billing"
  | "work_schedule"
  | "profile"
  | "settings"
  | "help"
  | "contact"
  | "patient_portal";

const moduleAccessByRole: Record<AppRole, Record<ModuleKey, boolean>> = {
  admin_biller: {
    scheduling: true,
    patients: true,
    billing: true,
    work_schedule: true,
    profile: true,
    settings: true,
    help: true,
    contact: true,
    patient_portal: true,
  },
  clinician: {
    scheduling: true,
    patients: true,
    billing: true,
    work_schedule: false,
    profile: true,
    settings: false,
    help: true,
    contact: true,
    patient_portal: true,
  },
  credentialing: {
    scheduling: true,
    patients: true,
    billing: true,
    work_schedule: false,
    profile: true,
    settings: false,
    help: true,
    contact: true,
    patient_portal: true,
  },
  owner_executive: {
    scheduling: true,
    patients: true,
    billing: true,
    work_schedule: true,
    profile: true,
    settings: true,
    help: true,
    contact: true,
    patient_portal: true,
  },
  support_read_only: {
    scheduling: true,
    patients: true,
    billing: true,
    work_schedule: false,
    profile: true,
    settings: false,
    help: true,
    contact: true,
    patient_portal: false,
  },
};

function canAccessModule(role: AppRole, module: ModuleKey) {
  return moduleAccessByRole[role]?.[module] ?? false;
}

export function normalizeRole(value: string | null | undefined): AppRole {
  const candidate = String(value ?? "").trim() as AppRole;
  if (candidate in moduleAccessByRole) {
    return candidate;
  }
  return "admin_biller";
}

function roleLabel(role: AppRole) {
  if (role === "admin_biller") return "Admin / Biller";
  if (role === "clinician") return "Clinician";
  if (role === "credentialing") return "Credentialing";
  if (role === "owner_executive") return "Owner / Executive";
  return "Support / Read-only";
}
