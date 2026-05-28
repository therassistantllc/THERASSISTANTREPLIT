import LiveQueueClient from "@/components/billing/LiveQueueClient";

export const metadata = { title: "Write-offs" };

const formatDate = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};
const formatMoney = (v: unknown) =>
  Number(v ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function WriteOffsPage() {
  return (
    <LiveQueueClient
      queueId="write_offs"
      endpoint="write-offs"
      filterUrlNamespace="write_offs"
      summaryLabels={{ count: "Write-offs (this period)", dollars: "Write-off $" }}
      tabs={[
        { id: "recent", label: "Recent" },
        { id: "reversals", label: "Reversals" },
        { id: "by_reason", label: "By Reason" },
      ]}
      columns={[
        { id: "date", header: "Date", cell: (r) => formatDate(r.date) },
        { id: "client", header: "Client", cell: (r) => String(r.client ?? "—") },
        { id: "claim", header: "Claim #", cell: (r) => String(r.claim_number ?? "—") },
        { id: "payer", header: "Payer", cell: (r) => String(r.payer_name ?? "—") },
        { id: "reason", header: "Reason", cell: (r) => String(r.reason ?? "—") },
        {
          id: "amount",
          header: "Amount",
          align: "right",
          cell: (r) => formatMoney(r.amount),
        },
        { id: "posted_by", header: "Posted by", cell: (r) => String(r.posted_by ?? "—") },
        { id: "approved_by", header: "Approved by", cell: (r) => String(r.approved_by ?? "—") },
      ]}
      actions={[
        { id: "flag_for_audit", label: "Flag for audit" },
        { id: "mark_reversal", label: "Mark reversal", variant: "danger" },
      ]}
      detailFields={[
        { label: "Client", value: (r) => String(r.client ?? "—") },
        { label: "Reason", value: (r) => String(r.reason ?? "—") },
        { label: "Amount", value: (r) => formatMoney(r.amount) },
        { label: "Posted by", value: (r) => String(r.posted_by ?? "—") },
        { label: "Posted on", value: (r) => formatDate(r.date) },
      ]}
    />
  );
}
