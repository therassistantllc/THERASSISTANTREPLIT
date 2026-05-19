// @ts-expect-error - Deno edge runtime URL import is valid at runtime but not resolvable by this TS config.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-expect-error - Deno npm: specifier is valid at runtime but not resolvable by this TS config.
import { createClient } from "npm:@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL")!;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function googleGet(path: string, accessToken: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Google API error ${res.status}: ${await res.text()}`);
  }

  return await res.json();
}

serve(async (req: { url: string | URL; }) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state");

    if (!code || !stateRaw) {
      return new Response("Missing code/state", { status: 400 });
    }

    const state = JSON.parse(atob(stateRaw));
    const organizationId = state.organization_id;

const redirectUri =
  "https://btsbmozbggjllpcsuyyy.supabase.co/functions/v1/gmail-oauth-callback";
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(await tokenRes.text());
    }

    const token = await tokenRes.json();

    if (!token.refresh_token) {
      throw new Error("Google did not return refresh_token. Reconnect with prompt=consent.");
    }

    const profile = await googleGet("/users/me/profile", token.access_token);
    const email = profile.emailAddress;

    const { data: connection, error: connError } = await supabase
      .from("integration_connections")
      .upsert({
        organization_id: organizationId,
        integration_type: "gmail",
        connection_status: "connected",
        display_name: `Gmail - ${email}`,
        external_account_email: email,
        metadata: {},
        sync_error: null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "organization_id,integration_type",
      })
      .select("id, organization_id")
      .single();

    if (connError) throw connError;

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

    const { error: tokenError } = await supabase
      .from("gmail_oauth_tokens")
      .upsert({
        organization_id: organizationId,
        integration_connection_id: connection.id,
        email,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: token.token_type,
        scope: token.scope,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "integration_connection_id",
      });

    if (tokenError) throw tokenError;

    const { error: updateError } = await supabase
      .from("integration_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    if (updateError) throw updateError;

    return Response.redirect(`${APP_BASE_URL}/settings/integrations/gmail?connected=1`, 302);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 500 });
  }
});