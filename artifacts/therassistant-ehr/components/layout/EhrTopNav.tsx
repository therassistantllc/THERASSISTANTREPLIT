"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./EhrTopNav.module.css";

const navItems = [
  { label: "Calendar", href: "/", match: ["/", "/calendar", "/clinician/agenda"] },
  { label: "Clients", href: "/clients", match: ["/clients", "/patients"] },
  { label: "Chart Room", href: "/chart-room", match: ["/chart-room", "/encounters"] },
  { label: "Mailroom", href: "/mailroom", match: ["/mailroom"] },
  { label: "Billing", href: "/billing", match: ["/billing"] },
  { label: "Settings", href: "/settings", match: ["/settings", "/admin"] },
];

function isActive(pathname: string, item: { href: string; match: string[] }) {
  if (item.href === "/") return pathname === "/";
  return item.match.some((match) => pathname.startsWith(match));
}

export default function EhrTopNav() {
  const pathname = usePathname();

  return (
    <header className={styles.topNav}>
      <div className={styles.inner}>
        <Link className={styles.brand} href="/">
          <span>THERASSISTANT</span>
          <small>EHR</small>
        </Link>

        <nav className={styles.links} aria-label="Primary navigation">
          {navItems.map((item) => {
            const className = isActive(pathname, item) ? `${styles.link} ${styles.active}` : styles.link;
            return (
              <Link key={item.label} className={className} href={item.href}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
