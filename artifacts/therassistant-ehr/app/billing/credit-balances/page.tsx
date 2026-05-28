import LiveQueueClient from "@/components/billing/LiveQueueClient";

export const metadata = { title: "Credit Balances" };

const formatDate = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};
const formatMoney = (v: unknown) =>
  Number(v ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function CreditBalancesPage() {
  return (
    <LiveQueueClient
      queueId="credit_balances"
      endpoint="credit-balances"
      filterUrlNamespace="credit_balances"
      summaryLabels={{ count: "Accounts with credit", dollars: "Credit $" }}
      tabs={[
        { id: "client", label: "Client Credits" },
        { id: "payer", label: "Payer Credits" },
        { id: "needs_refund", label: "Needs Refund" },
        { id: "transfer_pending", label: "Transfer Pending" },
        { id: "resolved", label: "Resolved" },
      ]}
      columns={[
        { id: "holder", header: "Client / Payer", cell: (r) => String(r.holder ?? "—") },
        { id: "account", header: "Account / Claim", cell: (r) => String(r.account ?? "—") },
        {
          id: "balance",
          header: "Credit $",
          align: "right",
          cell: (r) => <strong>{formatMoney(r.balance)}</strong>,
        },
        { id: "since", header: "Outstanding since", cell: (r) => formatDate(r.since) },
        {
          id: "age",
          header: "Age (days)",
          align: "right",
          cell: (r) => (r.age_days == null ? "—" : String(r.age_days)),
        },
        { id: "proposed_action", header: "Proposed action", cell: (r) => String(r.proposed_action ?? "—") },
        { id: "assigned", header: "Assigned to", cell: (r) => String(r.assigned ?? "—") },
      ]}
      actions={[
        { id: "propose_refund", label: "Propose refund", variant: "primary" },
        { id: "transfer", label: "Transfer credit" },
        { id: "resolve", label: "Mark resolved" },
        { id: "reopen", label: "Reopen" },
      ]}
      detailFields={[
        { label: "Holder", value: (r) => String(r.holder ?? "—") },
        { label: "Credit", value: (r) => formatMoney(r.balance) },
        { label: "Outstanding since", value: (r) => formatDate(r.since) },
        { label: "Proposed action", value: (r) => String(r.proposed_action ?? "—") },
      ]}
    />
  );
}
