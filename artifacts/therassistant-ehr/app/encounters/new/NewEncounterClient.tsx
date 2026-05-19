"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function getAppointmentId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("appointmentId") || "";
}

export default function NewEncounterClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const appointmentId = useMemo(() => getAppointmentId(), []);
  const [status, setStatus] = useState("Preparing encounter…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function createOrOpenEncounter() {
      if (!organizationId || !appointmentId) {
        setError("Missing organizationId or appointmentId.");
        return;
      }

      try {
        const response = await fetch("/api/encounters/create-from-appointment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, appointmentId }),
        });
        const json = (await response.json()) as { success?: boolean; encounterId?: string; error?: string };
        if (cancelled) return;

        if (!response.ok || !json.success || !json.encounterId) {
          throw new Error(json.error ?? "Unable to create encounter.");
        }

        setStatus("Opening note…");
        window.location.assign(`/encounters/${json.encounterId}?organizationId=${encodeURIComponent(organizationId)}`);
      } catch (createError) {
        if (!cancelled) setError(createError instanceof Error ? createError.message : "Unable to create encounter.");
      }
    }

    createOrOpenEncounter();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, organizationId]);

  return (
    <main className="app-shell">
      <section className="panel">
        <h1>Open Encounter</h1>
        {error ? <div className="alert-panel">{error}</div> : <p className="muted">{status}</p>}
        <div className="section-actions">
          <Link className="button button-secondary" href="/clinician/agenda">Return to Agenda</Link>
        </div>
      </section>
    </main>
  );
}
