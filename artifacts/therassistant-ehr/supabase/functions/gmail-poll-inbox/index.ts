// @ts-expect-error - Deno edge runtime URL import is valid at runtime but not resolvable by this TS config.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-expect-error - Deno npm: specifier is valid at runtime but not resolvable by this TS config.
import { createClient } from "npm:@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Refresh token failed: ${await res.text()}`);
  }

  return await res.json();
}

async function gmailGet(path: string, accessToken: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Gmail GET failed ${res.status}: ${await res.text()}`);
  }

  return await res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headerValue(headers: any[], name: string) {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function parseEmailAddress(value: string | null) {
  if (!value) return { name: null, email: "" };

  const match = value.match(/^(.*)<(.+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ""),
      email: match[2].trim().toLowerCase(),
    };
  }

  return {
    name: null,
    email: value.trim().toLowerCase(),
  };
}

serve(async () => {
  const result = {
    checked_connections: 0,
    routed_messages: 0,
    errors: [] as string[],
  };

  const { data: connections, error: connError } = await supabase
    .from("integration_connections")
    .select(`
      id,
      organization_id,
      external_account_email,
      last_history_id,
      gmail_oauth_tokens!inner(refresh_token)
    `)
    .eq("integration_type", "gmail")
    .eq("connection_status", "connected");

  if (connError) {
    return Response.json({ error: connError.message }, { status: 500 });
  }

  for (const connection of connections ?? []) {
    result.checked_connections += 1;

    try {
      const tokenRow = Array.isArray(connection.gmail_oauth_tokens)
        ? connection.gmail_oauth_tokens[0]
        : connection.gmail_oauth_tokens;

      if (!tokenRow?.refresh_token) {
        throw new Error("Missing Gmail refresh token");
      }

      const token = await refreshAccessToken(tokenRow.refresh_token);
      const accessToken = token.access_token;

      let messageIds: string[] = [];
      let newHistoryId: string | null = null;

      if (connection.last_history_id) {
        const history = await gmailGet(
          `/users/me/history?startHistoryId=${encodeURIComponent(connection.last_history_id)}&historyTypes=messageAdded`,
          accessToken,
        );

        newHistoryId = history.historyId ?? null;

        const ids = new Set<string>();
        for (const h of history.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            if (added.message?.id) ids.add(added.message.id);
          }
        }

        messageIds = [...ids];
      } else {
        const list = await gmailGet(
          `/users/me/messages?labelIds=INBOX&q=newer_than:7d&maxResults=10`,
          accessToken,
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messageIds = (list.messages ?? []).map((m: any) => m.id);
      }

      for (const messageId of messageIds) {
        const message = await gmailGet(
          `/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken,
        );

        const headers = message.payload?.headers ?? [];
        const fromRaw = headerValue(headers, "From");
        const toRaw = headerValue(headers, "To");
        const subject = headerValue(headers, "Subject");
        const dateRaw = headerValue(headers, "Date");

        const from = parseEmailAddress(fromRaw);
        const receivedAt = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();

        const { error: rpcError } = await supabase.rpc("route_inbound_gmail_message", {
          p_organization_id: connection.organization_id,
          p_integration_connection_id: connection.id,
          p_gmail_message_id: message.id,
          p_gmail_thread_id: message.threadId,
          p_gmail_history_id: String(message.historyId ?? newHistoryId ?? ""),
          p_from_email: from.email,
          p_from_name: from.name,
          p_to_email: toRaw,
          p_subject: subject,
          p_snippet: message.snippet ?? "",
          p_received_at: receivedAt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          p_raw_headers: Object.fromEntries(headers.map((h: any) => [h.name, h.value])),
          p_raw_payload: message,
        });

        if (rpcError) {
          throw rpcError;
        }

        result.routed_messages += 1;
      }

      await supabase
        .from("integration_connections")
        .update({
          last_history_id: newHistoryId,
          last_sync_at: new Date().toISOString(),
          sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", connection.id);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      result.errors.push(`${connection.external_account_email}: ${message}`);

      await supabase
        .from("integration_connections")
        .update({
          sync_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", connection.id);
    }
  }

  return Response.json(result);
});