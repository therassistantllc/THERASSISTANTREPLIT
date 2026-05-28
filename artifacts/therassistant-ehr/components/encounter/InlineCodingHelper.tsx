"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type CodingHelperReport = {
  id: string;
  date: string;
  codes: string;
  auditSummary: string;
  formSummary: string;
};

export type InlineCodingHelperHandle = {
  generateReport: () => CodingHelperReport | null;
  isReady: () => boolean;
};

declare global {
  interface Window {
    __theraCodingHelperBootstrapped?: boolean;
    generateAll?: () => void;
    initLibraries?: () => void;
    refreshVisiblePages?: () => void;
    updateProgress?: () => void;
    getLatestCodingReport?: () => unknown;
    initializeCodingHelper?: () => void;
  }
}

const InlineCodingHelper = forwardRef<InlineCodingHelperHandle>(function InlineCodingHelper(_props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHelper() {
      try {
        const response = await fetch("/clinical-coding-tool.html", { cache: "no-store" });
        const html = await response.text();
        if (!response.ok) {
          throw new Error(`Failed to load coding helper (${response.status})`);
        }
        if (cancelled || !hostRef.current) return;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const shell = doc.querySelector(".dashboard-main .shell") ?? doc.querySelector(".shell") ?? doc.body;
        const wrap = doc.querySelector(".wrap");
        const header = wrap?.querySelector(".header");
        header?.remove();
        const styleText = Array.from(doc.querySelectorAll("style"))
          .map((node) => node.textContent || "")
          .join("\n");

        hostRef.current.innerHTML = "";

        const styleNode = document.createElement("style");
        styleNode.setAttribute("data-inline-coding-helper", "styles");
        styleNode.textContent = `${styleText}
          .thera-inline-helper{font-family:var(--font-sans) !important; font-size:var(--text-md) !important; color:var(--text) !important;}
          .thera-inline-helper{--bg:var(--background) !important; --panel:var(--card) !important; --line:var(--line) !important; --line-soft:var(--line) !important; --ink:var(--text) !important; --ink-2:var(--text) !important; --muted:var(--muted) !important; --green:var(--sage) !important; --green-dark:var(--navy) !important; --blue:var(--navy) !important; --cream:var(--sage-soft) !important;}
          .dashboard-main,.dashboard-shell,.dashboard-body{background:transparent !important;}
          .dashboard-sidebar,.sidebar-logo,.sidebar-product,.clinician-badge{display:none !important;}
          .shell{max-width:none !important; padding:0 !important; margin:0 !important;}
          .wrap{padding:0 !important; margin:0 !important; border:0 !important; border-radius:0 !important; background:transparent !important; box-shadow:none !important;}
          .header{display:none !important;}
          .page-card,.results-shell{border:0 !important; border-radius:0 !important; box-shadow:none !important; background:transparent !important;}
          .page-body,.results-shell{padding-left:0 !important; padding-right:0 !important;}
          .thera-inline-helper .btn,.thera-inline-helper button{font-family:var(--font-sans) !important;}
          .thera-inline-helper .section-tag,.thera-inline-helper .eyebrow{font-family:var(--font-heading) !important;}
        `;
        hostRef.current.appendChild(styleNode);

        const contentWrapper = document.createElement("div");
        contentWrapper.setAttribute("data-inline-coding-helper", "content");
        contentWrapper.className = "thera-inline-helper";
        if (wrap) {
          contentWrapper.innerHTML = Array.from(wrap.children)
            .map((node) => (node as HTMLElement).outerHTML)
            .join("");
        } else {
          contentWrapper.innerHTML = shell.outerHTML;
        }
        hostRef.current.appendChild(contentWrapper);

        if (!window.__theraCodingHelperBootstrapped) {
          const scripts = Array.from(doc.querySelectorAll("script"));
          for (const script of scripts) {
            const scriptNode = document.createElement("script");
            const src = script.getAttribute("src");
            if (src) {
              scriptNode.src = src;
              scriptNode.async = false;
            } else {
              scriptNode.textContent = script.textContent || "";
            }
            scriptNode.setAttribute("data-inline-coding-helper", "script");
            hostRef.current.appendChild(scriptNode);
          }

          const accessorNode = document.createElement("script");
          accessorNode.setAttribute("data-inline-coding-helper", "accessor");
          accessorNode.textContent = `window.getLatestCodingReport = function(){ try { return latestCodingReport || null; } catch { return null; } };`;
          hostRef.current.appendChild(accessorNode);

          window.__theraCodingHelperBootstrapped = true;
        }

        // Re-initialize helper state for the freshly mounted DOM.
        window.initializeCodingHelper?.();

        if (!cancelled) {
          setReady(true);
          setLoadError(null);
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Unable to load coding helper");
        setReady(false);
      }
    }

    void loadHelper();

    return () => {
      cancelled = true;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      generateReport: () => {
        try {
          window.generateAll?.();
          const report = window.getLatestCodingReport?.() as
            | {
                id?: string;
                date?: string;
                codes?: string;
                auditSummary?: string;
                formSummary?: string;
              }
            | null
            | undefined;
          if (!report) return null;

          return {
            id: String(report.id ?? `encounter-${Date.now()}`),
            date: String(report.date ?? new Date().toISOString().slice(0, 10)),
            codes: String(report.codes ?? ""),
            auditSummary: String(report.auditSummary ?? ""),
            formSummary: String(report.formSummary ?? ""),
          };
        } catch {
          return null;
        }
      },
      isReady: () => ready,
    }),
    [ready],
  );

  return (
    <div>
      {loadError ? (
        <p className="muted" style={{ marginBottom: 8 }}>
          {loadError}
        </p>
      ) : null}
      {!ready && !loadError ? (
        <p className="muted" style={{ marginBottom: 8 }}>
          Loading coding helper...
        </p>
      ) : null}
      <div ref={hostRef} />
    </div>
  );
});

export default InlineCodingHelper;
