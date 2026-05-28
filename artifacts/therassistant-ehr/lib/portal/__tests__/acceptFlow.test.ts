/**
 * End-to-end coverage for the portal invite accept flow.
 *
 * Pins the contract between `/portal/{token}` and `/portal/home`:
 *  - a pending invite + accept action sets the session cookie, flips
 *    portal_invites.status to 'accepted' and clients.portal_status to
 *    'active', and the home page then renders the client's data.
 *  - a revoked invite renders the revoked error page and NEVER sets a
 *    session cookie.
 *  - an expired invite renders the expired error page and NEVER sets a
 *    session cookie.
 */
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

process.env.PORTAL_SESSION_SECRET = "test-secret-portal-1234567890abcdef";

type Row = Record<string, unknown>;

const TOKEN = "tok-accept-1";
const INVITE_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";

type Update = {
  table: string;
  payload: Row;
  filters: Array<{ field: string; value: unknown }>;
};

const state: {
  inviteRow: Row | null;
  clientRow: Row | null;
  orgRow: Row | null;
  listRows: Record<string, Row[]>;
  updates: Update[];
  cookieJar: Map<string, string>;
  redirects: string[];
} = {
  inviteRow: null,
  clientRow: null,
  orgRow: null,
  listRows: {},
  updates: [],
  cookieJar: new Map(),
  redirects: [],
};

function resetState() {
  state.inviteRow = null;
  state.clientRow = null;
  state.orgRow = { name: "Test Practice" };
  state.listRows = {
    appointments: [],
    patient_invoices: [],
    documents: [],
    providers: [],
  };
  state.updates = [];
  state.cookieJar = new Map();
  state.redirects = [];
}

function makeSupabase() {
  function builder(table: string, op: "select" | "update", payload?: Row) {
    const filters: Array<{ field: string; value: unknown }> = [];
    let asSingle = false;

    function settle(): { data: Row | Row[] | null; error: null } {
      if (op === "update") {
        state.updates.push({
          table,
          payload: payload ?? {},
          filters: [...filters],
        });
        if (table === "portal_invites" && state.inviteRow) {
          state.inviteRow = { ...state.inviteRow, ...(payload ?? {}) };
        } else if (table === "clients" && state.clientRow) {
          state.clientRow = { ...state.clientRow, ...(payload ?? {}) };
        }
        return { data: null, error: null };
      }
      if (asSingle) {
        let data: Row | null = null;
        if (table === "portal_invites") data = state.inviteRow;
        else if (table === "clients") data = state.clientRow;
        else if (table === "organizations") data = state.orgRow;
        return { data, error: null };
      }
      return { data: state.listRows[table] ?? [], error: null };
    }

    const chain: Record<string, unknown> = {};
    const noop = () => chain;
    chain.eq = (f: string, v: unknown) => {
      filters.push({ field: f, value: v });
      return chain;
    };
    chain.is = noop;
    chain.gte = noop;
    chain.neq = noop;
    chain.in = noop;
    chain.order = noop;
    chain.limit = noop;
    chain.select = noop;
    chain.maybeSingle = async () => {
      asSingle = true;
      return settle();
    };
    chain.single = async () => {
      asSingle = true;
      return settle();
    };
    chain.then = (resolve: (v: ReturnType<typeof settle>) => unknown) =>
      Promise.resolve(resolve(settle()));
    return chain;
  }

  return {
    from(table: string) {
      return {
        select: (..._a: unknown[]) => builder(table, "select"),
        update: (payload: Row) => builder(table, "update", payload),
      };
    },
  };
}

before(() => {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createServerSupabaseAdminClient: () => makeSupabase(),
    },
  });

  mock.module("next/navigation", {
    namedExports: {
      redirect: (url: string) => {
        state.redirects.push(url);
        const e = new Error(`NEXT_REDIRECT:${url}`);
        (e as Error & { digest?: string }).digest = `NEXT_REDIRECT;${url}`;
        throw e;
      },
    },
  });

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({
        get: (name: string) => {
          const v = state.cookieJar.get(name);
          return v === undefined ? undefined : { name, value: v };
        },
        set: (opts: { name: string; value: string }) => {
          if (!opts.value) state.cookieJar.delete(opts.name);
          else state.cookieJar.set(opts.name, opts.value);
        },
      }),
    },
  });
});

type ReactNodeLike =
  | null
  | undefined
  | boolean
  | string
  | number
  | { type: unknown; props: { children?: ReactNodeLike } & Record<string, unknown> }
  | ReactNodeLike[];

function walkForm(node: ReactNodeLike): { props: Record<string, unknown> } | null {
  if (node == null || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = walkForm(c);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.type === "form") {
    return node as { props: Record<string, unknown> };
  }
  return walkForm(node.props.children ?? null);
}

function collectText(node: ReactNodeLike): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object") return collectText(node.props.children ?? null);
  return "";
}

async function renderInvitePage(token: string): Promise<ReactNodeLike> {
  const mod = await import("../../../app/portal/[token]/page");
  const Page = mod.default as (a: {
    params: Promise<{ token: string }>;
  }) => Promise<ReactNodeLike>;
  return Page({ params: Promise.resolve({ token }) });
}

async function renderHomePage(): Promise<ReactNodeLike> {
  const mod = await import("../../../app/portal/home/page");
  const Page = mod.default as () => Promise<ReactNodeLike>;
  return Page();
}

test("accept flow: pending invite -> session cookie + home page renders client data", async () => {
  resetState();
  state.inviteRow = {
    id: INVITE_ID,
    organization_id: ORG_ID,
    client_id: CLIENT_ID,
    status: "pending",
    expires_at: null,
    accepted_at: null,
  };
  state.clientRow = {
    id: CLIENT_ID,
    first_name: "Alice",
    last_name: "Client",
    preferred_name: null,
    portal_status: "pending",
  };

  const page = await renderInvitePage(TOKEN);
  const form = walkForm(page);
  assert.ok(form, "pending invite page must render a form");
  const action = form!.props.action as () => Promise<void>;
  assert.equal(typeof action, "function", "form action must be the accept server action");

  // The accept action calls redirect() which our mock throws — that is success.
  await assert.rejects(() => action(), /NEXT_REDIRECT:\/portal\/home/);

  // Redirect target is the portal home page.
  assert.deepEqual(state.redirects, ["/portal/home"]);

  // portal_invites.status flipped to 'accepted' (filtered by the invite id).
  const inviteUpdate = state.updates.find(
    (u) =>
      u.table === "portal_invites" &&
      (u.payload as Row).status === "accepted" &&
      u.filters.some((f) => f.field === "id" && f.value === INVITE_ID),
  );
  assert.ok(inviteUpdate, "expected portal_invites.status to be set to 'accepted'");
  assert.ok(
    (inviteUpdate!.payload as Row).accepted_at,
    "expected accepted_at to be stamped on the invite row",
  );

  // clients.portal_status flipped to 'active' (filtered by the client id).
  const clientUpdate = state.updates.find(
    (u) =>
      u.table === "clients" &&
      (u.payload as Row).portal_status === "active" &&
      u.filters.some((f) => f.field === "id" && f.value === CLIENT_ID),
  );
  assert.ok(clientUpdate, "expected clients.portal_status to be set to 'active'");

  // The state row reflects the writes (our fake mutates in-place).
  assert.equal((state.inviteRow as Row).status, "accepted");
  assert.equal((state.clientRow as Row).portal_status, "active");

  // A session cookie was set.
  const cookie = state.cookieJar.get("ta_portal_session");
  assert.ok(cookie, "expected ta_portal_session cookie to be set after accept");
  assert.ok(cookie!.includes("."), "session cookie must be a payload.sig token");

  // Home page now picks up the session and renders the client's name.
  const home = await renderHomePage();
  const text = collectText(home);
  assert.match(text, /Hi,\s+Alice/, "home page must greet the signed-in client by name");
  assert.match(text, /Test Practice/, "home page must show the practice name");
  // No redirect to /portal/signed-out happened on the home render.
  assert.equal(
    state.redirects.filter((r) => r === "/portal/signed-out").length,
    0,
    "home page must not redirect to signed-out when a valid session cookie is present",
  );
});

test("revoked invite: renders revoked error page and does NOT set a session cookie", async () => {
  resetState();
  state.inviteRow = {
    id: INVITE_ID,
    organization_id: ORG_ID,
    client_id: CLIENT_ID,
    status: "revoked",
    expires_at: null,
    accepted_at: null,
  };
  state.clientRow = {
    id: CLIENT_ID,
    first_name: "Alice",
    last_name: "Client",
    preferred_name: null,
    portal_status: "pending",
  };

  const page = await renderInvitePage(TOKEN);
  const text = collectText(page);
  assert.match(text, /revoked/i, "revoked invite must render the revoked error copy");

  // No accept form is rendered on the error page.
  assert.equal(walkForm(page), null, "revoked invite page must not render an accept form");

  // No cookie was ever set.
  assert.equal(
    state.cookieJar.get("ta_portal_session"),
    undefined,
    "revoked invite must not set the portal session cookie",
  );
  // No writes happened on the revoked path.
  assert.equal(state.updates.length, 0, "revoked invite must not mutate the database");
});

test("expired invite: renders expired error page and does NOT set a session cookie", async () => {
  resetState();
  state.inviteRow = {
    id: INVITE_ID,
    organization_id: ORG_ID,
    client_id: CLIENT_ID,
    status: "pending",
    // 1 day in the past
    expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    accepted_at: null,
  };
  state.clientRow = {
    id: CLIENT_ID,
    first_name: "Alice",
    last_name: "Client",
    preferred_name: null,
    portal_status: "pending",
  };

  const page = await renderInvitePage(TOKEN);
  const text = collectText(page);
  assert.match(text, /expired/i, "expired invite must render the expired error copy");

  // No accept form is rendered on the error page.
  assert.equal(walkForm(page), null, "expired invite page must not render an accept form");

  // No cookie was ever set.
  assert.equal(
    state.cookieJar.get("ta_portal_session"),
    undefined,
    "expired invite must not set the portal session cookie",
  );
  // No writes happened on the expired path.
  assert.equal(state.updates.length, 0, "expired invite must not mutate the database");
});
