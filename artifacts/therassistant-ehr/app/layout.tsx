// File: app/layout.tsx
import type { Metadata } from "next";
import AppShell from "@/components/layout/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "THERASSISTANT EHR",
  description: "Clinician-first EHR and revenue cycle workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
