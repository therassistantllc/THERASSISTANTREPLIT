export type TelehealthPlatform = "zoom" | "google_meet";

export type PlatformOAuthConfig = {
  platform: TelehealthPlatform;
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
};

export type PlatformStatus = {
  platform: TelehealthPlatform;
  configured: boolean;
  missingEnv: string[];
};

const ZOOM_AUTH_URL = "https://zoom.us/oauth/authorize";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_SCOPES = ["meeting:write:meeting", "meeting:read:meeting", "user:read:user"];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
];

export function getPlatformConfig(platform: TelehealthPlatform): PlatformOAuthConfig | null {
  if (platform === "zoom") {
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      platform: "zoom",
      clientId,
      clientSecret,
      authUrl: ZOOM_AUTH_URL,
      tokenUrl: ZOOM_TOKEN_URL,
      scopes: ZOOM_SCOPES,
    };
  }
  if (platform === "google_meet") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      platform: "google_meet",
      clientId,
      clientSecret,
      authUrl: GOOGLE_AUTH_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      scopes: GOOGLE_SCOPES,
    };
  }
  return null;
}

export function getPlatformStatus(platform: TelehealthPlatform): PlatformStatus {
  const encKey = process.env.TELEHEALTH_TOKEN_ENC_KEY;
  const encMissing = !encKey || encKey.length < 24;
  if (platform === "zoom") {
    const missing: string[] = [];
    if (!process.env.ZOOM_CLIENT_ID) missing.push("ZOOM_CLIENT_ID");
    if (!process.env.ZOOM_CLIENT_SECRET) missing.push("ZOOM_CLIENT_SECRET");
    if (encMissing) missing.push("TELEHEALTH_TOKEN_ENC_KEY");
    return { platform, configured: missing.length === 0, missingEnv: missing };
  }
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (encMissing) missing.push("TELEHEALTH_TOKEN_ENC_KEY");
  return { platform: "google_meet", configured: missing.length === 0, missingEnv: missing };
}

export function isTelehealthPlatform(value: unknown): value is TelehealthPlatform {
  return value === "zoom" || value === "google_meet";
}

function platformDisplayName(platform: TelehealthPlatform): string {
  return platform === "zoom" ? "Zoom" : "Google Meet";
}

export function deriveAppOrigin(req: Request): string {
  const envOrigin = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_ORIGIN;
  if (envOrigin) return envOrigin.replace(/\/+$/, "");
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  const host = req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

export function redirectUriFor(platform: TelehealthPlatform, origin: string): string {
  return `${origin}/api/telehealth/oauth/${platform}/callback`;
}
