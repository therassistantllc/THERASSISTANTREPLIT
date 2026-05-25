import Link from "next/link";

export const metadata = { title: "Patient Balances" };

export default function PatientBalancesPage() {
  return (
    <div style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", margin: "8px 0 4px" }}>Patient Balances</h1>
      <p style={{ color: "#64748B", fontSize: 14, marginTop: 0 }}>
        Self-pay balances after insurance — statements, payments, and plans.
      </p>
      <div
        style={{
          marginTop: 24,
          padding: 20,
          background: "#F8FAFC",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          color: "#475569",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        Patient balance management is moving into a single workspace here. In the meantime, the
        existing queues are still available:{" "}
        <Link href="/billing/patient-responsibility" style={{ color: "#1D4ED8", fontWeight: 500 }}>
          Patient Responsibility
        </Link>{" "}
        ·{" "}
        <Link href="/billing/patient-billing" style={{ color: "#1D4ED8", fontWeight: 500 }}>
          Patient Billing
        </Link>{" "}
        ·{" "}
        <Link href="/billing/bad-debt-review" style={{ color: "#1D4ED8", fontWeight: 500 }}>
          Bad Debt Review
        </Link>
        .
      </div>
    </div>
  );
}
