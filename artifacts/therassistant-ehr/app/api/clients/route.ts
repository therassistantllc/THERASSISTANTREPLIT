import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { enforceOrganizationInRoute, requireAuthentication } from "@/lib/rbac/middleware";

type Row = Record<string, unknown>;

const ELIGIBILITY_STALE_DAYS = 30;
const CLAIM_ISSUE_STATUSES = new Set(["denied", "rejected_oa", "rejected_payer"]);
const OPEN_WQ_STATUSES = ["open", "in_progress", "blocked"];

function value(input: unknown) {
  return String(input ?? "").trim();
}

function nameOf(row: Row) {
  return [row.first_name, row.last_name].map(value).filter(Boolean).join(" ") || "Unnamed client";
}

function amount(input: unknown) {
  const numberValue = Number(input ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function isValidCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function deriveEligibilityState(latest: Row | null | undefined): {
  status: "none" | "active" | "inactive" | "pending" | "error" | "stale";
  checkedAt: string | null;
  daysSinceChecked: number | null;
  copayAmount: number | null;
  isStale: boolean;
} {
  if (!latest) {
    return { status: "none", checkedAt: null, daysSinceChecked: null, copayAmount: null, isStale: false };
  }
  const checkedAt = (latest.checked_at as string | null) ?? null;
  const days = daysSince(checkedAt);
  const rawStatus = value(latest.eligibility_status).toLowerCase();
  const isStale = days !== null && days > ELIGIBILITY_STALE_DAYS && rawStatus === "active";
  const status = (
    isStale
      ? "stale"
      : (["active", "inactive", "pending", "error"].includes(rawStatus) ? rawStatus : "none")
  ) as "none" | "active" | "inactive" | "pending" | "error" | "stale";
  const copayRaw = latest.copay_amount;
  const copayAmount = copayRaw === null || copayRaw === undefined ? null : Number(copayRaw);
  return { status, checkedAt, daysSinceChecked: days, copayAmount, isStale };
}

export async function POST(request: Request) {
  try {
    const authOrError = await requireAuthentication();
    if (authOrError instanceof NextResponse) return authOrError;
    const { organizationId: userOrganizationId, staffId } = authOrError;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const payload = (await request.json().catch(() => null)) as Row | null;
    if (!payload) return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });

    const requestedOrganizationId = value(payload.organizationId) || userOrganizationId;
    const orgMismatch = enforceOrganizationInRoute(requestedOrganizationId, userOrganizationId);
    if (orgMismatch) return orgMismatch;
    const organizationId = userOrganizationId;

    const firstName = value(payload.firstName);
    const lastName = value(payload.lastName);
    const dateOfBirth = value(payload.dateOfBirth);
    const phone = value(payload.phone);
    const email = value(payload.email);

    if (!firstName) return NextResponse.json({ success: false, error: "First name is required" }, { status: 400 });
    if (!lastName) return NextResponse.json({ success: false, error: "Last name is required" }, { status: 400 });
    if (!dateOfBirth || !isValidCalendarDate(dateOfBirth)) {
      return NextResponse.json({ success: false, error: "Date of birth must be a valid YYYY-MM-DD date" }, { status: 400 });
    }
    const dobDate = new Date(`${dateOfBirth}T00:00:00Z`);
    if (dobDate.getTime() > Date.now()) {
      return NextResponse.json({ success: false, error: "Date of birth cannot be in the future" }, { status: 400 });
    }
    if (!phone) return NextResponse.json({ success: false, error: "Primary phone is required" }, { status: 400 });

    const { data: inserted, error } = await supabase
      .from("clients")
      .insert({
        organization_id: organizationId,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: dateOfBirth,
        phone,
        email: email || null,
        created_by_user_id: staffId,
        updated_by_user_id: staffId,
      })
      .select("id, first_name, last_name, preferred_name, email, phone, date_of_birth")
      .single();

    if (error) throw error;
    if (!inserted) throw new Error("Insert returned no row");

    const row = inserted as Row;
    return NextResponse.json({
      success: true,
      client: {
        id: value(row.id),
        name: nameOf(row),
        preferredName: row.preferred_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        dateOfBirth: row.date_of_birth ?? null,
        status: "active",
        intakeStatus: null,
        openBalance: 0,
        eligibility: { status: "none", checkedAt: null, daysSinceChecked: null, copayAmount: null, isStale: false },
        nextAppointmentAt: null,
        openWorkqueueCount: 0,
        claimIssueCount: 0,
      },
    });
  } catch (error) {
    console.error("Clients create API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create client" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const q = value(searchParams.get("q")).toLowerCase();

    if (!organizationId) return NextResponse.json({ success: false, error: "organizationId is required" }, { status: 400 });

    const baseColumns = "id, first_name, last_name, preferred_name, email, phone, archived_at, deceased_at, updated_at";
    const fullColumns = `${baseColumns}, intake_status`;

    let clients: Row[] | null;
    const initial = await supabase
      .from("clients")
      .select(fullColumns)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .limit(250);
    let error = initial.error;
    clients = (initial.data as Row[] | null) ?? null;

    if (error) {
      const errCode = (error as { code?: string }).code ?? "";
      const errMessage = String((error as { message?: string }).message ?? "");
      const isMissingIntakeStatus =
        errCode === "42703" ||
        /column\s+["']?clients\.intake_status["']?\s+does not exist/i.test(errMessage) ||
        /intake_status/i.test(errMessage);

      if (!isMissingIntakeStatus) throw error;

      console.warn(
        "[clients roster] clients.intake_status column missing; degrading gracefully. Apply the patient_intake_workflow migration to restore intake status data.",
      );

      const fallback = await supabase
        .from("clients")
        .select(baseColumns)
        .eq("organization_id", organizationId)
        .is("archived_at", null)
        .order("last_name", { ascending: true })
        .limit(250);

      if (fallback.error) throw fallback.error;
      clients = (fallback.data as Row[] | null) ?? null;
    }

    const rows = ((clients ?? []) as Row[]).filter((client) => {
      if (!q) return true;
      return [client.first_name, client.last_name, client.preferred_name, client.email, client.phone]
        .map(value)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    const ids = rows.map((client) => value(client.id)).filter(Boolean);

    // Batch the operational queries in parallel. Each is wrapped so a single
    // table failure (missing column, view not yet migrated, etc.) degrades the
    // affected signal to empty instead of crashing the entire roster.
    async function safeQuery(label: string, runner: () => Promise<{ data: unknown; error: unknown }>): Promise<Row[]> {
      try {
        const { data, error: queryError } = await runner();
        if (queryError) {
          console.warn(`[clients roster] ${label} query failed; degrading to empty.`, queryError);
          return [];
        }
        return (data as Row[] | null) ?? [];
      } catch (caught) {
        console.warn(`[clients roster] ${label} query threw; degrading to empty.`, caught);
        return [];
      }
    }

    const nowIso = new Date().toISOString();
    const [invoiceRows, eligibilityRows, appointmentRows, workqueueRows, claimRows] = ids.length
      ? await Promise.all([
          safeQuery("patient_invoices", () =>
            supabase
              .from("patient_invoices")
              .select("client_id, balance_amount, invoice_status")
              .eq("organization_id", organizationId)
              .in("client_id", ids)
              .is("archived_at", null)),
          safeQuery("eligibility_checks", () =>
            supabase
              .from("eligibility_checks")
              .select("client_id, eligibility_status, checked_at, copay_amount")
              .eq("organization_id", organizationId)
              .in("client_id", ids)
              .is("archived_at", null)
              .order("checked_at", { ascending: false })),
          safeQuery("appointments", () =>
            supabase
              .from("appointments")
              .select("client_id, scheduled_start_at, appointment_status")
              .eq("organization_id", organizationId)
              .in("client_id", ids)
              .gte("scheduled_start_at", nowIso)
              .order("scheduled_start_at", { ascending: true })),
          safeQuery("workqueue_items", () =>
            supabase
              .from("workqueue_items")
              .select("client_id, status")
              .eq("organization_id", organizationId)
              .in("client_id", ids)
              .in("status", OPEN_WQ_STATUSES)
              .is("archived_at", null)),
          safeQuery("professional_claims", () =>
            supabase
              .from("professional_claims")
              .select("patient_id, claim_status")
              .eq("organization_id", organizationId)
              .in("patient_id", ids)),
        ])
      : [[] as Row[], [] as Row[], [] as Row[], [] as Row[], [] as Row[]];

    const balances = new Map<string, number>();
    for (const invoice of invoiceRows) {
      const status = value(invoice.invoice_status).toLowerCase();
      if (!["open", "sent", "collections"].includes(status)) continue;
      const clientId = value(invoice.client_id);
      balances.set(clientId, (balances.get(clientId) ?? 0) + amount(invoice.balance_amount));
    }

    // Eligibility: take the first (latest) record per client because results are ordered desc by checked_at.
    const latestEligibility = new Map<string, Row>();
    for (const row of eligibilityRows) {
      const clientId = value(row.client_id);
      if (!latestEligibility.has(clientId)) latestEligibility.set(clientId, row);
    }

    const nextAppointment = new Map<string, string>();
    for (const appt of appointmentRows) {
      const clientId = value(appt.client_id);
      const start = value(appt.scheduled_start_at);
      if (!start) continue;
      if (!nextAppointment.has(clientId)) nextAppointment.set(clientId, start);
    }

    const workqueueCounts = new Map<string, number>();
    for (const wq of workqueueRows) {
      const clientId = value(wq.client_id);
      if (!clientId) continue;
      workqueueCounts.set(clientId, (workqueueCounts.get(clientId) ?? 0) + 1);
    }

    const claimIssueCounts = new Map<string, number>();
    for (const claim of claimRows) {
      const status = value(claim.claim_status).toLowerCase();
      if (!CLAIM_ISSUE_STATUSES.has(status)) continue;
      const clientId = value(claim.patient_id);
      if (!clientId) continue;
      claimIssueCounts.set(clientId, (claimIssueCounts.get(clientId) ?? 0) + 1);
    }

    const records = rows.map((client) => {
      const id = value(client.id);
      const eligibility = deriveEligibilityState(latestEligibility.get(id) ?? null);
      return {
        id,
        name: nameOf(client),
        preferredName: client.preferred_name ?? null,
        email: client.email ?? null,
        phone: client.phone ?? null,
        status: client.deceased_at ? "deceased" : "active",
        intakeStatus: client.intake_status ?? "not_started",
        openBalance: balances.get(id) ?? 0,
        updatedAt: client.updated_at ?? null,
        eligibility,
        nextAppointmentAt: nextAppointment.get(id) ?? null,
        openWorkqueueCount: workqueueCounts.get(id) ?? 0,
        claimIssueCount: claimIssueCounts.get(id) ?? 0,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      metrics: {
        total: records.length,
        active: records.filter((record) => record.status === "active").length,
        intakeIncomplete: records.filter((record) => String(record.intakeStatus ?? "") !== "complete").length,
        withBalance: records.filter((record) => record.openBalance > 0).length,
        needsEligibility: records.filter((record) => record.eligibility.status === "none").length,
        staleEligibility: records.filter((record) => record.eligibility.status === "stale").length,
        claimIssues: records.filter((record) => record.claimIssueCount > 0).length,
        openWorkqueue: records.filter((record) => record.openWorkqueueCount > 0).length,
      },
      clients: records,
    });
  } catch (error) {
    console.error("Clients roster API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Clients roster API failed" },
      { status: 500 },
    );
  }
}
