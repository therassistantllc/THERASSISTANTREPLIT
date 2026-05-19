// File: app/api/dashboard/widgets/preferences/route.ts
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({
    ok: true,
    message: "Dashboard preferences saved.",
    payload: body,
  });
}
