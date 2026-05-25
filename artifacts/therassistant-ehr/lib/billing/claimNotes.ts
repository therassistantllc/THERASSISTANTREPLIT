/**
 * Shared helper for inserting rows into `public.claim_notes`.
 *
 * Every billing surface that writes a system-generated note (denials,
 * recoupments, aging, appeals, partial-payments, executive-priority,
 * compliance-audit, uncollectible, claim-hold, payer-rules, no-response,
 * timely-filing, underpayments, corrected-claims, duplicate-claim-review)
 * should route through `insertClaimNote` so the resulting row carries the
 * same auto-inferred `rarc_codes` that the per-claim notes endpoint
 * attaches to user-typed notes (Task #464). Without that, system notes
 * would never appear in the "Denials by RARC" historical-notes panel
 * for the relevant RARC.
 *
 * Inference unions:
 *   • era_claim_payments.rarc_codes (what the ERA layer recorded)
 *   • claim_workqueue_items.rarc_code (what the denials workqueue surfaced,
 *     non-archived only)
 *
 * Callers may pass an explicit `rarcCodes` array to override inference
 * (e.g. denials-by-carc actions that already know the relevant code).
 */

const text = (v: unknown) => String(v ?? "").trim();

export async function inferRarcCodesForClaim(
  supabase: any,
  claimId: string,
): Promise<string[]> {
  if (!supabase || !claimId) return [];
  const codes = new Set<string>();
  const [eraRes, wqRes] = await Promise.all([
    supabase
      .from("era_claim_payments")
      .select("rarc_codes")
      .eq("professional_claim_id", claimId),
    supabase
      .from("claim_workqueue_items")
      .select("rarc_code")
      .eq("claim_id", claimId)
      .is("archived_at", null),
  ]);
  for (const row of (eraRes?.data as any[]) ?? []) {
    const arr = Array.isArray(row?.rarc_codes) ? row.rarc_codes : [];
    for (const c of arr) {
      const s = text(c).toUpperCase();
      if (s) codes.add(s);
    }
  }
  for (const row of (wqRes?.data as any[]) ?? []) {
    const s = text(row?.rarc_code).toUpperCase();
    if (s) codes.add(s);
  }
  return Array.from(codes);
}

export interface InsertClaimNoteArgs {
  organizationId: string;
  claimId: string;
  body: string;
  authorUserId?: string | null;
  authorDisplayName?: string | null;
  deferUntil?: string | null;
  /** Explicit RARC override. If omitted (or null), inference is run. */
  rarcCodes?: string[] | null;
  resolvedDenial?: boolean | null;
  /** Optional Postgrest select string for `.select(...).single()` chaining. */
  returning?: string;
}

export async function insertClaimNote(
  supabase: any,
  args: InsertClaimNoteArgs,
): Promise<{ data: any; error: any }> {
  const explicit = Array.isArray(args.rarcCodes)
    ? args.rarcCodes.map((c) => text(c).toUpperCase()).filter(Boolean)
    : null;
  const rarcCodes =
    explicit && explicit.length > 0
      ? explicit
      : await inferRarcCodesForClaim(supabase, args.claimId);

  const row: Record<string, unknown> = {
    organization_id: args.organizationId,
    claim_id: args.claimId,
    body: args.body,
    author_user_id: args.authorUserId ?? null,
    rarc_codes: rarcCodes,
  };
  if (args.authorDisplayName !== undefined) {
    row.author_display_name = args.authorDisplayName;
  }
  if (args.deferUntil !== undefined) {
    row.defer_until = args.deferUntil;
  }
  if (args.resolvedDenial !== undefined && args.resolvedDenial !== null) {
    row.resolved_denial = Boolean(args.resolvedDenial);
  }

  const builder = supabase.from("claim_notes").insert(row);
  if (args.returning) {
    return await builder.select(args.returning).single();
  }
  return await builder;
}
