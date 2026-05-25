export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "calc(100dvh - 44px)", minWidth: 0 }}>
      {children}
    </div>
  );
}
