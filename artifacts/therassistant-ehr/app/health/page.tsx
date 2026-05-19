import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type EnvCheck = {
  name: string;
  present: boolean;
};

function getEnvChecks(): EnvCheck[] {
  return [
    { name: "NEXT_PUBLIC_SUPABASE_URL", present: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) },
    {
      name: "SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY",
      present: Boolean(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    },
    {
      name: "SUPABASE_SERVICE_ROLE_KEY",
      present: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
  ];
}

async function checkSupabaseConnection() {
  const client = createServerSupabaseAdminClient();

  if (!client) {
    return {
      status: "unavailable",
      detail: "Supabase client could not be created from current environment variables.",
    };
  }

  try {
    const { error } = await client.from("organizations").select("id").limit(1);

    if (!error) {
      return { status: "ok", detail: "Supabase query succeeded." };
    }

    // 42P01 means relation missing, which still confirms DB connectivity.
    if (error.code === "42P01") {
      return {
        status: "ok",
        detail: "Supabase connection reached the database (reference table not present in this environment).",
      };
    }

    return { status: "error", detail: `Supabase query failed: ${error.message}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", detail: `Supabase request error: ${message}` };
  }
}

export default async function HealthPage() {
  const envChecks = getEnvChecks();
  const supabaseCheck = await checkSupabaseConnection();

  return (
    <main>
      <h1>Health</h1>
      <p>App route is loading successfully.</p>

      <h2>Environment Variables</h2>
      <ul>
        {envChecks.map((item) => (
          <li key={item.name}>
            {item.name}: {item.present ? "present" : "missing"}
          </li>
        ))}
      </ul>

      <h2>Supabase Connectivity</h2>
      <p>Status: {supabaseCheck.status}</p>
      <p>Detail: {supabaseCheck.detail}</p>

      <h2>Timestamp</h2>
      <p>{new Date().toISOString()}</p>
    </main>
  );
}
