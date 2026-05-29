import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
type Row = Record<string, unknown>;

const ELIGIBILITY_STALE_DAYS = 30;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function nameOf(row: Row) {
  return [row.first_name, row.last_name].map(value).filter(Boolean).join(" ") || "Unnamed client";
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

function isRpcUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code === "PGRST202";
}

function isMissingPrimaryProviderColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");
  return (
    (code === "42703" || code === "PGRST204" || code === "PGRST200") &&
    /primary_provider_id/i.test(message)
  );
}

async function listClientsFallback(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  organizationId: string;
  q: string;
  limit: number;
  offset: number;
}) {
  const { supabase, organizationId, q, limit, offset } = params;

  let countQuery = (supabase as any)
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  let dataQuery = (supabase as any)
    .from("clients")
    .select("id, first_name, last_name, preferred_name, email, phone, status, intake_status, updated_at, primary_provider_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("last_name", { ascending: true })
    .order("first_name", { ascending: true })
    .range(offset, offset + limit - 1);

  if (q) {
    const escaped = q.replace(/[%_]/g, "");
    const ilike = `%${escaped}%`;
    const filter = `first_name.ilike.${ilike},last_name.ilike.${ilike},email.ilike.${ilike}`;
    countQuery = countQuery.or(filter);
    dataQuery = dataQuery.or(filter);
  }

  let [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);

  if (isMissingPrimaryProviderColumn(dataResult.error)) {
    // Backward compatibility while primary_provider_id migration is rolling out.
    dataQuery = (supabase as any)
      .from("clients")
      .select("id, first_name, last_name, preferred_name, email, phone, status, intake_status, updated_at, primary_clinician_user_id")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true })
      .range(offset, offset + limit - 1);

    [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);
  }

  const { count, error: countError } = countResult;
  const { data, error: dataError } = dataResult;
  if (countError) throw countError;
  if (dataError) throw dataError;

  return {
    rows: (data ?? []) as Row[],
    totalCount: Number(count ?? 0),
  };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as Row | null;
    if (!payload) return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });

    const guard = await requireOrgAccess({
      requestedOrganizationId: value(payload.organizationId) || null,
    });
    if (guard instanceof NextResponse) return guard;
    const { organizationId, staffId } = guard;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const firstName = value(payload.firstName);
    const lastName = value(payload.lastName);
    const dateOfBirth = value(payload.dateOfBirth);
    const phone = value(payload.phone);
    const email = value(payload.email);
    const preferredName = value(payload.preferredName);
    const mrn = value(payload.mrn);
    const sourceClientId = value(payload.sourceClientId ?? payload.externalClientRef);
    const sexAtBirthRaw = value(payload.sexAtBirth).toLowerCase();
    const genderIdentity = value(payload.genderIdentity);
    const addressLine1 = value(payload.addressLine1);
    const addressLine2 = value(payload.addressLine2);
    const city = value(payload.city);
    const stateCode = value(payload.state).toUpperCase();
    const postalCode = value(payload.postalCode);
    const emergencyContactName = value(payload.emergencyContactName);
    const emergencyContactPhone = value(payload.emergencyContactPhone);

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

    const ALLOWED_SEX_AT_BIRTH = new Set(["female", "male", "intersex", "unknown", "declined"]);
    if (sexAtBirthRaw && !ALLOWED_SEX_AT_BIRTH.has(sexAtBirthRaw)) {
      return NextResponse.json({ success: false, error: "Invalid sex at birth value" }, { status: 400 });
    }
    if (stateCode && !/^[A-Z]{2}$/.test(stateCode)) {
      return NextResponse.json({ success: false, error: "State must be a 2-letter US code" }, { status: 400 });
    }
    if (postalCode && !/^\d{5}(-\d{4})?$/.test(postalCode)) {
      return NextResponse.json({ success: false, error: "Postal code must be ZIP or ZIP+4" }, { status: 400 });
    }

    const insertRow: Record<string, unknown> = {
      organization_id: organizationId,
      first_name: firstName,
      last_name: lastName,
      date_of_birth: dateOfBirth,
      phone,
      email: email || null,
      preferred_name: preferredName || null,
      mrn: mrn || null,
      external_client_ref: sourceClientId || null,
      sex_at_birth: sexAtBirthRaw || null,
      gender_identity: genderIdentity || null,
      address_line_1: addressLine1 || null,
      address_line_2: addressLine2 || null,
      city: city || null,
      state: stateCode || null,
      postal_code: postalCode || null,
      emergency_contact_name: emergencyContactName || null,
      emergency_contact_phone: emergencyContactPhone || null,
      created_by_user_id: staffId ?? null,
      updated_by_user_id: staffId ?? null,
    };

    let { data: inserted, error } = await supabase
      .from("clients")
      .insert(insertRow)
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
      { success: false, error: "Failed to create client" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const q = value(searchParams.get("q"));
    const limitRaw = Number(searchParams.get("limit") ?? "50");
    const offsetRaw = Number(searchParams.get("offset") ?? "0");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;
    const { data, error } = await (supabase as any).rpc("billing_clients_roster_page", {
      p_organization_id: organizationId,
      p_query: q || null,
      p_limit: limit,
      p_offset: offset,
    });
    let rows = (data ?? []) as Row[];
    let totalCount = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

    if (error) {
      if (!isRpcUnavailable(error)) throw error;
      console.warn("billing_clients_roster_page RPC not available; using fallback clients list");
      const fallback = await listClientsFallback({
        supabase,
        organizationId,
        q,
        limit,
        offset,
      });
      rows = fallback.rows;
      totalCount = fallback.totalCount;
    }

    const records = rows.map((client) => {
      const eligibility = deriveEligibilityState({
        eligibility_status: client.eligibility_status,
        checked_at: client.eligibility_checked_at,
        copay_amount: client.copay_amount,
      });
      return {
        id: value(client.client_id ?? client.id),
        name: nameOf(client),
        preferredName: client.preferred_name ?? null,
        email: client.email ?? null,
        phone: client.phone ?? null,
        status: value(client.status) || "active",
        intakeStatus: client.intake_status ?? "not_started",
        openBalance: Number(client.open_balance ?? 0),
        updatedAt: client.updated_at ?? null,
        eligibility,
        nextAppointmentAt: client.next_appointment_at ?? null,
        openWorkqueueCount: Number(client.open_workqueue_count ?? 0),
        claimIssueCount: Number(client.claim_issue_count ?? 0),
        primaryProviderId: client.primary_provider_id
          ? String(client.primary_provider_id)
          : client.primary_clinician_user_id
            ? String(client.primary_clinician_user_id)
            : null,
      };
    });

    return NextResponse.json({
      success: true,
      organizationId,
      pagination: {
        limit,
        offset,
        returned: records.length,
        totalCount,
        hasMore: offset + records.length < totalCount,
      },
      metrics: {
        total: totalCount,
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
      { success: false, error: "Clients roster API failed" },
      { status: 500 },
    );
  }
}
