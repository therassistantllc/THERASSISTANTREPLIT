// File: app/layout.tsx
import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import { headers } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: "THERASSISTANT EHR",
  description: "Clinician-first EHR and revenue cycle workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const hdrs = headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  const isBillingTheme = pathname.startsWith("/billing");
  const isPatientTheme = pathname.startsWith("/portal") || pathname.startsWith("/check-in");

  return (
    <html lang="en">
      <body className={`${inter.variable} ${manrope.variable} ${isBillingTheme ? "theme-billing" : ""} ${isPatientTheme ? "theme-patient" : ""}`.trim()}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
