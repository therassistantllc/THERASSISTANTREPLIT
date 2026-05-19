"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type Condition = {
  id: string;
  code: string;
  description: string | null;
  isPrimary: boolean;
  presentOnClaim: boolean;
  encounterId: string;
  encounterDate: string | null;
  createdAt: string | null;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(`${v}`.includes("T") ? v : `${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

export default function ConditionsPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [conditions, setConditions] = useState<Condition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/patients/${clientId}/conditions?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
        const json = await r.json() as { success: boolean; conditions?: Condition[]; error?: string };
        if (cancelled) return;
        if (!json.success) throw new Error(json.error ?? "Failed");
        setConditions(json.conditions ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [clientId, orgId]);

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Conditions &amp; Diagnoses</h2>
        </div>
      </section>

      {loading && <div className="empty-state">Loading conditions…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && conditions.length === 0 && !error && (
        <div className="empty-state">
          No diagnosis codes found. Diagnoses are sourced from encounter service lines.
        </div>
      )}

      {conditions.length > 0 && (
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>ICD-10 Code</th>
                <th>Description</th>
                <th>Primary</th>
                <th>On Claim</th>
                <th>First Noted</th>
                <th>Linked Encounter</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.code}</strong></td>
                  <td>{c.description ?? "—"}</td>
                  <td>{c.isPrimary ? <span className="status status-green">Primary</span> : "—"}</td>
                  <td>{c.presentOnClaim ? "Yes" : "—"}</td>
                  <td>{formatDate(c.encounterDate)}</td>
                  <td>
                    <Link className="inline-link" href={`/encounters/${c.encounterId}${orgQ}`}>
                      Open Encounter
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
