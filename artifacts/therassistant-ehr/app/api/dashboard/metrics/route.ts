// File: app/api/dashboard/metrics/route.ts
import { NextResponse } from "next/server";
import { buildHomeDashboardPayload } from "@/lib/dashboard/homeData";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role") ?? "admin_biller";
  const payload = buildHomeDashboardPayload(role);
  return NextResponse.json({ commandBarMetrics: payload.commandBarMetrics, revenueCycleSnapshot: payload.revenueCycleSnapshot });
}
