import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  clearPortalSessionCookie,
  getPortalSession,
} from "@/lib/portal/session";
import { startInvoiceCheckout } from "@/lib/portal/invoiceCheckout";

async function resolveAppBaseUrl(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_APP_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (replit) return `https://${replit}`;
  const hdrs = await headers();
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "";
  return host ? `${proto}://${host}` : "";
}

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

type PortalData = {
  patientName: string;
  practiceName: string;
  appointments: Array<{
    id: string;
    startsAt: string | null;
    endsAt: string | null;
    status: string;
    type: string;
    providerName: string;
    telehealthUrl: string | null;
  }>;
  balance: {
    total: number;
    invoices: Array<{
      id: string;
      number: string;
      status: string;
      amount: number;
      paid: number;
      balance: number;
    }>;
  };
  documents: Array<{
    id: string;
    title: string;
    type: string;
    fileName: string | null;
    createdAt: string | null;
    downloadHref: string;
  }>;
};

async function loadPortalData(
  clientId: string,
  organizationId: string,
): Promise<PortalData | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;

  const nowIso = new Date().toISOString();

  const [clientRes, orgRes, apptsRes, invoicesRes, docsRes] = await Promise.all([
    supabase
      .from("clients")
      .select("first_name, last_name, preferred_name")
      .eq("id", clientId)
      .maybeSingle(),
    supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
    supabase
      .from("appointments")
      .select(
        "id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, provider_id, telehealth_url",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .gte("scheduled_start_at", nowIso)
      .neq("appointment_status", "cancelled")
      .order("scheduled_start_at", { ascending: true })
      .limit(20),
    supabase
      .from("patient_invoices")
      .select(
        "id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .in("invoice_status", ["open", "sent", "collections"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("documents")
      .select("id, title, document_type, file_name, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .eq("patient_visible", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const client = (clientRes.data ?? {}) as Row;
  const practiceName =
    value((orgRes.data as Row | null)?.name) || "Your care team";
  const patientName =
    value(client.preferred_name) || value(client.first_name) || "there";

  const apptRows = (apptsRes.data ?? []) as Row[];
  const providerIds = Array.from(
    new Set(apptRows.map((r) => value(r.provider_id)).filter(Boolean)),
  );
  let providerNameById = new Map<string, string>();
  if (providerIds.length > 0) {
    const { data: provRows } = await supabase
      .from("providers")
      .select("id, first_name, last_name")
      .in("id", providerIds);
    providerNameById = new Map(
      ((provRows ?? []) as Row[]).map((r) => {
        const name = [value(r.first_name), value(r.last_name)].filter(Boolean).join(" ");
        return [value(r.id), name || "Your provider"];
      }),
    );
  }

  const appointments = apptRows.map((r) => ({
    id: value(r.id),
    startsAt: (r.scheduled_start_at as string | null) ?? null,
    endsAt: (r.scheduled_end_at as string | null) ?? null,
    status: value(r.appointment_status) || "scheduled",
    type: value(r.appointment_type),
    providerName: providerNameById.get(value(r.provider_id)) || "Your provider",
    telehealthUrl: (r.telehealth_url as string | null) ?? null,
  }));

  const invoiceRows = (invoicesRes.data ?? []) as Row[];
  const invoices = invoiceRows.map((r) => ({
    id: value(r.id),
    number: value(r.invoice_number) || value(r.id).slice(0, 8),
    status: value(r.invoice_status),
    amount: Number(r.patient_responsibility_amount ?? 0) || 0,
    paid: Number(r.paid_amount ?? 0) || 0,
    balance: Number(r.balance_amount ?? 0) || 0,
  }));
  const total = invoices.reduce((sum, inv) => sum + inv.balance, 0);

  const documents = ((docsRes.data ?? []) as Row[]).map((r) => ({
    id: value(r.id),
    title: value(r.title) || value(r.file_name) || "Untitled document",
    type: value(r.document_type) || "document",
    fileName: (r.file_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    downloadHref: `/api/portal/documents/${value(r.id)}`,
  }));

  return {
    patientName,
    practiceName,
    appointments,
    balance: { total, invoices },
    documents,
  };
}

async function signOut() {
  "use server";
  await clearPortalSessionCookie();
  redirect("/portal/signed-out");
}

async function payInvoiceAction(formData: FormData) {
  "use server";
  const session = await getPortalSession();
  if (!session) {
    redirect("/portal/signed-out");
  }
  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  if (!invoiceId) {
    redirect("/portal/payments/return?status=error&reason=missing_invoice");
  }
  const rawAmount = String(formData.get("amount") ?? "").trim();
  let amountDollars: number | undefined;
  if (rawAmount) {
    const parsed = Number(rawAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      redirect(
        `/portal/payments/return?status=error&reason=invalid_amount&invoice=${encodeURIComponent(invoiceId)}`,
      );
    }
    amountDollars = parsed;
  }
  const baseUrl = await resolveAppBaseUrl();
  const result = await startInvoiceCheckout({
    session: session!,
    invoiceId,
    baseUrl,
    amountDollars,
  });
  if (!result.ok) {
    redirect(
      `/portal/payments/return?status=error&reason=${encodeURIComponent(result.code)}&invoice=${encodeURIComponent(invoiceId)}`,
    );
  }
  redirect(result.url);
}

export default async function PatientPortalHomePage() {
  const session = await getPortalSession();
  if (!session) redirect("/portal/signed-out");

  const data = await loadPortalData(session.clientId, session.organizationId);
  if (!data) {
    return (
      <main className="portal-shell-narrow">
        <div className="portal-header">
          <div>
            <div className="eyebrow">Patient portal</div>
            <h1>Portal unavailable</h1>
          </div>
        </div>
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>
            We could not load your portal right now. Please try again later.
          </p>
        </section>
      </main>
    );
  }

  const { patientName, practiceName, appointments, balance, documents } = data;

  return (
    <main className="portal-shell">
      <header className="portal-header">
        <div>
          <div className="eyebrow">{practiceName}</div>
          <h1>Hi, {patientName}</h1>
        </div>
        <form action={signOut}>
          <button type="submit" className="button button-secondary">
            Sign out
          </button>
        </form>
      </header>

      {/* Upcoming appointments */}
      <section className="panel portal-section" aria-labelledby="appts-heading">
        <h2 id="appts-heading" className="portal-section-title">
          Upcoming appointments
        </h2>
        {appointments.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            You have no upcoming appointments scheduled.
          </p>
        ) : (
          <div>
            {appointments.map((appt) => (
              <div key={appt.id} className="portal-item-row">
                <div>
                  <div className="portal-item-title">{formatDateTime(appt.startsAt)}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {appt.type || "Appointment"} with {appt.providerName}
                  </div>
                  {appt.telehealthUrl ? (
                    <a
                      href={appt.telehealthUrl}
                      className="portal-join-link"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Join telehealth visit
                    </a>
                  ) : null}
                </div>
                <span className="status">{appt.status.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Outstanding balance */}
      <section className="panel portal-section" aria-labelledby="balance-heading">
        <h2 id="balance-heading" className="portal-section-title">
          Outstanding balance
        </h2>
        <div
          className={`portal-balance-amount${balance.total > 0 ? " has-balance" : ""}`}
        >
          {formatMoney(balance.total)}
        </div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          {balance.invoices.length === 0
            ? "You have no open invoices."
            : `${balance.invoices.length} open invoice${balance.invoices.length === 1 ? "" : "s"}.`}
        </div>
        {balance.invoices.map((inv) => (
          <div key={inv.id} className="portal-item-row">
            <div>
              <div className="portal-item-title">Invoice #{inv.number}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {formatMoney(inv.amount)} billed · {formatMoney(inv.paid)} paid
              </div>
            </div>
            <div className="portal-item-right">
              <div className="portal-item-title" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(inv.balance)}
              </div>
              {inv.balance > 0 ? (
                <details className="portal-pay-details">
                  <summary
                    className="button portal-pay-summary"
                    style={{ listStyle: "none", userSelect: "none" }}
                  >
                    Pay
                  </summary>
                  <form action={payInvoiceAction} className="portal-pay-picker">
                    <input type="hidden" name="invoiceId" value={inv.id} />
                    <label htmlFor={`pay-amount-${inv.id}`}>
                      Amount to pay (max {formatMoney(inv.balance)})
                    </label>
                    <div className="portal-pay-amount-row">
                      <span>$</span>
                      <input
                        id={`pay-amount-${inv.id}`}
                        type="number"
                        name="amount"
                        min="0.50"
                        max={inv.balance.toFixed(2)}
                        step="0.01"
                        defaultValue={inv.balance.toFixed(2)}
                        required
                      />
                    </div>
                    <button type="submit" className="button">
                      Continue to checkout
                    </button>
                  </form>
                </details>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      {/* Documents */}
      <section className="panel portal-section" aria-labelledby="docs-heading">
        <h2 id="docs-heading" className="portal-section-title">
          Documents
        </h2>
        {documents.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No documents have been shared with you yet.
          </p>
        ) : (
          documents.map((doc) => (
            <div key={doc.id} className="portal-item-row">
              <div>
                <div className="portal-item-title">{doc.title}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {doc.type.replace(/_/g, " ")}
                  {doc.createdAt ? ` · ${formatDate(doc.createdAt)}` : ""}
                  {doc.fileName ? ` · ${doc.fileName}` : ""}
                </div>
              </div>
              <a href={doc.downloadHref} className="button portal-item-action" download>
                Download
              </a>
            </div>
          ))
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
          Only documents your care team has shared appear here. To request another document,
          please contact {practiceName}.
        </p>
      </section>
    </main>
  );
}
