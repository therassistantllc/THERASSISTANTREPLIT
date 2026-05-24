/**
 * /api/billing/claims/[claimId]/status-inquiries
 *
 * GET — return the 276/277 claim-status inquiry history for a single
 * claim, scoped to the caller's organization. Rows come from
 * `claim_status_inquiries` and from any related 276/277 entries in
 * `edi_transactions` so the "Status check history" tab on the
 * No-Response detail panel can show what was asked, when, what the
 * payer answered, and who triggered the inquiry.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function pickStatus(row: Row): string | null {
  return (
    str(row["status"]) ??
    str(row["inquiry_status"]) ??
    null
  );
}

function pickStatusCode(row: Row): string | null {
  return (
    str(row["payer_status_code"]) ??
    str(row["status_code"]) ??
    str(row["response_status_code"]) ??
    str(row["status_category_code"]) ??
    null
  );
}

function pickStatusText(row: Row): string | null {
  const summary = row["response_summary"];
  let summaryText: string | null = null;
  if (typeof summary === "string") summaryText = str(summary);
  else if (summary && typeof summary === "object") {
    const obj = summary as Record<string, unknown>;
    summaryText = str(obj.description) ?? str(obj.message) ?? null;
  }
  return (
    str(row["payer_status_text"]) ??
    str(row["response_status_description"]) ??
    summaryText ??
    null
  );
}

function pickTimestamp(row: Row, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

async function loadClaim(
  supabase: NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>,
  organizationId: string,
  claimId: string,
) {
  const { data } = await supabase
    .from("professional_claims")
    .select("id, organization_id")
    .eq("id", claimId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const claim = await loadClaim(supabase, organizationId, claimId);
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found" },
        { status: 404 },
      );
    }

    // Use `select("*")` because the live schema for claim_status_inquiries
    // has drifted across migrations (status vs inquiry_status, received_at
    // vs responded_at, etc.). We normalize defensively below.
    const inquiriesResp = await (supabase as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (k: string, v: string) => {
            eq: (k: string, v: string) => {
              order: (
                k: string,
                opts: { ascending: boolean },
              ) => Promise<{ data: Row[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    })
      .from("claim_status_inquiries")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });

    if (inquiriesResp.error) {
      return NextResponse.json(
        { success: false, error: inquiriesResp.error.message },
        { status: 500 },
      );
    }

    const inquiryRows: Row[] = (inquiriesResp.data ?? []).filter(
      (r) => !r["archived_at"],
    );

    // Resolve display names for the staff who triggered each inquiry.
    const userIds = Array.from(
      new Set(
        inquiryRows
          .map((r) => str(r["created_by_user_id"]))
          .filter((v): v is string => Boolean(v)),
      ),
    );
    const userNameById = new Map<string, string>();
    if (userIds.length) {
      const { data: staffRows } = await (supabase as unknown as {
        from: (t: string) => {
          select: (s: string) => {
            in: (k: string, v: string[]) => Promise<{ data: Row[] | null }>;
          };
        };
      })
        .from("staff_profiles")
        .select("auth_user_id, first_name, last_name, email")
        .in("auth_user_id", userIds);
      for (const s of staffRows ?? []) {
        const id = str(s["auth_user_id"]);
        if (!id) continue;
        const composed = [s["first_name"], s["last_name"]]
          .map((v) => str(v))
          .filter(Boolean)
          .join(" ");
        const name = composed || str(s["email"]) || "Staff";
        userNameById.set(id, name);
      }
    }

    const inquiries = inquiryRows.map((row) => {
      const userId = str(row["created_by_user_id"]);
      // Task #540: prefer the explicit trigger_source column written by
      // both the manual action and the auto-check scheduler. Fall back
      // to "manual" when a user id is present (legacy rows pre-column)
      // and "auto" when no user is recorded (cron runs as system).
      const explicitSource = str(row["trigger_source"]);
      const trigger_source: "manual" | "auto" =
        explicitSource === "auto"
          ? "auto"
          : explicitSource === "manual"
            ? "manual"
            : userId
              ? "manual"
              : "auto";
      return {
        id: str(row["id"]),
        kind: "inquiry" as const,
        status: pickStatus(row),
        status_code: pickStatusCode(row),
        status_text: pickStatusText(row),
        requested_at: pickTimestamp(row, ["requested_at"]),
        received_at: pickTimestamp(row, [
          "received_at",
          "responded_at",
        ]),
        created_at: pickTimestamp(row, ["created_at"]),
        triggered_by_user_id: userId,
        triggered_by_display_name: userId
          ? userNameById.get(userId) ?? null
          : null,
        trigger_source,
      };
    });

    // 276/277 EDI transactions for the same claim (org-scoped).
    const txResp = await (supabase as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (k: string, v: string) => {
            eq: (k: string, v: string) => {
              in: (k: string, v: string[]) => {
                order: (
                  k: string,
                  opts: { ascending: boolean },
                ) => Promise<{ data: Row[] | null; error: { message: string } | null }>;
              };
            };
          };
        };
      };
    })
      .from("edi_transactions")
      .select(
        "id, transaction_type, direction, status, control_number, sent_at, received_at, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("claim_id", claimId)
      .in("transaction_type", ["276", "277"])
      .order("created_at", { ascending: false });

    if (txResp.error) {
      return NextResponse.json(
        { success: false, error: txResp.error.message },
        { status: 500 },
      );
    }

    const transactions = (txResp.data ?? []).map((row) => ({
      id: str(row["id"]),
      kind: "edi" as const,
      transaction_type: str(row["transaction_type"]),
      direction: str(row["direction"]),
      status: str(row["status"]),
      control_number: str(row["control_number"]),
      sent_at: pickTimestamp(row, ["sent_at"]),
      received_at: pickTimestamp(row, ["received_at"]),
      created_at: pickTimestamp(row, ["created_at"]),
    }));

    return NextResponse.json({
      success: true,
      inquiries,
      transactions,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
