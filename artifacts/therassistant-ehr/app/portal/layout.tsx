import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Client Portal",
  description: "Your client portal",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: "100dvh", background: "var(--background)" }}>{children}</div>;
}
