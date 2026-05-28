# TherassistantEHR

A Next.js 16 EHR and Practice Management billing app for mental health clinics. Includes charge capture, claim submission (837P), ERA/payment posting, scheduling, and billing reports — all backed by PostgreSQL via Supabase.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (set automatically by Supabase integration)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: Next.js 16.2.6 (App Router, webpack), React 19, Tailwind 4, CSS Modules
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (via Supabase)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/therassistant-ehr/` — Next.js frontend (all billing pages)
- `artifacts/therassistant-ehr/lib/config.ts` — org ID resolution (env → URL param → fallback)
- `artifacts/therassistant-ehr/app/billing/` — all billing page routes
- `artifacts/api-server/` — Express API server
- `lib/db/` — Drizzle schema, migrations, Supabase connection
- `artifacts/therassistant-ehr/scripts/seed-billing-data.mjs` — demo data seeder

## Configuration

### Organization ID

The app is single-tenant per deployment, scoped to one `organization_id`.

| Variable | Value | Description |
|---|---|---|
| `NEXT_PUBLIC_ORGANIZATION_ID` | `11111111-1111-1111-1111-111111111111` | UUID of the active organization |

This is set as a **shared env var** in Replit Secrets. The resolution order in `lib/config.ts` is:

- **Module constant `ORGANIZATION_ID`**: env var → hardcoded fallback (`11111111-1111-1111-1111-111111111111`)
- **Per-request helpers** (`getOrgIdFromSearchParams`, `getOrgIdFromRequest`): `?organizationId=` URL param → env var → fallback

The URL param override is intentional: it lets developers test a specific org on a running deployment without changing the env var.

To deploy for a different clinic: update `NEXT_PUBLIC_ORGANIZATION_ID` to the new clinic's UUID (must match the UUID in the database row for that organization).

### Supabase

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public anon key |

## Architecture decisions

- **Single-org per deployment** — every API call is scoped to `NEXT_PUBLIC_ORGANIZATION_ID`. No user auth session is needed for org resolution; the org is fixed at deploy time.
- **Demo data pattern** — seed script at `scripts/seed-billing-data.mjs` populates all billing tables with realistic demo data keyed to the demo org UUID. Run it once after DB setup.
- **CSS Modules + Tailwind** — page-level components use CSS Modules for isolation; utility classes (Tailwind 4) are used for one-offs and overrides.
- **App Router** — all pages under `app/` use Next.js App Router. Client components are suffixed `Client.tsx`.

## Product

TherassistantEHR covers the full billing lifecycle for outclient mental health practices:
- **Schedule** — appointment calendar and charge capture queue
- **Charge Capture** — review and release charges from appointments
- **Claim Submission** — 837P batch creation and clearinghouse tracking
- **Payments & ERA** — ERA import, payment posting, exception resolution
- **Mailroom** — incoming payer correspondence
- **Billing Reports** — monthly summary of charges, payments, and A/R

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **`NEXT_PUBLIC_` prefix required** — Next.js only exposes env vars prefixed `NEXT_PUBLIC_` to the browser bundle. Server-only vars (without the prefix) are not visible in client components.
- **Demo seed data** — the seed script is idempotent but additive; re-running it on a populated DB will skip existing records (upsert logic). Use the reset option to clear first.
- **Supabase RLS** — Row Level Security policies may need to be disabled or configured for the demo org UUID during development.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `lib/db/schema/` for the full Drizzle schema
