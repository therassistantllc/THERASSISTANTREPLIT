"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./AppShell.module.css";

type NavLink = {
  label: string;
  href: string;
  exact?: boolean;
  match?: string[];
};

type NavItem = NavLink & {
  children?: NavLink[];
};

const NAV_ITEMS: NavItem[] = [
  { label: "Calendar", href: "/", exact: true, match: ["/", "/calendar", "/clinician/agenda"] },
  { label: "Clients", href: "/clients" },
  { label: "Chart Room", href: "/chart-room", match: ["/chart-room", "/encounters"] },
  { label: "Mailroom", href: "/mailroom" },
  {
    label: "Billing",
    href: "/billing",
    match: ["/billing", "/workqueue"],
    children: [
      { label: "Billing Home", href: "/billing" },
      { label: "Charge Capture", href: "/billing/charge-capture", match: ["/billing/charge-capture", "/billing/claim-readiness"] },
      { label: "Claim Submission", href: "/billing/claim-submission", match: ["/billing/claim-submission", "/billing/837p-batches"] },
      { label: "837P Batches", href: "/billing/837p-batches" },
      { label: "Workqueue", href: "/billing/workqueue", match: ["/billing/workqueue", "/workqueue"] },
      { label: "Reports", href: "/billing/reports" },
    ],
  },
  {
    label: "Settings",
    href: "/settings",
    match: ["/settings", "/admin"],
    children: [
      { label: "Organization", href: "/settings/organization" },
      { label: "Providers", href: "/settings/providers" },
      { label: "Payers", href: "/settings/payers" },
      { label: "Service Locations", href: "/settings/service-locations" },
      { label: "Billing Defaults", href: "/settings/billing-defaults" },
      { label: "Clearinghouse", href: "/settings/clearinghouse" },
      { label: "Mailroom", href: "/settings/mailroom" },
      { label: "Security", href: "/settings/security" },
      { label: "System Readiness", href: "/settings/system-readiness" },
      { label: "Provider Credentialing", href: "/admin/provider-credentialing" },
    ],
  },
];

function isActive(pathname: string, item: NavLink) {
  if (item.exact) return pathname === item.href;
  if (item.match && item.match.length > 0) {
    return item.match.some((prefix) => pathname.startsWith(prefix));
  }
  return pathname.startsWith(item.href);
}

export default function AppSidebarNav() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Primary navigation">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item);
        return (
          <div key={item.label} className={styles.navGroup}>
            <Link
              href={item.href}
              className={active ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
            {item.children && item.children.length > 0 ? (
              <div className={styles.subnav} aria-label={`${item.label} submenu`}>
                {item.children.map((child) => {
                  const childActive = isActive(pathname, child);
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={childActive ? `${styles.subnavItem} ${styles.subnavItemActive}` : styles.subnavItem}
                      aria-current={childActive ? "page" : undefined}
                    >
                      {child.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
