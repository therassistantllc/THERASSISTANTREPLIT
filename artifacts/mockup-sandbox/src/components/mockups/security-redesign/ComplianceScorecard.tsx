import { Shell } from "./_shared/Shell";
import "./_group.css";
import { Shield, AlertTriangle, CheckCircle2, ArrowRight, RotateCw, ChevronRight, Activity, Users, Lock, FileText, Database, HardDrive, Key, Clock, MoreHorizontal } from "lucide-react";

export function ComplianceScorecard() {
  return (
    <Shell>
      <section className="hero-panel" style={{ alignItems: "center", padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ position: "relative", width: 80, height: 80 }}>
            {/* Fake SVG Gauge */}
            <svg viewBox="0 0 36 36" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }}>
              <path
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="var(--line)"
                strokeWidth="4"
              />
              <path
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
                fill="none"
                stroke="var(--sage)"
                strokeWidth="4"
                strokeDasharray="87, 100"
              />
            </svg>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: "var(--navy)", lineHeight: 1 }}>87</span>
            </div>
          </div>
          <div>
            <p className="eyebrow" style={{ color: "var(--sage)", marginBottom: 4 }}>HIPAA Posture</p>
            <h1 style={{ fontSize: 24, marginBottom: 4 }}>87 / 100 — Good</h1>
            <p className="muted" style={{ fontSize: 13, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <Clock size={14} /> Last scanned today at 09:14 AM
            </p>
          </div>
        </div>
        <div className="hero-actions">
          <button className="button button-secondary" style={{ gap: 6 }}>
            <FileText size={14} />
            Generate Report
          </button>
          <button className="button" style={{ gap: 6 }}>
            <RotateCw size={14} />
            Run Posture Scan
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          
          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Shield size={16} /> MFA Coverage
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fff4e5", color: "var(--warning)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <AlertTriangle size={12} /> ⚠ 4 unenrolled
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>19 of 23 staff</div>
              <div className="muted" style={{ fontSize: 12 }}>All admin and billing roles must have MFA.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View staff list <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Lock size={16} /> Session Policy
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> Configured
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>24h idle timeout</div>
              <div className="muted" style={{ fontSize: 12 }}>Automatically terminates inactive sessions.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View settings <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Database size={16} /> Row-Level Security
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> Covered
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>142 of 142 tables</div>
              <div className="muted" style={{ fontSize: 12 }}>All sensitive records are isolated by tenant ID.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View RLS policies <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Activity size={16} /> Audit Log Completeness
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> Last 30 days
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>100% Events Logged</div>
              <div className="muted" style={{ fontSize: 12 }}>PHI access, auth events, and structural changes.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View audit stream <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Users size={16} /> Stale Accounts
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fce8e8", color: "var(--danger)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <AlertTriangle size={12} /> Action needed
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>3 inactive &gt;90d</div>
              <div className="muted" style={{ fontSize: 12 }}>Accounts with no activity should be disabled.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              Review accounts <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <FileText size={16} /> BAA Status
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> Signed
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>2 of 2 vendors</div>
              <div className="muted" style={{ fontSize: 12 }}>Business Associate Agreements are on file.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View documents <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <Key size={16} /> Encryption at Rest
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> Verified
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>AES-256 Active</div>
              <div className="muted" style={{ fontSize: 12 }}>All primary databases and blob storage.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View details <ArrowRight size={14} />
            </div>
          </article>

          <article className="panel" style={{ margin: 0, padding: "16px", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy)", fontWeight: 600, fontSize: 14 }}>
                  <HardDrive size={16} /> Backup Recency
                </div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--sage-soft)", color: "var(--success)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                  <CheckCircle2 size={12} /> 4h ago
                </span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>PITR Enabled</div>
              <div className="muted" style={{ fontSize: 12 }}>Point-in-time recovery to last 7 days.</div>
            </div>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--sage)", fontWeight: 500 }}>
              View backup history <ArrowRight size={14} />
            </div>
          </article>

        </div>
      </section>

      <section className="panel">
        <h2 style={{ fontSize: 16, display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <AlertTriangle size={18} color="var(--warning)" /> Open Recommendations
        </h2>
        
        <div style={{ display: "flex", flexDirection: "column" }}>
          
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>Require MFA for billing role</div>
              <div className="muted" style={{ fontSize: 13 }}>Users in the "Biller" role have access to PHI and financial data. Enable MFA requirement.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ background: "#fce8e8", color: "var(--danger)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>High Impact</span>
              <button className="button button-secondary" style={{ padding: "4px 12px", height: 28, fontSize: 12 }}>Resolve</button>
              <button style={{ background: "none", border: "none", color: "var(--muted)", padding: 4 }}><MoreHorizontal size={16} /></button>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>Deactivate 3 stale accounts</div>
              <div className="muted" style={{ fontSize: 13 }}>Marcus Chen, biller; Rivera, J., admin; Dr. Sarah Whitfield, LCSW have not logged in for 90 days.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ background: "#fff4e5", color: "var(--warning)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>Medium</span>
              <button className="button button-secondary" style={{ padding: "4px 12px", height: 28, fontSize: 12 }}>Resolve</button>
              <button style={{ background: "none", border: "none", color: "var(--muted)", padding: 4 }}><MoreHorizontal size={16} /></button>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>Review elevated permissions</div>
              <div className="muted" style={{ fontSize: 13 }}>2 users have full system administrative access. Consider least-privilege principles.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ background: "var(--sage-soft)", color: "var(--sage)", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 }}>Low</span>
              <button className="button button-secondary" style={{ padding: "4px 12px", height: 28, fontSize: 12 }}>Review</button>
              <button style={{ background: "none", border: "none", color: "var(--muted)", padding: 4 }}><MoreHorizontal size={16} /></button>
            </div>
          </div>

        </div>
      </section>

      <section style={{ display: "flex", gap: 16, marginTop: 40, borderTop: "1px solid var(--line)", paddingTop: 24 }}>
        <div style={{ flex: 1 }}>
          <p className="eyebrow" style={{ color: "var(--muted)", marginBottom: 12 }}>IT Administration</p>
          <div style={{ display: "flex", gap: 12 }}>
            <a href="#" className="button button-secondary" style={{ fontSize: 12, color: "var(--muted)", padding: "6px 12px" }}>Manage staff</a>
            <a href="#" className="button button-secondary" style={{ fontSize: 12, color: "var(--muted)", padding: "6px 12px" }}>Edit roles</a>
            <a href="#" className="button button-secondary" style={{ fontSize: 12, color: "var(--muted)", padding: "6px 12px" }}>View audit logs</a>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", color: "var(--muted)", fontSize: 12 }}>
          Supabase Auth &amp; MFA configuration <ChevronRight size={14} style={{ marginLeft: 4 }} />
        </div>
      </section>

    </Shell>
  );
}
