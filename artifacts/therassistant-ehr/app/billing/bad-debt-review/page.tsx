import LiveQueueClient from "@/components/billing/LiveQueueClient";

export const metadata = { title: "Bad Debt Review" };

const formatDate = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};
const formatMoney = (v: unknown) =>
  Number(v ?? 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function BadDebtReviewPage() {
  return (
    <LiveQueueClient
      queueId="bad_debt_review"
      endpoint="bad-debt-review"
      filterUrlNamespace="bad_debt"
      summaryLabels={{ count: "Proposed write-offs", dollars: "Proposed $" }}
      tabs={[
        { id: "proposed", label: "Proposed" },
        { id: "approved", label: "Approved" },
        { id: "denied", label: "Denied" },
        { id: "written_off", label: "Written Off" },
      ]}
      columns={[
        { id: "client", header: "Client", cell: (r) => String(r.client ?? "—") },
        { id: "guarantor", header: "Guarantor", cell: (r) => String(r.guarantor ?? "—") },
        {
          id: "balance",
          header: "Balance",
          align: "right",
          cell: (r) => <strong>{formatMoney(r.balance)}</strong>,
        },
        { id: "oldest_dos", header: "Oldest DOS", cell: (r) => formatDate(r.oldest_dos) },
        {
          id: "statements_sent",
          header: "Statements sent",
          align: "right",
          cell: (r) => String(r.statements_sent ?? 0),
        },
        { id: "last_payment", header: "Last payment", cell: (r) => formatDate(r.last_payment) },
        { id: "proposed_by", header: "Proposed by", cell: (r) => String(r.proposed_by ?? "—") },
        { id: "supervisor", header: "Supervisor", cell: (r) => String(r.supervisor ?? "—") },
      ]}
      actions={[
        { id: "approve", label: "Approve write-off", variant: "primary" },
        { id: "deny", label: "Deny", variant: "danger" },
        { id: "mark_written_off", label: "Mark written off" },
        { id: "reopen", label: "Reopen" },
      ]}
      detailFields={[
        { label: "Client", value: (r) => String(r.client ?? "—") },
        { label: "Balance", value: (r) => formatMoney(r.balance) },
        { label: "Oldest DOS", value: (r) => formatDate(r.oldest_dos) },
        { label: "Last payment", value: (r) => formatDate(r.last_payment) },
      ]}
    />
  );
}
