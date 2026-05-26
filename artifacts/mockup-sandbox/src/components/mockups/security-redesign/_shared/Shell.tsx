import type { ReactNode } from "react";
import "../_group.css";

type NavItem = { label: string; href: string; active?: boolean; subs?: { label: string; href: string; active?: boolean }[] };
type NavSection = { section: string; items: NavItem[] };

const NAV: NavSection[] = [
  { section: "HOME", items: [
    { label: "Schedule", href: "#" },
    { label: "Clients", href: "#" },
    { label: "Inbox", href: "#" },
    { label: "Chat", href: "#" },
    { label: "Mailroom", href: "#" },
  ]},
  { section: "ADMIN", items: [
    { label: "Settings", href: "#", active: true, subs: [
      { label: "Providers", href: "#" },
      { label: "Organization", href: "#" },
      { label: "Payers", href: "#" },
      { label: "Security", href: "#", active: true },
      { label: "Settings", href: "#" },
    ]},
  ]},
];

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="ta-app">
      <aside className="ta-sidebar">
        <div className="ta-brand">
          <b>THERASSISTANT</b><span className="pill">EHR</span>
          <span className="org">Sunrise Behavioral Health</span>
        </div>
        {NAV.map((sec) => (
          <div key={sec.section}>
            <div className="ta-section">{sec.section}</div>
            {sec.items.map((it) => (
              <div key={it.label}>
                <a className={`ta-nav-item${it.active ? " active" : ""}`} href={it.href}>{it.label}</a>
                {it.subs?.map((sub) => (
                  <a key={sub.label} className={`ta-nav-item sub${sub.active ? " active" : ""}`} href={sub.href}>{sub.label}</a>
                ))}
              </div>
            ))}
          </div>
        ))}
      </aside>
      <main className="ta-main">{children}</main>
    </div>
  );
}
