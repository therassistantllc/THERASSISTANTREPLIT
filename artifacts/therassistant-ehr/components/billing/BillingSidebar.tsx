"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./BillingSidebar.module.css";
import { workqueuesByStage, type WorkqueueDef } from "@/lib/billing/workqueues";

function isActive(pathname: string, href: string): boolean {
  if (href === "/billing") return pathname === "/billing";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function BillingSidebar() {
  const pathname = usePathname() ?? "";
  const stages = workqueuesByStage();

  return (
    <nav className={styles.sidebar} aria-label="Billing workqueues">
      <div className={styles.inner}>
        {stages.map((stage) => (
          <div key={stage.stage} className={styles.stage}>
            <div className={styles.stageLabel}>{stage.label}</div>
            {stage.items.map((q) => (
              <SidebarItem key={q.id} q={q} active={isActive(pathname, q.href)} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

function SidebarItem({ q, active }: { q: WorkqueueDef; active: boolean }) {
  if (q.status === "coming_soon") {
    return (
      <span
        className={`${styles.item} ${styles.itemSoon}`}
        title={`${q.title} — coming soon`}
        aria-disabled="true"
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {q.title}
        </span>
        <span className={styles.soonBadge}>Soon</span>
      </span>
    );
  }
  return (
    <Link
      href={q.href}
      className={`${styles.item} ${active ? styles.itemActive : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {q.title}
      </span>
    </Link>
  );
}
