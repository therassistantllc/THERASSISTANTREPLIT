/**
 * GET /api/billing/era-batches/filter-options?organizationId=…
 *
 * Returns the suggestion sets that back the typeahead filters on the ERA
 * import workqueue:
 *   - clients:   active clients in the org (id + display name)
 *   - clinicians: distinct rendering providers seen on the org's claims
 *                 (from claim_parties_snapshot via professional_claims)
 *   - practices:  distinct place_of_service codes used on the org's claims
 *
 * Task #579 — these power the typeahead dropdowns on the ERA filter rail so
 * billers can pick from real options instead of free-typing a name and hoping
 * the spelling matches.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
  requireAuthenticatedPaymentPoster,
} from "@/lib/payments/postingEngine";

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
};

type ClaimIdRow = { id: string; place_of_service: string | null };

type PartyRow = {
  rendering_provider_first_name: string | null;
  rendering_provider_last_name_or_org: string | null;
};

function clientName(row: ClientRow): string {
  // Keep the suggestion label aligned with how the list endpoint renders
  // `BatchListItem.clients` ("first_name last_name") so the client-side
  // filter pass in EraImportClient lines up exactly with what the picker
  // emits. If we ever add disambiguators (preferred name, DOB, …) they
  // must be added on both sides in lockstep.
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  const base = [first, last].filter(Boolean).join(" ").trim();
  return base || row.preferred_name?.trim() || "Unnamed client";
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) {
      return NextResponse.json(
        { success: false, error: "organizationId is required" },
        { status: 400 },
      );
    }
    await requireAuthenticatedPaymentPoster(organizationId);

    // Clients: every active client in the org. The roster is small enough
    // (clients API caps at 250) that we can ship them all to the client and
    // let the browser filter as the biller types — no server round-trip per
    // keystroke.
    const clientsRes = await supabase
      .from("clients")
      .select("id, first_name, last_name, preferred_name")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .limit(1000);
    if (clientsRes.error) {
      return NextResponse.json(
        { success: false, error: clientsRes.error.message },
        { status: 500 },
      );
    }
    const clients = ((clientsRes.data ?? []) as ClientRow[])
      .map((row) => ({ id: row.id, name: clientName(row) }))
      .filter((p) => p.name && p.name !== "Unnamed client");

    // Practices + the claim-id universe used for clinician lookup.
    const claimsRes = await supabase
      .from("professional_claims")
      .select("id, place_of_service")
      .eq("organization_id", organizationId)
      .limit(10000);
    if (claimsRes.error) {
      return NextResponse.json(
        { success: false, error: claimsRes.error.message },
        { status: 500 },
      );
    }
    const claimRows = (claimsRes.data ?? []) as ClaimIdRow[];
    const practiceSet = new Set<string>();
    for (const c of claimRows) {
      const pos = c.place_of_service?.trim();
      if (pos) practiceSet.add(pos);
    }
    const practices = Array.from(practiceSet)
      .sort()
      .map((code) => ({ code }));

    // Clinicians: distinct rendering providers across the org's claims.
    // Snapshot rows have no organization_id of their own, so we scope by
    // claim_id from the org-restricted professional_claims query above.
    const claimIds = claimRows.map((c) => c.id);
    const clinicianNames = new Set<string>();
    if (claimIds.length > 0) {
      // Chunk the IN list — Postgres handles big arrays but supabase-js URL
      // encoding can balloon. 500 ids per batch keeps requests small.
      for (let i = 0; i < claimIds.length; i += 500) {
        const slice = claimIds.slice(i, i + 500);
        const partyRes = await supabase
          .from("claim_parties_snapshot")
          .select(
            "rendering_provider_first_name, rendering_provider_last_name_or_org",
          )
          .in("claim_id", slice);
        if (partyRes.error) {
          return NextResponse.json(
            { success: false, error: partyRes.error.message },
            { status: 500 },
          );
        }
        for (const row of (partyRes.data ?? []) as PartyRow[]) {
          const name = [
            row.rendering_provider_first_name,
            row.rendering_provider_last_name_or_org,
          ]
            .map((v) => v?.trim())
            .filter(Boolean)
            .join(" ")
            .trim();
          if (name) clinicianNames.add(name);
        }
      }
    }
    const clinicians = Array.from(clinicianNames)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name }));

    return NextResponse.json({
      success: true,
      organizationId,
      clients,
      clinicians,
      practices,
    });
  } catch (error) {
    if (error instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 401 },
      );
    }
    if (error instanceof PaymentPostingForbiddenError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 403 },
      );
    }
    console.error("ERA filter-options API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "ERA filter-options API failed",
      },
      { status: 500 },
    );
  }
}
