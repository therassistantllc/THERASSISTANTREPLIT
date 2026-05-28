import LiveQueueClient from "@/components/billing/LiveQueueClient";

export const metadata = { title: "Unposted Payments" };

const formatDate = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};
const formatMoney = (v: unknown) =>
  Number(v ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function UnpostedPaymentsPage() {
  return (
    <LiveQueueClient
      queueId="unposted_payments"
      endpoint="unposted-payments"
      filterUrlNamespace="unposted"
      summaryLabels={{ count: "Unposted payments", dollars: "Unposted $" }}
      tabs={[
        { id: "all", label: "All" },
        { id: "ach", label: "ACH / Lockbox" },
        { id: "check", label: "Check" },
        { id: "card", label: "Card / VCC" },
        { id: "client", label: "Client" },
      ]}
      columns={[
        { id: "received", header: "Received", cell: (r) => formatDate(r.received_at) },
        { id: "source", header: "Source", cell: (r) => String(r.source ?? "—") },
        {
          id: "reference",
          header: "Reference #",
          cell: (r) => (
            <span style={{ fontFamily: "monospace", fontSize: 12 }}>
              {String(r.reference ?? "—")}
            </span>
          ),
        },
        { id: "payer_payor", header: "Payer / Payor", cell: (r) => String(r.payer_name ?? "—") },
        {
          id: "amount",
          header: "Amount",
          align: "right",
          cell: (r) => formatMoney(r.amount),
        },
        {
          id: "age",
          header: "Age (days)",
          align: "right",
          cell: (r) => (r.age_days == null ? "—" : String(r.age_days)),
        },
        { id: "assigned", header: "Assigned to", cell: (r) => String(r.assigned ?? "—") },
        { id: "status", header: "Status", cell: (r) => String(r.status_label ?? "—") },
      ]}
      actions={[
        { id: "assign", label: "Assign to me" },
        { id: "post_to_claim", label: "Post to claim", variant: "primary" },
        { id: "return_to_payer", label: "Return to payer", variant: "danger" },
      ]}
      detailFields={[
        { label: "Source", value: (r) => String(r.source ?? "—") },
        { label: "Reference", value: (r) => String(r.reference ?? "—") },
        { label: "Amount", value: (r) => formatMoney(r.amount) },
        { label: "Received", value: (r) => formatDate(r.received_at) },
        { label: "Status", value: (r) => String(r.status_label ?? "—") },
      ]}
    />
  );
}
