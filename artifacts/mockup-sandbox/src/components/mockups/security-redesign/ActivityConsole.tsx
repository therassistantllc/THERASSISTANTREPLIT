import { Shell } from "./_shared/Shell";
import "./_group.css";
import { Activity, AlertTriangle, ChevronRight, Filter, Lock, Play, Search, Shield, ShieldAlert, ShieldCheck, User } from "lucide-react";
import React, { useState } from "react";

const AUDIT_LOGS = [
  { id: 1, time: "11:42:08", actor: "Dr. Sarah Whitfield, LCSW", actorRole: "Clinician", event: "PHI accessed", target: "Pt: Doe, J. (DOB 1980)", severity: "info" },
  { id: 2, time: "11:39:15", actor: "Marcus Chen, biller", actorRole: "Biller", event: "Payment posted", target: "ERA #89291 (Aetna)", severity: "info" },
  { id: 3, time: "11:31:02", actor: "Rivera, J., admin", actorRole: "Admin", event: "Role changed", target: "User: Marcus Chen (added 'Biller')", severity: "warn" },
  { id: 4, time: "11:25:44", actor: "System", actorRole: "System", event: "Failed login", target: "IP: 198.51.100.42 (3 attempts)", severity: "critical" },
  { id: 5, time: "11:15:10", actor: "Dr. Sarah Whitfield, LCSW", actorRole: "Clinician", event: "Note signed", target: "Enc: 2023-10-24 (Doe, J.)", severity: "info" },
  { id: 6, time: "11:05:00", actor: "Marcus Chen, biller", actorRole: "Biller", event: "Submit 837P claims", target: "Batch #1042 (14 claims)", severity: "info" },
  { id: 7, time: "10:52:33", actor: "System", actorRole: "System", event: "ERA imported", target: "File: 835_UHC_20231024.edi", severity: "info" },
  { id: 8, time: "10:40:12", actor: "Rivera, J., admin", actorRole: "Admin", event: "Configure billing defaults", target: "Setting: 'Auto-post ERA'", severity: "warn" },
  { id: 9, time: "10:28:45", actor: "Dr. Sarah Whitfield, LCSW", actorRole: "Clinician", event: "PHI accessed", target: "Pt: Smith, A. (DOB 1992)", severity: "info" },
  { id: 10, time: "10:15:20", actor: "Unknown", actorRole: "External", event: "Failed login", target: "IP: 198.51.100.42", severity: "critical" },
  { id: 11, time: "09:55:11", actor: "Marcus Chen, biller", actorRole: "Biller", event: "Manage payer enrollments", target: "Payer: BCBS TX", severity: "warn" },
  { id: 12, time: "09:30:05", actor: "System", actorRole: "System", event: "Auth policy sync", target: "Supabase RLS definitions", severity: "info" },
];

const ACTIVE_SESSIONS = [
  { id: 1, name: "Dr. Sarah Whitfield", role: "Clinician", lastAction: "2m ago" },
  { id: 2, name: "Marcus Chen", role: "Biller", lastAction: "5m ago" },
  { id: 3, name: "Rivera, J.", role: "Admin", lastAction: "12m ago" },
  { id: 4, name: "Dr. L. Vance", role: "Clinician", lastAction: "18m ago" },
  { id: 5, name: "K. Torres", role: "Front Desk", lastAction: "42m ago" },
];

const PENDING_REVIEWS = [
  { id: 1, title: "Unrecognized IP login", desc: "198.51.100.42 (Kiev, UA)" },
  { id: 2, title: "Role escalation", desc: "Marcus Chen added to 'Biller'" },
];

export function ActivityConsole() {
  const [live, setLive] = useState(true);

  return (
    <Shell>
      <div style={{ display: "flex", gap: 24, height: "calc(100vh - 40px)", alignItems: "stretch" }}>
        
        {/* Main Timeline Column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div>
              <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Security Console <span style={{ fontSize: 12, fontWeight: 500, padding: "2px 8px", background: live ? "rgba(30, 158, 64, 0.1)" : "rgba(92, 110, 130, 0.1)", color: live ? "var(--success)" : "var(--muted)", borderRadius: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {live && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />}
                  {live ? "Live" : "Paused"}
                </span>
              </h1>
              <p className="muted" style={{ margin: 0, marginTop: 4, fontSize: 13 }}>Real-time audit log and security monitoring.</p>
            </div>
            
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, padding: "4px 8px", fontSize: 12 }}>
                <Search size={14} style={{ color: "var(--muted)", marginRight: 6 }} />
                <input type="text" placeholder="Search actor or target..." style={{ border: "none", outline: "none", background: "transparent", width: 140 }} />
              </div>
              <button className="button button-secondary" style={{ padding: "4px 8px" }} onClick={() => setLive(!live)}>
                {live ? "Pause stream" : "Resume stream"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden" }}>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "rgba(94, 138, 106, 0.1)", color: "var(--sage)", border: "none", borderRight: "1px solid var(--line)", fontWeight: 500 }}>Last 1h</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)" }}>Today</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", color: "var(--text)" }}>7d</button>
            </div>

            <div style={{ display: "flex", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden" }}>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)", display: "flex", alignItems: "center", gap: 4 }}><Filter size={12} /> All Events</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)" }}>PHI access</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)" }}>Auth</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)" }}>Billing</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", color: "var(--text)" }}>Config</button>
            </div>

            <div style={{ display: "flex", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden" }}>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)" }}>All Severities</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", borderRight: "1px solid var(--line)", color: "var(--text)", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)" }} /> Warn+</button>
              <button style={{ padding: "4px 10px", fontSize: 12, background: "transparent", border: "none", color: "var(--text)", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--danger)" }} /> Critical</button>
            </div>
          </div>

          <div style={{ background: "rgba(176, 32, 32, 0.05)", border: "1px solid rgba(176, 32, 32, 0.2)", borderRadius: 4, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 16 }}>
            <ShieldAlert size={16} style={{ color: "var(--danger)" }} />
            <span><strong>142 events today</strong> &bull; 3 critical &bull; 1 failed login surge from 198.51.100.x &mdash; <a href="#" style={{ color: "var(--danger)", textDecoration: "underline" }}>investigate</a></span>
          </div>

          <div className="panel" style={{ flex: 1, margin: 0, overflow: "auto", padding: 0, display: "flex", flexDirection: "column" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--card)", zIndex: 10, boxShadow: "0 1px 0 var(--line)" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 600, color: "var(--muted)", width: 80 }}>Time</th>
                  <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 600, color: "var(--muted)" }}>Actor</th>
                  <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 600, color: "var(--muted)" }}>Event</th>
                  <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 600, color: "var(--muted)" }}>Target</th>
                </tr>
              </thead>
              <tbody>
                {AUDIT_LOGS.map((log) => (
                  <tr key={log.id} style={{ 
                    borderBottom: "1px solid var(--line)", 
                    background: log.severity === 'critical' ? "rgba(176, 32, 32, 0.03)" : "transparent",
                    borderLeft: log.severity === 'critical' ? "3px solid var(--danger)" : "3px solid transparent"
                  }}>
                    <td style={{ padding: "10px 16px", color: "var(--muted)", whiteSpace: "nowrap" }}>
                      {log.time}
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 24, height: 24, borderRadius: "50%", background: log.actor === "System" ? "var(--line)" : "var(--sage-mid)", display: "flex", alignItems: "center", justifyContent: "center", color: log.actor === "System" ? "var(--muted)" : "var(--navy)", fontSize: 10, fontWeight: 600 }}>
                          {log.actor.substring(0, 1)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 500 }}>{log.actor}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)" }}>{log.actorRole}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {log.severity === 'critical' && <ShieldAlert size={14} style={{ color: "var(--danger)" }} />}
                        {log.severity === 'warn' && <AlertTriangle size={14} style={{ color: "var(--warning)" }} />}
                        {log.severity === 'info' && <Activity size={14} style={{ color: "var(--muted)" }} />}
                        <span style={{ 
                          fontWeight: log.severity !== 'info' ? 600 : 400,
                          color: log.severity === 'critical' ? 'var(--danger)' : log.severity === 'warn' ? 'var(--warning)' : 'inherit'
                        }}>{log.event}</span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 16px", color: "var(--muted)" }}>
                      <code>{log.target}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>

        {/* Right Rail */}
        <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          
          <div className="panel" style={{ margin: 0 }}>
            <h2 style={{ fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              Active Sessions
              <span style={{ background: "rgba(30, 158, 64, 0.1)", color: "var(--success)", padding: "2px 6px", borderRadius: 10, fontSize: 11 }}>{ACTIVE_SESSIONS.length} online</span>
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {ACTIVE_SESSIONS.map(session => (
                <div key={session.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ position: "relative" }}>
                      <div style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--sage-mid)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--navy)", fontSize: 9, fontWeight: 600 }}>
                        {session.name.substring(0, 1)}
                      </div>
                      <div style={{ position: "absolute", bottom: -2, right: -2, width: 8, height: 8, borderRadius: "50%", background: "var(--success)", border: "2px solid var(--card)" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{session.name}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{session.role}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{session.lastAction}</div>
                </div>
              ))}
            </div>
            <button className="button button-secondary" style={{ width: "100%", marginTop: 16, fontSize: 12 }}>Manage Sessions</button>
          </div>

          <div className="panel" style={{ margin: 0 }}>
            <h2 style={{ fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              Pending Reviews
              <span style={{ background: "rgba(176, 32, 32, 0.1)", color: "var(--danger)", padding: "2px 6px", borderRadius: 10, fontSize: 11 }}>{PENDING_REVIEWS.length} items</span>
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {PENDING_REVIEWS.map(review => (
                <div key={review.id} style={{ border: "1px solid var(--line)", padding: "8px 12px", borderRadius: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--danger)", marginBottom: 4 }}>{review.title}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>{review.desc}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={{ flex: 1, padding: "4px", fontSize: 11, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 3, cursor: "pointer" }}>Dismiss</button>
                    <button style={{ flex: 1, padding: "4px", fontSize: 11, background: "var(--navy)", color: "white", border: "1px solid var(--navy)", borderRadius: 3, cursor: "pointer" }}>Review</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: "auto" }}>
            <a href="#" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, fontSize: 13, color: "var(--muted)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Shield size={14} />
                <span>RBAC &amp; Policies</span>
              </div>
              <ChevronRight size={14} />
            </a>
          </div>

        </div>

      </div>
    </Shell>
  );
}
