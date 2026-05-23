import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const PORTAL_SESSION_COOKIE = "ta_portal_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export type PortalSession = {
  clientId: string;
  organizationId: string;
  inviteId: string;
  issuedAt: number;
};

function getSecret(): string | null {
  const candidates = [
    process.env.PORTAL_SESSION_SECRET,
    process.env.SESSION_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length >= 16) return c.trim();
  }
  return null;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

export function signSession(session: PortalSession): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const payload = base64UrlEncode(JSON.stringify(session));
  const sig = base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): PortalSession | null {
  if (!token) return null;
  const secret = getSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = base64UrlDecode(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  let parsed: PortalSession;
  try {
    parsed = JSON.parse(base64UrlDecode(payload).toString("utf8")) as PortalSession;
  } catch {
    return null;
  }
  if (!parsed?.clientId || !parsed?.organizationId || !parsed?.inviteId) return null;
  const ageSeconds = (Date.now() - Number(parsed.issuedAt || 0)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > SESSION_MAX_AGE_SECONDS) {
    return null;
  }
  return parsed;
}

export async function getPortalSession(): Promise<PortalSession | null> {
  const jar = await cookies();
  const raw = jar.get(PORTAL_SESSION_COOKIE)?.value;
  return verifySessionToken(raw);
}

export async function setPortalSessionCookie(session: PortalSession): Promise<boolean> {
  const token = signSession(session);
  if (!token) return false;
  const jar = await cookies();
  jar.set({
    name: PORTAL_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/portal",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return true;
}

export async function clearPortalSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: PORTAL_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/portal",
    maxAge: 0,
  });
}
