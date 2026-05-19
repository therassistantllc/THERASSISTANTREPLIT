import { promises as fs } from "node:fs";
import path from "node:path";

type DomainStatus = {
  domain: string;
  apiRoute: boolean;
  serviceOrLib: boolean;
  migrationSignal: boolean;
};

type DomainDefinition = {
  domain: string;
  apiRoutePath: string;
  servicePath: string;
  migrationPattern: RegExp;
};

const DOMAIN_DEFINITIONS: DomainDefinition[] = [
  {
    domain: "Eligibility",
    apiRoutePath: "app/api/eligibility/check/route.ts",
    servicePath: "lib/eligibility/eligibilityPreparationService.ts",
    migrationPattern: /eligibility/i,
  },
  {
    domain: "Claims",
    apiRoutePath: "app/api/claims/create-from-encounter/route.ts",
    servicePath: "lib/workflow/workflowFunctions.ts",
    migrationPattern: /claims?/i,
  },
  {
    domain: "837P",
    apiRoutePath: "app/api/edi/office-ally/837p/generate/route.ts",
    servicePath: "lib/clearinghouse/ClearinghouseService.ts",
    migrationPattern: /837p|837/i,
  },
  {
    domain: "ERA / Payments",
    apiRoutePath: "app/api/payments/import-835/route.ts",
    servicePath: "lib/clearinghouse/parsers/parse835.ts",
    migrationPattern: /era|835|payment/i,
  },
  {
    domain: "Claim Status",
    apiRoutePath: "app/api/clearinghouse/claim-status/run/route.ts",
    servicePath: "lib/clearinghouse/parsers/parse277.ts",
    migrationPattern: /claim_status|status_inquir/i,
  },
  {
    domain: "Billing Alerts",
    apiRoutePath: "app/api/dashboard/alerts/generate/route.ts",
    servicePath: "lib/workflow/workflowActions.ts",
    migrationPattern: /alert/i,
  },
  {
    domain: "Workqueues",
    apiRoutePath: "app/api/workqueue/sync/route.ts",
    servicePath: "lib/workflow/workflowFunctions.ts",
    migrationPattern: /workqueue/i,
  },
  {
    domain: "Mail Room",
    apiRoutePath: "app/api/mailroom/file/route.ts",
    servicePath: "lib/mailroom/syncGmail.ts",
    migrationPattern: /mailroom/i,
  },
  {
    domain: "RBAC",
    apiRoutePath: "app/api/roles/route.ts",
    servicePath: "lib/rbac/server.ts",
    migrationPattern: /role|permission|rbac/i,
  },
  {
    domain: "Settings",
    apiRoutePath: "app/api/settings/payers/route.ts",
    servicePath: "lib/settings/settingsService.ts",
    migrationPattern: /settings|organization/i,
  },
];

async function fileExists(relativePath: string): Promise<boolean> {
  const fullPath = path.join(/*turbopackIgnore: true*/ process.cwd(), relativePath);

  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function migrationSignalExists(pattern: RegExp): Promise<boolean> {
  const migrationsRoot = path.join(/*turbopackIgnore: true*/ process.cwd(), "supabase", "migrations");

  let entries: string[] = [];
  try {
    entries = await fs.readdir(migrationsRoot);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".sql")) {
      continue;
    }

    const fullPath = path.join(migrationsRoot, entry);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      if (pattern.test(content)) {
        return true;
      }
    } catch {
      // Continue scanning remaining migration files.
    }
  }

  return false;
}

async function resolveDomainStatuses(): Promise<DomainStatus[]> {
  const statuses: DomainStatus[] = [];

  for (const definition of DOMAIN_DEFINITIONS) {
    const [apiRoute, serviceOrLib, migrationSignal] = await Promise.all([
      fileExists(definition.apiRoutePath),
      fileExists(definition.servicePath),
      migrationSignalExists(definition.migrationPattern),
    ]);

    statuses.push({
      domain: definition.domain,
      apiRoute,
      serviceOrLib,
      migrationSignal,
    });
  }

  return statuses;
}

export default async function WorkflowStatusPage() {
  const statuses = await resolveDomainStatuses();

  return (
    <main>
      <h1>Workflow Status</h1>
      <p>Presence checks for key workflow domains based on current repository structure.</p>

      <table>
        <thead>
          <tr>
            <th>Domain</th>
            <th>API Route</th>
            <th>Service/Lib</th>
            <th>Migration Signal</th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((status) => (
            <tr key={status.domain}>
              <td>{status.domain}</td>
              <td>{status.apiRoute ? "found" : "missing"}</td>
              <td>{status.serviceOrLib ? "found" : "missing"}</td>
              <td>{status.migrationSignal ? "found" : "missing"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>These checks are heuristic and intended for quick workflow validation only.</p>
    </main>
  );
}
