// @ts-expect-error - Deno edge runtime URL import is valid at runtime but not resolvable by this TS config.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL")!;

serve(async (req: Request) => {
  const url = new URL(req.url);
  const organizationId = url.searchParams.get("organization_id");

  if (!organizationId) {
    return new Response("Missing organization_id", { status: 400 });
  }

const redirectUri =
  "https://btsbmozbggjllpcsuyyy.supabase.co/functions/v1/gmail-oauth-callback";
  const state = btoa(JSON.stringify({
    organization_id: organizationId,
    return_to: `${APP_BASE_URL}/settings/integrations/gmail`,
  }));

  const oauthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  oauthUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  oauthUrl.searchParams.set("redirect_uri", redirectUri);
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set("access_type", "offline");
  oauthUrl.searchParams.set("prompt", "consent");
  oauthUrl.searchParams.set("include_granted_scopes", "true");
  oauthUrl.searchParams.set("scope", [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "openid",
    "email",
    "profile",
  ].join(" "));
  oauthUrl.searchParams.set("state", state);

  return Response.redirect(oauthUrl.toString(), 302);
});