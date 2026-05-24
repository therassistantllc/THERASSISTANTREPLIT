"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";

type Policy = {
  id: string;
  priority: string;
  payerId: string | null;
  payerName: string | null;
  payerType: string | null;
  planName: string | null;
  policyNumber: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
};

type LinkData = {
  organization: { id: string; name: string };
  client: {
    id: string;
    firstName: string;
    lastName: string;
    preferredName: string | null;
  };
  claim: { id: string; claimNumber: string | null };
  policies: Policy[];
  token: string;
  expiresAt: string | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: LinkData }
  | { kind: "done" };

function priorityRank(p: string) {
  return p === "primary" ? 0 : p === "secondary" ? 1 : p === "tertiary" ? 2 : 3;
}

function formatDate(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export default function CobUpdateClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [hasOtherCoverage, setHasOtherCoverage] = useState<"" | "yes" | "no">("");
  const [otherCoverageNote, setOtherCoverageNote] = useState("");
  const [signatureName, setSignatureName] = useState("");
  const [cardFile, setCardFile] = useState<File | null>(null);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function go() {
      try {
        const res = await fetch(`/api/cob-update/${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as
          | { success: true } & LinkData
          | { success: false; error: string };
        if (cancelled) return;
        if (!res.ok || !("success" in json) || !json.success) {
          setState({
            kind: "error",
            message:
              (json as { error?: string }).error ??
              "We could not load this link.",
          });
          return;
        }
        const sortedPolicies = [...json.policies].sort(
          (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
        );
        setOrderedIds(sortedPolicies.map((p) => p.id));
        setState({
          kind: "ready",
          data: { ...json, policies: sortedPolicies },
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load",
        });
      }
    }
    void go();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const policiesById = useMemo(() => {
    if (state.kind !== "ready") return new Map<string, Policy>();
    return new Map(state.data.policies.map((p) => [p.id, p]));
  }, [state]);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setOrderedIds((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const onCardChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setCardFile(file);
    if (!file) {
      setCardPreview(null);
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setCardPreview(dataUrl);
    } catch {
      setCardPreview(null);
    }
  }, []);

  const onSubmit = useCallback(async () => {
    if (state.kind !== "ready") return;
    setError(null);
    if (!signatureName.trim()) {
      setError("Please type your name to sign.");
      return;
    }
    if (!hasOtherCoverage) {
      setError("Please answer whether you have any other insurance coverage.");
      return;
    }
    setSubmitting(true);
    try {
      let cardPhoto: { name: string; type: string; content: string } | null = null;
      if (cardFile) {
        const content = await fileToDataUrl(cardFile);
        cardPhoto = { name: cardFile.name, type: cardFile.type, content };
      }
      const res = await fetch(`/api/cob-update/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderedPolicyIds: orderedIds,
          hasOtherCoverage: hasOtherCoverage === "yes",
          otherCoverageNote: otherCoverageNote.trim(),
          signatureName: signatureName.trim(),
          cardPhoto,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Submit failed");
      }
      setState({ kind: "done" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }, [
    state,
    signatureName,
    hasOtherCoverage,
    otherCoverageNote,
    orderedIds,
    cardFile,
    token,
  ]);

  if (state.kind === "loading") {
    return <Shell><p>Loading your secure form…</p></Shell>;
  }
  if (state.kind === "error") {
    return (
      <Shell>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Link unavailable</h1>
        <p style={{ color: "#b91c1c" }}>{state.message}</p>
        <p style={{ marginTop: 16, color: "#64748b", fontSize: 14 }}>
          If you believe this is a mistake, please contact your provider and
          ask them to send a fresh link.
        </p>
      </Shell>
    );
  }
  if (state.kind === "done") {
    return (
      <Shell>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Thank you</h1>
        <p>
          Your insurance information was sent securely to your care team. You
          can close this window — no further action is needed.
        </p>
      </Shell>
    );
  }

  const data = state.data;
  const greetingName =
    data.client.preferredName || data.client.firstName || "there";

  return (
    <Shell>
      <h1 style={{ fontSize: 24, margin: "0 0 4px" }}>
        Confirm your insurance
      </h1>
      <p style={{ color: "#475569", margin: "0 0 24px" }}>
        Hi {greetingName}, {data.organization.name} needs you to confirm your
        current insurance so your recent visit can be billed to the correct
        payer. This takes about a minute.
      </p>

      <Section title="1. Which insurance is primary?">
        {data.policies.length === 0 ? (
          <p style={{ color: "#64748b" }}>
            We don't have any insurance on file yet. Please contact your
            provider and we'll add it together.
          </p>
        ) : (
          <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {orderedIds.map((id, idx) => {
              const p = policiesById.get(id);
              if (!p) return null;
              const slot =
                idx === 0
                  ? "Primary"
                  : idx === 1
                    ? "Secondary"
                    : idx === 2
                      ? "Tertiary"
                      : `Other (${idx + 1})`;
              return (
                <li
                  key={id}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    background: "white",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: "#2563eb", fontWeight: 700 }}>
                      {slot}
                    </div>
                    <div style={{ fontWeight: 600 }}>
                      {p.payerName ?? p.planName ?? "Insurance plan"}
                    </div>
                    {p.policyNumber ? (
                      <div style={{ color: "#64748b", fontSize: 13 }}>
                        Member ID: {p.policyNumber}
                      </div>
                    ) : null}
                    {p.effectiveDate ? (
                      <div style={{ color: "#94a3b8", fontSize: 12 }}>
                        Effective {formatDate(p.effectiveDate)}
                        {p.terminationDate
                          ? ` – ${formatDate(p.terminationDate)}`
                          : ""}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => move(id, -1)}
                      disabled={idx === 0}
                      style={btnStyle(idx === 0)}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(id, 1)}
                      disabled={idx === orderedIds.length - 1}
                      style={btnStyle(idx === orderedIds.length - 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          Use the arrows to put your primary insurance at the top.
        </p>
      </Section>

      <Section title="2. Do you have any other insurance?">
        <div style={{ display: "flex", gap: 16 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="radio"
              name="hasOther"
              value="no"
              checked={hasOtherCoverage === "no"}
              onChange={() => setHasOtherCoverage("no")}
            />
            No, the plan(s) above are all I have
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="radio"
              name="hasOther"
              value="yes"
              checked={hasOtherCoverage === "yes"}
              onChange={() => setHasOtherCoverage("yes")}
            />
            Yes, I have other coverage
          </label>
        </div>
        {hasOtherCoverage === "yes" ? (
          <textarea
            value={otherCoverageNote}
            onChange={(e) => setOtherCoverageNote(e.target.value)}
            placeholder="Tell us the plan name, member ID, and whether it's primary or secondary. (Or just upload a card photo below.)"
            rows={4}
            style={{
              marginTop: 8,
              width: "100%",
              padding: 8,
              fontSize: 14,
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontFamily: "inherit",
            }}
          />
        ) : null}
      </Section>

      <Section title="3. (Optional) Upload a photo of your insurance card">
        <input type="file" accept="image/*" onChange={onCardChange} />
        {cardPreview ? (
          <div style={{ marginTop: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={cardPreview}
              alt="Insurance card preview"
              style={{ maxWidth: 320, borderRadius: 6, border: "1px solid #e2e8f0" }}
            />
          </div>
        ) : null}
      </Section>

      <Section title="4. Sign to confirm">
        <label style={{ display: "block", fontSize: 13, color: "#475569", marginBottom: 4 }}>
          Type your full name
        </label>
        <input
          type="text"
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          placeholder="Your full name"
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: 15,
            borderRadius: 6,
            border: "1px solid #cbd5e1",
          }}
        />
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>
          By typing your name, you confirm the information above is accurate
          to the best of your knowledge.
        </p>
      </Section>

      {error ? (
        <div
          style={{
            background: "#fef2f2",
            color: "#b91c1c",
            padding: 10,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={submitting}
        style={{
          background: submitting ? "#93c5fd" : "#2563eb",
          color: "white",
          padding: "12px 18px",
          fontSize: 15,
          fontWeight: 600,
          border: "none",
          borderRadius: 8,
          cursor: submitting ? "wait" : "pointer",
        }}
      >
        {submitting ? "Sending…" : "Send to my care team"}
      </button>
    </Shell>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: disabled ? "#f1f5f9" : "white",
    cursor: disabled ? "default" : "pointer",
    color: disabled ? "#94a3b8" : "#0f172a",
    fontSize: 14,
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>{title}</h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "32px 16px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          maxWidth: 640,
          margin: "0 auto",
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: 24,
        }}
      >
        {children}
      </div>
    </div>
  );
}
