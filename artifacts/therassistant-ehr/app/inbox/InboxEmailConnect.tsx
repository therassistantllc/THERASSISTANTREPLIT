"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Lock,
  Mail,
  ShieldCheck,
  X,
} from "lucide-react";

// Note: MicrosoftGlyph and the "other" provider option are intentionally
// retained in the file so existing parent components (e.g. InboxClient) that
// still reference the ProviderKey union compile. Only Gmail is offered in
// the onboarding UI.
import styles from "./inbox.module.css";

type ProviderKey = "google" | "microsoft" | "other";

export type ConnectedAccount = {
  provider: ProviderKey;
  email: string;
  connectedAt: string;
};

type ModalStep = "consent" | "connecting" | "success";

const PROVIDER_META: Record<
  ProviderKey,
  { label: string; suffix: string; verb: string; icon: React.ReactNode }
> = {
  google: {
    label: "Google",
    suffix: "@practice.gmail.com",
    verb: "Continue with Google",
    icon: <GoogleGlyph />,
  },
  microsoft: {
    label: "Microsoft",
    suffix: "@practice.onmicrosoft.com",
    verb: "Continue with Microsoft",
    icon: <MicrosoftGlyph />,
  },
  other: {
    label: "IMAP / SMTP",
    suffix: "@practice.example.com",
    verb: "Connect other email",
    icon: <Mail size={18} color="#0F172A" />,
  },
};

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.93v2.32A9 9 0 0 0 9 18Z" fill="#34A853" />
      <path d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.96H.93A9 9 0 0 0 0 9c0 1.45.35 2.83.93 4.04l3.04-2.32Z" fill="#FBBC05" />
      <path d="M9 3.58c1.32 0 2.5.45 3.44 1.34l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.93 4.96l3.04 2.32C4.68 5.16 6.66 3.58 9 3.58Z" fill="#EA4335" />
    </svg>
  );
}

function MicrosoftGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022" />
      <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}

function maskedEmail(provider: ProviderKey): string {
  if (provider === "google") return "drsmith@sunrise-behavioral.com";
  if (provider === "microsoft") return "drsmith@sunrisebehavioral.onmicrosoft.com";
  return "intake@sunrise-behavioral.com";
}

/* ─────────────────────────────────────────────────────────────────────────── */

export function InboxEmptyOnboarding({
  onProviderPick,
}: {
  onProviderPick: (provider: ProviderKey) => void;
}) {
  const [showLearn, setShowLearn] = useState(false);

  return (
    <div className={styles.onboardWrap}>
      <div className={styles.onboardCard}>
        <div className={styles.onboardIconWrap}>
          <Mail size={26} />
        </div>

        <div>
          <h2 className={styles.onboardTitle}>Connect your Gmail</h2>
          <p className={styles.onboardCopy}>
            Sync your personal Gmail to manage clinical communications,
            documentation requests, signatures, and client-related messages
            in one place. Each clinician connects their own mailbox — messages
            are visible only to you.
          </p>
        </div>

        <div className={styles.providerStack}>
          <button
            type="button"
            className={styles.providerBtn}
            onClick={() => onProviderPick("google")}
          >
            <span className={styles.providerIcon}><GoogleGlyph /></span>
            Continue with Google
            <ChevronRight size={16} className={styles.providerArrow} />
          </button>
        </div>

        <div className={styles.securityRow}>
          <div className={styles.securityLine}>
            <ShieldCheck size={14} className={styles.securityIcon} />
            HIPAA-compliant secure connection
          </div>
          <div className={styles.securityLine}>
            <Lock size={14} className={styles.securityIcon} />
            Your email is encrypted and never shared without permission
          </div>
        </div>

        <button
          type="button"
          className={styles.learnMore}
          onClick={() => setShowLearn((v) => !v)}
          aria-expanded={showLearn}
        >
          {showLearn ? "Hide details" : "Learn more about inbox routing"}{" "}
          <ChevronRight
            size={14}
            style={{ transform: showLearn ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
          />
        </button>

        {showLearn ? (
          <p className={styles.learnPanel}>
            Once connected, TherAssistant scans incoming email and routes
            client-related messages into your clinical inbox.{" "}
            <strong>Documentation requests, signature follow-ups, and chart
            questions</strong> appear here. Marketing, billing statements, and
            unrelated mail stay in your normal mailbox. You can disconnect or
            adjust routing rules at any time in Settings.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */

export function InboxConnectModal({
  provider,
  onClose,
  onConnected,
}: {
  provider: ProviderKey;
  onClose: () => void;
  onConnected: (account: ConnectedAccount) => void;
}) {
  const meta = PROVIDER_META[provider];
  const [step, setStep] = useState<ModalStep>("consent");
  const [customEmail, setCustomEmail] = useState("");
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape, lock background scroll, focus the close button,
  // and trap Tab focus inside the dialog so it can't reach background UI.
  useEffect(() => {
    function focusableEls(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("aria-hidden"));
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusableEls();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  function authorize() {
    setStep("connecting");
    // Real OAuth flow. The Next.js API route gates on the current signed-in
    // staff member and signs an HMAC state with their user_id, so the
    // returning connection is attributed to this clinician only.
    window.location.href = "/api/integrations/gmail/start";
  }

  function finish() {
    const email =
      provider === "other" && customEmail.trim().length > 0
        ? customEmail.trim()
        : maskedEmail(provider);
    onConnected({
      provider,
      email,
      connectedAt: new Date().toISOString(),
    });
  }

  function onBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className={styles.modalBackdrop}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={styles.modalCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-connect-title"
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle} id="inbox-connect-title">
            <span className={styles.providerIcon}>{meta.icon}</span>
            {step === "success" ? "Connected" : meta.verb}
          </h3>
          <button
            ref={closeRef}
            type="button"
            className={styles.modalClose}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className={styles.modalBody}>
          {step === "consent" ? (
            <>
              <div className={styles.stepProvider}>
                <span className={styles.stepProviderIcon}>{meta.icon}</span>
                <div className={styles.stepProviderText}>
                  <span className={styles.stepProviderName}>
                    Sign in to {meta.label}
                  </span>
                  <span className={styles.stepProviderEmail}>
                    {provider === "other"
                      ? "Use your practice email and IMAP/SMTP credentials"
                      : "You'll be redirected to your provider to authorize access"}
                  </span>
                </div>
              </div>

              {provider === "other" ? (
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="practice-email">
                    Practice email
                  </label>
                  <input
                    id="practice-email"
                    className={styles.fieldInput}
                    type="email"
                    placeholder="intake@yourpractice.com"
                    value={customEmail}
                    onChange={(e) => setCustomEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>
              ) : null}

              <div>
                <p className={styles.fieldLabel} style={{ marginBottom: 8 }}>
                  TherAssistant will be able to
                </p>
                <ul className={styles.scopeList}>
                  <li className={styles.scopeItem}>
                    <Check size={14} className={styles.scopeCheck} />
                    <span>
                      <strong>Read incoming messages</strong>{" "}
                      <span className={styles.scopeMuted}>
                        to identify and route client-related email.
                      </span>
                    </span>
                  </li>
                  <li className={styles.scopeItem}>
                    <Check size={14} className={styles.scopeCheck} />
                    <span>
                      <strong>Send replies on your behalf</strong>{" "}
                      <span className={styles.scopeMuted}>
                        only when you compose or approve them.
                      </span>
                    </span>
                  </li>
                  <li className={styles.scopeItem}>
                    <Check size={14} className={styles.scopeCheck} />
                    <span>
                      <strong>Attach files to charts</strong>{" "}
                      <span className={styles.scopeMuted}>
                        such as signed forms, lab results, and referrals.
                      </span>
                    </span>
                  </li>
                </ul>
              </div>

              <p className={styles.consentNote}>
                Your messages stay encrypted in transit and at rest. You can
                disconnect at any time in Settings.
              </p>
            </>
          ) : null}

          {step === "connecting" ? (
            <div className={styles.centerStack}>
              <div className={styles.spinner} aria-hidden />
              <h4 className={styles.stepHeadline}>
                Connecting to {meta.label}…
              </h4>
              <p className={styles.stepSub}>
                Authorizing access and verifying your account. This usually
                takes just a moment.
              </p>
            </div>
          ) : null}

          {step === "success" ? (
            <div className={styles.centerStack}>
              <div className={styles.successIconWrap} aria-hidden>
                <Check size={28} />
              </div>
              <h4 className={styles.stepHeadline}>
                {meta.label} email connected
              </h4>
              <p className={styles.stepSub}>
                Your clinical inbox is now syncing with{" "}
                <strong>
                  {provider === "other" && customEmail.trim()
                    ? customEmail.trim()
                    : maskedEmail(provider)}
                </strong>
                .
              </p>
              <div className={styles.syncStatusBox}>
                <span className={styles.syncDot} aria-hidden />
                Initial sync running — client-related messages will appear
                shortly.
              </div>
            </div>
          ) : null}
        </div>

        <footer className={styles.modalFooter}>
          {step === "consent" ? (
            <>
              <button type="button" className={styles.modalBtn} onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.modalBtn} ${styles.modalBtnPrimary}`}
                onClick={authorize}
                disabled={provider === "other" && customEmail.trim().length === 0}
              >
                Authorize & connect <ArrowRight size={14} />
              </button>
            </>
          ) : null}
          {step === "connecting" ? (
            <button type="button" className={styles.modalBtn} onClick={onClose} disabled>
              Connecting…
            </button>
          ) : null}
          {step === "success" ? (
            <button
              type="button"
              className={`${styles.modalBtn} ${styles.modalBtnPrimary}`}
              onClick={finish}
            >
              Open inbox <ArrowRight size={14} />
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */

export function InboxSyncChip({ account }: { account: ConnectedAccount }) {
  return (
    <span
      className={styles.syncChip}
      title={`Synced with ${account.email}`}
    >
      <span className={styles.syncDot} aria-hidden />
      Syncing {account.email}
    </span>
  );
}
