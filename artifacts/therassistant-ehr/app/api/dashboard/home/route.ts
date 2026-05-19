// File: app/api/dashboard/home/route.ts
import { NextResponse } from "next/server";
import { buildHomeDashboardPayload } from "@/lib/dashboard/homeData";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const role = searchParams.get("role") ?? "admin_biller";
  return NextResponse.json(buildHomeDashboardPayload(role));
}
