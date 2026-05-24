import BillingSidebar from "@/components/billing/BillingSidebar";

export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "calc(100dvh - 44px)", minWidth: 0 }}>
      <BillingSidebar />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}
