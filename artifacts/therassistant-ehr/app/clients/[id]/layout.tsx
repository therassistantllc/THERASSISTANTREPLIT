import type React from "react";
import PatientContextBanner from "@/components/layout/PatientContextBanner";
import ClientTabNav from "./ClientTabNav";

export default async function ClientChartLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <PatientContextBanner clientId={id} />
      <ClientTabNav clientId={id} />
      {children}
    </>
  );
}
