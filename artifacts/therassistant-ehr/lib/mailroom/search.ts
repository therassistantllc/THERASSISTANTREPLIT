/**
 * Mailroom search — pure business logic.
 *
 * The /api/mailroom/search route is a thin wrapper around `searchMailroomEntities`.
 * Keeping the supabase-touching logic in a parameterized helper lets us unit-test
 * org scoping, ILIKE-injection safety, type validation, and result-shape contracts
 * with a fake supabase client (see lib/mailroom/__tests__/search.test.ts).
 */

export type MailroomSearchType = "patient" | "claim" | "encounter";

export const MAILROOM_SEARCH_TYPES: readonly MailroomSearchType[] = [
  "patient",
  "claim",
  "encounter",
] as const;

export type MailroomSearchResult = {
  id: string;
  label: string;
  sublabel: string;
};

export function isMailroomSearchType(value: unknown): value is MailroomSearchType {
  return typeof value === "string" && (MAILROOM_SEARCH_TYPES as readonly string[]).includes(value);
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Escape characters that have special meaning inside a PostgREST `.ilike()`
 * pattern so an attacker can't smuggle wildcards (`%`, `_`), a custom escape
 * (`\`), or our `or=` list separator (`,`) through the search box.
 */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_,]/g, (ch) => `\\${ch}`);
}

function fullName(row: Row | null | undefined): string {
  if (!row) return "";
  return [row.first_name, row.last_name].map(text).filter(Boolean).join(" ");
}

// Loose supabase shape — we only need the chained methods we actually call.
// The route passes the real client; tests pass a fake that records queries.
type SupabaseLike = {
  from: (table: string) => any;
};

async function searchPatients(
  supabase: SupabaseLike,
  organizationId: string,
  q: string,
  limit: number,
): Promise<MailroomSearchResult[]> {
  let query = supabase
    .from("clients")
    .select("id, first_name, last_name, preferred_name, date_of_birth")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("last_name", { ascending: true })
    .limit(limit);

  if (q) {
    const term = `%${escapeIlike(q)}%`;
    query = query.or(
      `first_name.ilike.${term},last_name.ilike.${term},preferred_name.ilike.${term}`,
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => {
    const name = fullName(row) || "Unnamed client";
    const dob = text(row.date_of_birth);
    return {
      id: text(row.id),
      label: name,
      sublabel: dob ? `DOB ${dob}` : "",
    };
  });
}

async function searchClaims(
  supabase: SupabaseLike,
  organizationId: string,
  q: string,
  limit: number,
): Promise<MailroomSearchResult[]> {
  let query = supabase
    .from("professional_claims")
    .select(
      "id, claim_number, patient_account_number, patient_id, payer_profile_id, date_of_service_from, date_of_service_to, claim_status",
    )
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) {
    const term = `%${escapeIlike(q)}%`;
    query = query.or(
      `claim_number.ilike.${term},patient_account_number.ilike.${term}`,
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  const claims = (data ?? []) as Row[];

  const patientIds = [...new Set(claims.map((row) => text(row.patient_id)).filter(Boolean))];
  const payerIds = [...new Set(claims.map((row) => text(row.payer_profile_id)).filter(Boolean))];

  const [{ data: clients }, { data: payers }] = await Promise.all([
    patientIds.length
      ? supabase.from("clients").select("id, first_name, last_name").in("id", patientIds)
      : Promise.resolve({ data: [] as Row[] }),
    payerIds.length
      ? supabase.from("insurance_payers").select("id, payer_name").in("id", payerIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const clientMap = new Map<string, Row>();
  for (const row of (clients ?? []) as Row[]) clientMap.set(text(row.id), row);
  const payerMap = new Map<string, string>();
  for (const row of (payers ?? []) as Row[]) payerMap.set(text(row.id), text(row.payer_name));

  return claims.map((row) => {
    const claimNumber =
      text(row.claim_number) || text(row.patient_account_number) || text(row.id).slice(0, 8);
    const patientName = fullName(clientMap.get(text(row.patient_id))) || "Unknown patient";
    const payerName = payerMap.get(text(row.payer_profile_id)) || "Unknown payer";
    const dosFrom = text(row.date_of_service_from);
    const dosTo = text(row.date_of_service_to);
    const dos = dosFrom && dosTo && dosFrom !== dosTo ? `${dosFrom} – ${dosTo}` : dosFrom || dosTo;
    const sublabelParts = [patientName, payerName, dos ? `DOS ${dos}` : ""].filter(Boolean);
    return {
      id: text(row.id),
      label: `Claim ${claimNumber}`,
      sublabel: sublabelParts.join(" · "),
    };
  });
}

async function searchEncounters(
  supabase: SupabaseLike,
  organizationId: string,
  q: string,
  limit: number,
): Promise<MailroomSearchResult[]> {
  let patientIds: string[] | null = null;
  if (q) {
    const term = `%${escapeIlike(q)}%`;
    const { data: matched, error: matchError } = await supabase
      .from("clients")
      .select("id")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .or(`first_name.ilike.${term},last_name.ilike.${term},preferred_name.ilike.${term}`)
      .limit(50);
    if (matchError) throw matchError;
    patientIds = ((matched ?? []) as Row[]).map((row) => text(row.id)).filter(Boolean);
    if (patientIds.length === 0) return [];
  }

  let query = supabase
    .from("encounters")
    .select("id, client_id, provider_id, service_date, started_at, encounter_status")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("service_date", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (patientIds && patientIds.length) {
    query = query.in("client_id", patientIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  const encounters = (data ?? []) as Row[];

  const clientIds = [...new Set(encounters.map((row) => text(row.client_id)).filter(Boolean))];
  const providerIds = [...new Set(encounters.map((row) => text(row.provider_id)).filter(Boolean))];

  const [{ data: clients }, { data: providers }] = await Promise.all([
    clientIds.length
      ? supabase.from("clients").select("id, first_name, last_name").in("id", clientIds)
      : Promise.resolve({ data: [] as Row[] }),
    providerIds.length
      ? supabase.from("provider_profiles").select("id, staff_id").in("id", providerIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const clientMap = new Map<string, Row>();
  for (const row of (clients ?? []) as Row[]) clientMap.set(text(row.id), row);

  const staffIds = [
    ...new Set(((providers ?? []) as Row[]).map((row) => text(row.staff_id)).filter(Boolean)),
  ];
  const { data: staff } = staffIds.length
    ? await supabase.from("staff_profiles").select("id, first_name, last_name").in("id", staffIds)
    : { data: [] as Row[] };
  const staffMap = new Map<string, Row>();
  for (const row of (staff ?? []) as Row[]) staffMap.set(text(row.id), row);

  const providerMap = new Map<string, string>();
  for (const provider of (providers ?? []) as Row[]) {
    const staffRow = staffMap.get(text(provider.staff_id));
    providerMap.set(text(provider.id), fullName(staffRow) || "Unassigned provider");
  }

  return encounters.map((row) => {
    const date = text(row.service_date) || text(row.started_at).slice(0, 10);
    const patientName = fullName(clientMap.get(text(row.client_id))) || "Unknown patient";
    const providerName = providerMap.get(text(row.provider_id)) || "Unassigned provider";
    return {
      id: text(row.id),
      label: `${date || "No date"} · ${patientName}`,
      sublabel: providerName,
    };
  });
}

export async function searchMailroomEntities(
  supabase: SupabaseLike,
  organizationId: string,
  type: MailroomSearchType,
  q: string,
  limit: number,
): Promise<MailroomSearchResult[]> {
  if (type === "patient") return searchPatients(supabase, organizationId, q, limit);
  if (type === "claim") return searchClaims(supabase, organizationId, q, limit);
  return searchEncounters(supabase, organizationId, q, limit);
}
