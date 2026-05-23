// File: lib/supabase/server.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

function getServiceRoleKey() {
  // Only accept server-side env vars. NEXT_PUBLIC_ prefixed vars are bundled
  // into client JavaScript and must never hold a service role key.
  const candidates = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

export function createServerSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = getServiceRoleKey();
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const apiKey = serviceRole ?? anonKey;

  if (!url || !apiKey) {
    return null;
  }

  return createClient(url, apiKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function createServerSupabaseAdminClientTyped(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = getServiceRoleKey();
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const apiKey = serviceRole ?? anonKey;

  if (!url || !apiKey) {
    return null;
  }

  return createClient<Database>(url, apiKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function createServerSupabaseServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = getServiceRoleKey();

  if (!url || !serviceRole) {
    return null;
  }

  return createClient(url, serviceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function createServerSupabaseServiceRoleClientTyped(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = getServiceRoleKey();

  if (!url || !serviceRole) {
    return null;
  }

  return createClient<Database>(url, serviceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
