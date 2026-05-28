"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const TABS = [
  { label: "ERA Import", href: "/billing/payments/era", match: "/billing/payments/era" },
  { label: "Manual Insurance", href: "/billing/payments/manual-insurance", match: "/billing/payments/manual-insurance" },
  { label: "Client Payments", href: "/billing/payments/patient", match: "/billing/payments/patient" },
  { label: "Posted", href: "/billing/payments/posted", match: "/billing/payments/posted" },
  { label: "Audit", href: "/billing/payments/audit", match: "/billing/payments/audit" },
  { label: "ERA Queue", href: "/billing/payments", match: "exact:/billing/payments" },
] as const;

export default function PaymentsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  function isActive(match: string) {
    if (match.startsWith("exact:")) return pathname === match.slice("exact:".length);
    return pathname.startsWith(match);
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Tab bar */}
      <div
        className="flex items-end gap-1 px-5 border-b overflow-x-auto"
        style={{ borderColor: "var(--line)", background: "var(--card)", minHeight: 42 }}
      >
        {TABS.map((tab) => {
          const active = isActive(tab.match);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex-shrink-0 px-3.5 pb-2.5 pt-2 text-sm font-medium rounded-t-lg transition-colors"
              style={{
                color: active ? "var(--navy)" : "var(--muted)",
                borderBottom: active ? "2px solid var(--navy)" : "2px solid transparent",
                background: "transparent",
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* Page content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {children}
      </div>
    </div>
  );
}
