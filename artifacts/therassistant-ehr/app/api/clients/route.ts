import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { enforceOrganizationInRoute, requireAuthentication } from "@/lib/rbac/middleware";

type Row = Record<string, unknown>;

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

    let intakeStatusMissing = false;
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
      intakeStatusMissing = true;

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
    void intakeStatusMissing;

    const rows = ((clients ?? []) as Row[]).filter((client) => {
      if (!q) return true;
      return [client.first_name, client.last_name, client.preferred_name, client.email, client.phone]
        .map(value)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    const ids = rows.map((client) => value(client.id)).filter(Boolean);
    const { data: invoices } = ids.length
      ? await supabase
          .from("patient_invoices")
          .select("client_id, balance_amount, invoice_status")
          .eq("organization_id", organizationId)
          .in("client_id", ids)
          .is("archived_at", null)
      : { data: [] as Row[] };

    const balances = new Map<string, number>();
    for (const invoice of (invoices ?? []) as Row[]) {
      const status = value(invoice.invoice_status).toLowerCase();
      if (!["open", "sent", "collections"].includes(status)) continue;
      const clientId = value(invoice.client_id);
      balances.set(clientId, (balances.get(clientId) ?? 0) + amount(invoice.balance_amount));
    }

    const records = rows.map((client) => ({
      id: value(client.id),
      name: nameOf(client),
      preferredName: client.preferred_name ?? null,
      email: client.email ?? null,
      phone: client.phone ?? null,
      status: client.deceased_at ? "deceased" : "active",
      intakeStatus: client.intake_status ?? "not_started",
      openBalance: balances.get(value(client.id)) ?? 0,
      updatedAt: client.updated_at ?? null,
    }));

    return NextResponse.json({
      success: true,
      organizationId,
      metrics: {
        total: records.length,
        active: records.filter((record) => record.status === "active").length,
        intakeIncomplete: records.filter((record) => String(record.intakeStatus ?? "") !== "complete").length,
        withBalance: records.filter((record) => record.openBalance > 0).length,
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
