import type { SupabaseClient } from "@supabase/supabase-js";

export type AvailabilityReasonCode =
  | "missing_provider"
  | "outside_availability"
  | "administrative_block"
  | "provider_already_booked"
  | "invalid_window";

export type AvailabilityResult = {
  available: boolean;
  reasonCodes: AvailabilityReasonCode[];
  reasons: string[];
};

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function resolveOrganizationId(
  supabase: SupabaseClient,
  submittedOrganizationId?: string | null,
): Promise<string | null> {
  const submitted = String(submittedOrganizationId ?? "").trim();
  if (submitted && isUuid(submitted)) return submitted;

  const envOrganizationId = String(process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "").trim();
  if (envOrganizationId && isUuid(envOrganizationId)) return envOrganizationId;

  const { data: org, error } = await supabase
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!org?.id || typeof org.id !== "string") return null;
  return org.id;
}

export function addMonthsKeepingClock(source: Date, months: number) {
  const next = new Date(source);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) {
    next.setDate(0);
  }
  return next;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

type AvailabilityParams = {
  supabase: SupabaseClient;
  organizationId: string;
  providerId: string;
  startAt: string;
  endAt: string;
  location: "office" | "telehealth" | "any";
};

export async function checkProviderAvailability({
  supabase,
  organizationId,
  providerId,
  startAt,
  endAt,
  location,
}: AvailabilityParams): Promise<AvailabilityResult> {
  if (!providerId) {
    return {
      available: false,
      reasonCodes: ["missing_provider"],
      reasons: ["Provider is required."],
    };
  }

  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return {
      available: false,
      reasonCodes: ["invalid_window"],
      reasons: ["Invalid appointment time window."],
    };
  }

  const reasonCodes: AvailabilityReasonCode[] = [];
  const reasons: string[] = [];

  const dayOfWeek = start.getDay();
  const slotStart = start.toTimeString().slice(0, 8);
  const slotEnd = end.toTimeString().slice(0, 8);

  const { data: availabilityRules, error: availabilityError } = await supabase
    .from("provider_availability_rules")
    .select("day_of_week, start_time, end_time, location_type, is_available")
    .eq("organization_id", organizationId)
    .eq("provider_id", providerId)
    .eq("day_of_week", dayOfWeek)
    .is("archived_at", null);

  if (availabilityError && !String(availabilityError.message).includes("provider_availability_rules")) {
    throw availabilityError;
  }

  const rules = availabilityRules ?? [];
  if (rules.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const containsSlot = rules.some((rule: any) => {
      const ruleLocation = String(rule.location_type ?? "any").toLowerCase();
      const locationMatch = ruleLocation === "any" || ruleLocation === location || location === "any";
      return Boolean(rule.is_available) && locationMatch && String(rule.start_time) <= slotStart && String(rule.end_time) >= slotEnd;
    });

    if (!containsSlot) {
      reasonCodes.push("outside_availability");
      reasons.push("Outside configured provider availability.");
    }
  }

  const { data: blocks, error: blocksError } = await supabase
    .from("provider_schedule_blocks")
    .select("id, title, block_type, starts_at, ends_at")
    .eq("organization_id", organizationId)
    .eq("provider_id", providerId)
    .is("archived_at", null)
    .lt("starts_at", end.toISOString())
    .gt("ends_at", start.toISOString())
    .limit(5);

  if (blocksError && !String(blocksError.message).includes("provider_schedule_blocks")) {
    throw blocksError;
  }

  if ((blocks ?? []).length > 0) {
    reasonCodes.push("administrative_block");
    reasons.push("Conflicts with administrative/provider block.");
  }

  const { data: overlapsData, error: overlapError } = await supabase
    .from("appointments")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider_id", providerId)
    .is("archived_at", null)
    .lt("scheduled_start_at", end.toISOString())
    .gt("scheduled_end_at", start.toISOString())
    .not("appointment_status", "in", "(cancelled,no_show)")
    .limit(1);

  if (overlapError) throw overlapError;

  if ((overlapsData ?? []).length > 0) {
    reasonCodes.push("provider_already_booked");
    reasons.push("Provider already has an overlapping appointment.");
  }

  return {
    available: reasonCodes.length === 0,
    reasonCodes,
    reasons,
  };
}
