// File: app/api/dashboard/widgets/route.ts
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role") ?? "admin_biller";

  return NextResponse.json({
    role,
    widgets: [
      "today_schedule",
      "revenue_cycle_snapshot",
      "claims_attention",
      "documentation_queue",
      "eligibility_watchlist",
      "patient_balance_queue",
      "tickets",
      "credentialing_tasks",
      "clearinghouse_activity",
    ],
  });
}
