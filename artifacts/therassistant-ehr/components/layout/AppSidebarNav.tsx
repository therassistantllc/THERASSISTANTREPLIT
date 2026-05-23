"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "./AppShell.module.css";

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function UserCheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <polyline points="17 11 19 13 23 9" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="19" rx="1" />
      <path d="M8 21V8M16 21V8M2 12h20M2 17h20" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", marginLeft: "auto", flexShrink: 0, opacity: 0.5 }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function active(pathname: string, prefixes: string[], exact = false): boolean {
  if (exact) return prefixes.includes(pathname);
  return prefixes.some((p) => pathname.startsWith(p));
}

export default function AppSidebarNav() {
  const pathname = usePathname();

  const adminActive = active(pathname, ["/settings", "/admin"]);

  const [adminOpen, setAdminOpen] = useState(adminActive || false);

  return (
    <nav className={styles.nav} aria-label="Primary navigation">

      {/* ── HOME ─────────────────────────────────────────────── */}
      <div className={styles.navSection}>Home</div>

      <NavLink href="/calendar" icon={<CalendarIcon />} label="Schedule" prefixes={["/calendar", "/clinician/agenda"]} exact={pathname === "/"} pathname={pathname} />
      <NavLink href="/clients" icon={<UsersIcon />} label="Clients" prefixes={["/clients", "/patients"]} pathname={pathname} />
      <NavLink href="/inbox" icon={<TasksIcon />} label="Inbox" prefixes={["/inbox"]} pathname={pathname} />
      <NavLink href="/chat" icon={<ChatIcon />} label="Chat" prefixes={["/chat"]} pathname={pathname} />
      <NavLink href="/mailroom" icon={<InboxIcon />} label="Mailroom" prefixes={["/mailroom"]} pathname={pathname} />

      {/* ── ADMIN ────────────────────────────────────────────── */}
      <div className={styles.navSectionSpacer} />
      <div className={styles.navSection}>Admin</div>

      <button
        type="button"
        className={`${styles.navItem} ${styles.navItemCollapsible} ${adminActive ? styles.navItemActive : ""}`}
        onClick={() => setAdminOpen((o) => !o)}
        aria-expanded={adminOpen}
      >
        <span className={styles.navIcon}><GearIcon /></span>
        Settings
        <ChevronIcon open={adminOpen} />
      </button>

      {adminOpen ? (
        <div className={styles.subnav}>
          <SubNavLinkIcon href="/settings/providers" icon={<UserCheckIcon />} label="Providers" prefixes={["/settings/providers"]} pathname={pathname} />
          <SubNavLinkIcon href="/settings/organization" icon={<BuildingIcon />} label="Organization" prefixes={["/settings/organization"]} pathname={pathname} />
          <SubNavLinkIcon href="/settings/payers" icon={<ShieldIcon />} label="Payers" prefixes={["/settings/payers"]} pathname={pathname} />
          <SubNavLinkIcon href="/settings/security" icon={<LockIcon />} label="Security" prefixes={["/settings/security"]} pathname={pathname} />
          <SubNavLinkIcon href="/settings/system-readiness" icon={<GearIcon />} label="Settings" prefixes={["/settings/system-readiness", "/settings/service-locations", "/settings/billing-defaults", "/settings/clearinghouse", "/settings/trading-partner", "/settings/payer-enrollments", "/settings/baa", "/settings/mailroom", "/admin"]} pathname={pathname} />
        </div>
      ) : null}

    </nav>
  );
}

function NavLink({
  href, icon, label, prefixes, pathname, exact = false, activeOverride, disabled = false,
}: {
  href: string; icon: React.ReactNode; label: string; prefixes: string[]; pathname: string;
  exact?: boolean; activeOverride?: boolean; disabled?: boolean;
}) {
  const isActive = activeOverride !== undefined
    ? activeOverride
    : exact
    ? pathname === href || prefixes.includes(pathname)
    : prefixes.some((p) => pathname.startsWith(p));

  if (disabled) {
    return (
      <span className={`${styles.navItem} ${styles.navItemDisabled}`}>
        <span className={styles.navIcon}>{icon}</span>
        {label}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className={isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
      aria-current={isActive ? "page" : undefined}
    >
      <span className={styles.navIcon}>{icon}</span>
      {label}
    </Link>
  );
}

function SubNavLinkIcon({
  href, icon, label, prefixes, pathname,
}: {
  href: string; icon: React.ReactNode; label: string; prefixes: string[]; pathname: string;
}) {
  const isActive = prefixes.some((p) => pathname.startsWith(p));
  return (
    <Link
      href={href}
      className={isActive ? `${styles.subnavItem} ${styles.subnavItemActive}` : styles.subnavItem}
      aria-current={isActive ? "page" : undefined}
    >
      <span className={styles.subnavIcon}>{icon}</span>
      {label}
    </Link>
  );
}

