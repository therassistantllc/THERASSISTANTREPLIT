import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Patient Portal",
  description: "Your patient portal",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: "100dvh", background: "var(--background)" }}>{children}</div>;
}
