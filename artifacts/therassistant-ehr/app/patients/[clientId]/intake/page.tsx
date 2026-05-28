"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import IntakePanel from "./IntakePanel";

export default function IntakePage() {
  const params = useParams<{ clientId?: string; id?: string }>();
  const clientId = params?.clientId ?? params?.id ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";
  const [patientEmail, setPatientEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = await r.json().catch(() => ({}));
        if (cancelled) return;
        const email = json?.client?.email ?? null;
        setPatientEmail(typeof email === "string" ? email : null);
      } catch {
        // best-effort
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, orgId]);

  if (!clientId) return <div className="empty-state">Missing client id.</div>;
  return <IntakePanel clientId={clientId} patientEmail={patientEmail} />;
}
