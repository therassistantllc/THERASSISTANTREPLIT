import type React from "react";
import PatientContextBanner from "@/components/layout/PatientContextBanner";
import PatientTabNav from "./PatientTabNav";

export default async function PatientChartLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;

  return (
    <>
      <PatientContextBanner clientId={clientId} />
      <PatientTabNav clientId={clientId} />
      {children}
    </>
  );
}
