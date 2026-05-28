import "./_group.css";
import { useState, useMemo } from "react";

/* ── Data ── */
type PS = "ready" | "partial" | "exception" | "review" | "posted";
type Method = "ERA" | "Client" | "Check" | "Card" | "ACH";
interface Pmt { id:string; source:string; eraId?:string; payer?:string; client?:string; amount:number; method:Method; status:PS; date:string; exception?:string; }

const PAYMENTS: Pmt[] = [
  { id:"p1", source:"ERA #ERA-2026-0234", eraId:"ERA-2026-0234", payer:"BCBS Colorado",            amount:1248.22, method:"ERA",     status:"partial",   date:"05/19/2026", exception:"Payment amount exceeds remaining balance by $42.18" },
  { id:"p2", source:"ERA #ERA-2026-0235", eraId:"ERA-2026-0235", payer:"Aetna",                    amount:892.50,  method:"ERA",     status:"ready",     date:"05/19/2026" },
  { id:"p3", source:"Client – Dana Patel",                       client:"Dana Patel",             amount:40.00,   method:"Card",    status:"posted",    date:"05/19/2026" },
  { id:"p4", source:"Client – James Rivera",                     client:"James Rivera",           amount:0.00,    method:"Client", status:"review",    date:"05/18/2026", exception:"Copay collected: $0 — verify Medicare advantage plan" },
  { id:"p5", source:"ERA #ERA-2026-0231", eraId:"ERA-2026-0231", payer:"Colorado Medicaid",        amount:2104.80, method:"ERA",     status:"posted",    date:"05/16/2026" },
  { id:"p6", source:"Check #44821",                                                                 amount:618.00,  method:"Check",   status:"ready",     date:"05/15/2026" },
  { id:"p7", source:"ERA #ERA-2026-0229", eraId:"ERA-2026-0229", payer:"United Behavioral Health",  amount:330.00, method:"ERA",     status:"exception", date:"05/14/2026", exception:"Unmatched claim — no matching claim found in system" },
  { id:"p8", source:"Client – Sofia Martinez",                   client:"Sofia Martinez",         amount:0.00,    method:"ACH",     status:"review",    date:"05/13/2026", exception:"ACH returned — insufficient funds" },
];

const LEDGER = [
  { dos:"05/02", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/25", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/11", cpt:"90834", charge:120, paid:0,     adj:0,     ptResp:120 },
  { dos:"03/28", cpt:"90837", charge:150, paid:98.22, adj:31.78, ptResp:20  },
  { dos:"03/14", cpt:"90791", charge:195, paid:130.5, adj:44.5,  ptResp:20  },
];

const TIMELINE = [
  { label:"Claim Submitted",           date:"04/25/2026", color:"#1D4ED8", icon:"📤" },
  { label:"ERA Received from BCBS",    date:"05/12/2026", color:"#059669", icon:"📥" },
  { label:"Payment Partially Applied", date:"05/19/2026", color:"#B45309", icon:"⚠" },
  { label:"Client Balance – $20",     date:"05/19/2026", color:"#1D4ED8", icon:"💰" },
  { label:"Statement Pending",         date:"—",          color:"#64748B", icon:"⏳" },
];

/* WCAG AA+ status meta: all 4.5:1+ contrast, icon + text label */
const STATUS_META: Record<PS, { label:string; icon:string; bg:string; color:string; border:string }> = {
  ready:     { label:"Ready to Post",    icon:"✓", bg:"#F0FDF4", color:"#065F46", border:"#BBF7D0" },
  partial:   { label:"Partially Applied",icon:"◑", bg:"#FFFBEB", color:"#78350F", border:"#FDE68A" },
  exception: { label:"Exception",        icon:"✕", bg:"#FFF1F2", color:"#881337", border:"#FECDD3" },
  review:    { label:"Needs Review",     icon:"?", bg:"#EFF6FF", color:"#1E3A8A", border:"#BFDBFE" },
  posted:    { label:"Posted",           icon:"✓", bg:"#F8FAFC", color:"#334155", border:"#E2E8F0" },
};

function methodLabel(m: Method) {
  if (m==="ERA")    return { bg:"#F5F3FF", color:"#4C1D95", border:"#DDD6FE", text:"ERA" };
  if (m==="Check")  return { bg:"#EFF6FF", color:"#1E3A8A", border:"#BFDBFE", text:"Check" };
  if (m==="Card")   return { bg:"#F0FDF4", color:"#14532D", border:"#BBF7D0", text:"Card" };
  if (m==="ACH")    return { bg:"#FFF7ED", color:"#7C2D12", border:"#FED7AA", text:"ACH"  };
  return { bg:"#F1F5F9", color:"#334155", border:"#E2E8F0", text:m };
}

const $ = (v:number) => v.toLocaleString(undefined,{style:"currency",currency:"USD"});
type QueueTab = "all"|"era"|"client"|"checks"|"unapplied"|"exceptions";

export function V3Accessibility() {
  const [sel, setSel] = useState("p1");
  const [tab, setTab] = useState<QueueTab>("all");
  const selected = PAYMENTS.find(p => p.id === sel)!;
  const sm = STATUS_META[selected.status];

  const filtered = useMemo(() => {
    if (tab==="era")        return PAYMENTS.filter(p => p.method==="ERA");
    if (tab==="client")    return PAYMENTS.filter(p => ["Client","Card","ACH"].includes(p.method));
    if (tab==="checks")     return PAYMENTS.filter(p => p.method==="Check");
    if (tab==="unapplied")  return PAYMENTS.filter(p => p.status==="ready"||p.status==="partial");
    if (tab==="exceptions") return PAYMENTS.filter(p => p.status==="exception"||p.status==="review");
    return PAYMENTS;
  }, [tab]);

  const kpi = {
    posted:    $(PAYMENTS.filter(p => p.status==="posted").reduce((s,p) => s+p.amount, 0)),
    pendingEra: PAYMENTS.filter(p => p.method==="ERA" && p.status!=="posted").length,
    unapplied: $(PAYMENTS.filter(p => p.status==="ready"||p.status==="partial").reduce((s,p) => s+p.amount, 0)),
    client:   $(PAYMENTS.filter(p => ["Client","Card","ACH"].includes(p.method)).reduce((s,p)=>s+p.amount,0)),
    refunds:   3,
    exceptions: PAYMENTS.filter(p => p.status==="exception"||p.status==="review").length,
  };

  const TABS = [
    { id:"all" as QueueTab,        label:"All"        },
    { id:"era" as QueueTab,        label:"ERA"        },
    { id:"client" as QueueTab,    label:"Client"    },
    { id:"checks" as QueueTab,     label:"Checks"     },
    { id:"unapplied" as QueueTab,  label:"Unapplied"  },
    { id:"exceptions" as QueueTab, label:"Exceptions" },
  ];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden", background:"#F1F5F9", fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize:14 }}>

      {/* Header — sufficient contrast, min 14px text */}
      <header role="banner" style={{ background:"#1E293B", padding:"0 24px", display:"flex", alignItems:"center", height:56, flexShrink:0, gap:12 }}>
        <h1 style={{ fontSize:18, fontWeight:700, color:"#F8FAFC", margin:0, letterSpacing:"-0.01em" }}>Payments &amp; ERA</h1>
        <div style={{ flex:1 }} />
        {/* Search with visible label */}
        <div style={{ position:"relative" }}>
          <label htmlFor="v3-search" style={{ position:"absolute", width:1, height:1, overflow:"hidden", clip:"rect(0,0,0,0)" }}>Search payments</label>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94A3B8", pointerEvents:"none" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input id="v3-search" style={{ height:36, padding:"0 12px 0 36px", border:"2px solid #475569", borderRadius:8, fontSize:14, color:"#F8FAFC", background:"#334155", outline:"none", width:230 }} placeholder="Search ERA #, client, payer…" />
        </div>
        <input type="date" style={{ height:36, padding:"0 12px", border:"2px solid #475569", borderRadius:8, fontSize:13, color:"#F8FAFC", background:"#334155", outline:"none" }} defaultValue="2026-05-19" />
        <button style={{ height:36, padding:"0 16px", border:"2px solid #94A3B8", borderRadius:8, fontSize:14, fontWeight:500, color:"#F8FAFC", background:"transparent", cursor:"pointer" }}>Export</button>
        <button style={{ height:36, padding:"0 16px", border:"2px solid #94A3B8", borderRadius:8, fontSize:14, fontWeight:500, color:"#F8FAFC", background:"transparent", cursor:"pointer" }}>Import ERA</button>
        <button style={{ height:40, padding:"0 20px", border:"none", borderRadius:8, fontSize:14, fontWeight:700, color:"#fff", background:"#2563EB", cursor:"pointer" }}>+ Post Payment</button>
      </header>

      {/* KPI Row — larger text, no color-only differentiation */}
      <div role="region" aria-label="Summary statistics" style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:2, background:"#CBD5E1", borderBottom:"2px solid #CBD5E1", flexShrink:0 }}>
        {[
          { label:"Posted Today",    value:kpi.posted,            sub:"↑ 12% vs last week", color:"#065F46" },
          { label:"Pending ERAs",    value:String(kpi.pendingEra), sub:"In ERA queue",       color:"#1D4ED8" },
          { label:"Unapplied Cash",  value:kpi.unapplied,         sub:"Awaiting posting",   color:"#92400E" },
          { label:"Client Payments",value:kpi.client,           sub:"All methods",         color:"#0F172A" },
          { label:"Refund Requests", value:"3",                   sub:"Pending",             color:"#0F172A" },
          { label:"Exceptions",      value:String(kpi.exceptions), sub:"Needs resolution",  color:"#881337" },
        ].map(k => (
          <div key={k.label} style={{ background:"#fff", padding:"14px 18px" }}>
            {/* Label above number — no color-only distinction */}
            <div style={{ fontSize:11.5, fontWeight:600, letterSpacing:"0.05em", textTransform:"uppercase", color:"#475569", marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:24, fontWeight:800, color:k.color, lineHeight:1, marginBottom:4 }}>{k.value}</div>
            <div style={{ fontSize:12, color:"#64748B" }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ display:"flex", flex:1, minHeight:0 }}>
        {/* Queue panel */}
        <nav aria-label="Payment queue" style={{ width:400, flexShrink:0, borderRight:"2px solid #E2E8F0", display:"flex", flexDirection:"column", background:"#fff", overflow:"hidden" }}>
          {/* Tabs — larger hit targets */}
          <div role="tablist" style={{ display:"flex", borderBottom:"2px solid #E2E8F0", flexShrink:0, overflowX:"auto" }}>
            {TABS.map(t => {
              const active = tab===t.id;
              return (
                <button key={t.id} role="tab" aria-selected={active} onClick={() => setTab(t.id)} style={{ padding:"12px 14px", fontSize:13, fontWeight: active ? 700:500, color: active ? "#1D4ED8":"#475569", border:"none", borderBottom: active ? "3px solid #2563EB":"3px solid transparent", background: active ? "#EFF6FF":"transparent", marginBottom:-2, whiteSpace:"nowrap", cursor:"pointer" }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* List — larger text, visible focus ring, icon+text status */}
          <div role="listbox" style={{ flex:1, overflowY:"auto" }}>
            {filtered.map(p => {
              const isSelected = sel===p.id;
              const statusMeta = STATUS_META[p.status];
              const mLabel = methodLabel(p.method);
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => setSel(p.id)}
                  onKeyDown={e => { if (e.key==="Enter"||e.key===" ") setSel(p.id); }}
                  style={{ padding:"14px 16px", borderBottom:"1px solid #E2E8F0", background: isSelected ? "#EFF6FF":"#fff", borderLeft: isSelected ? "4px solid #2563EB":"4px solid transparent", cursor:"pointer", outline:"none" }}
                >
                  {/* Method type tag + date — non-color differentiation */}
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={{ padding:"2px 8px", borderRadius:6, fontSize:11.5, fontWeight:700, background:mLabel.bg, color:mLabel.color, border:`1px solid ${mLabel.border}` }}>{mLabel.text}</span>
                    <span style={{ fontSize:12, color:"#64748B" }}>{p.date}</span>
                  </div>
                  {/* Source — minimum 13px */}
                  <div style={{ fontSize:14, fontWeight:600, color:"#0F172A", marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.source}</div>
                  {/* Amount + status — icon + text badge, not color alone */}
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <span style={{ padding:"3px 9px", borderRadius:6, fontSize:12, fontWeight:700, background:statusMeta.bg, color:statusMeta.color, border:`1px solid ${statusMeta.border}`, display:"inline-flex", alignItems:"center", gap:4 }}>
                      <span aria-hidden="true">{statusMeta.icon}</span> {statusMeta.label}
                    </span>
                    <span style={{ fontSize:15, fontWeight:700, color:"#0F172A", fontVariantNumeric:"tabular-nums" }}>{$(p.amount)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </nav>

        {/* Detail panel */}
        <main style={{ flex:1, overflowY:"auto", padding:24, display:"flex", flexDirection:"column", gap:18, minWidth:0 }}>
          {/* Payment summary — high contrast */}
          <div role="region" aria-label="Payment details" style={{ background:"#fff", border:"2px solid #E2E8F0", borderRadius:12, padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", color:"#475569", marginBottom:6 }}>
                  {selected.method} · Received {selected.date}
                </div>
                <div style={{ fontSize:15, fontWeight:700, color:"#0F172A", marginBottom:6 }}>{selected.source}</div>
                <div style={{ fontSize:36, fontWeight:800, color:"#0F172A", lineHeight:1, letterSpacing:"-0.02em" }}>{$(selected.amount)}</div>
              </div>
              {/* Status — icon + text + color */}
              <span style={{ padding:"6px 14px", borderRadius:8, fontSize:14, fontWeight:700, background:sm.bg, color:sm.color, border:`2px solid ${sm.border}`, display:"flex", alignItems:"center", gap:6 }}>
                <span aria-hidden="true" style={{ fontSize:16 }}>{sm.icon}</span>
                {sm.label}
              </span>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, borderTop:"2px solid #F1F5F9", paddingTop:16 }}>
              {[
                { label:"Payer / Client", value: selected.payer ?? selected.client ?? "—" },
                { label:"ERA Reference",   value: selected.eraId ?? "—" },
                { label:"Method",          value: selected.method },
              ].map(f => (
                <div key={f.label}>
                  <div style={{ fontSize:12, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"#475569", marginBottom:4 }}>{f.label}</div>
                  <div style={{ fontSize:15, fontWeight:600, color:"#0F172A" }}>{f.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Exception — role=alert, high contrast, not just yellow */}
          {selected.exception && (
            <div role="alert" style={{ background:"#FFF7ED", border:"2px solid #F97316", borderRadius:10, padding:18 }}>
              <div style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:14 }}>
                <span aria-hidden="true" style={{ fontSize:22, lineHeight:1 }}>⚠</span>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:"#7C2D12", lineHeight:1.5 }}>{selected.exception}</div>
                </div>
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {[
                  { label:"Apply as Credit", bg:"#DCFCE7", color:"#14532D", border:"#16A34A" },
                  { label:"Issue Refund",     bg:"#FEF2F2", color:"#7F1D1D", border:"#DC2626" },
                  { label:"Transfer",         bg:"#EFF6FF", color:"#1E3A8A", border:"#2563EB" },
                  { label:"Dismiss",          bg:"#F8FAFC", color:"#334155", border:"#64748B" },
                ].map(a => (
                  <button key={a.label} style={{ height:36, padding:"0 16px", border:`2px solid ${a.border}`, borderRadius:8, fontSize:13, fontWeight:700, color:a.color, background:a.bg, cursor:"pointer" }}>{a.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Ledger — larger text, clear headers */}
          <div role="region" aria-label="Payment ledger" style={{ background:"#fff", border:"2px solid #E2E8F0", borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"14px 18px", borderBottom:"2px solid #E2E8F0" }}>
              <h2 style={{ fontSize:13, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"#475569", margin:0 }}>Payment Ledger</h2>
            </div>
            <table>
              <thead>
                <tr style={{ background:"#F8FAFC" }}>
                  {[
                    { h:"DOS",     tip:"Date of service" },
                    { h:"CPT",     tip:"Procedure code"  },
                    { h:"Charge",  tip:"Billed amount"   },
                    { h:"Paid",    tip:"Insurer payment"  },
                    { h:"Adj",     tip:"Contractual adj"  },
                    { h:"Pt Resp", tip:"Client balance"  },
                  ].map(({h,tip},i) => (
                    <th key={h} title={tip} style={{ padding:"10px 14px", paddingLeft: i===0 ? 18:undefined, textAlign: i<2?"left":"right", fontSize:11, fontWeight:700, color:"#475569", letterSpacing:"0.07em", textTransform:"uppercase", borderBottom:"2px solid #E2E8F0" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LEDGER.map((r,i) => (
                  <tr key={i}>
                    <td style={{ padding:"11px 14px", paddingLeft:18, fontSize:13, color:"#1E293B", borderBottom:"1px solid #F1F5F9" }}>{r.dos}</td>
                    <td style={{ padding:"11px 14px", fontSize:13, fontFamily:"monospace", fontWeight:700, color:"#0F172A", borderBottom:"1px solid #F1F5F9" }}>{r.cpt}</td>
                    <td style={{ padding:"11px 14px", textAlign:"right", fontSize:13, fontVariantNumeric:"tabular-nums", color:"#0F172A", borderBottom:"1px solid #F1F5F9" }}>{r.charge.toFixed(2)}</td>
                    <td style={{ padding:"11px 14px", textAlign:"right", fontSize:13, fontWeight:700, color: r.paid>0?"#065F46":"#94A3B8", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F1F5F9" }}>{r.paid>0?r.paid.toFixed(2):"0.00"}</td>
                    <td style={{ padding:"11px 14px", textAlign:"right", fontSize:13, color: r.adj>0?"#475569":"#94A3B8", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F1F5F9" }}>{r.adj>0?r.adj.toFixed(2):"—"}</td>
                    <td style={{ padding:"11px 14px", textAlign:"right", fontSize:13, fontWeight:700, color: r.ptResp>0?"#B45309":"#94A3B8", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F1F5F9" }}>{r.ptResp>0?r.ptResp.toFixed(2):"—"}</td>
                  </tr>
                ))}
                <tr style={{ background:"#F8FAFC", borderTop:"2px solid #E2E8F0" }}>
                  <td colSpan={2} style={{ padding:"12px 14px", paddingLeft:18, fontSize:13, fontWeight:800, color:"#0F172A" }}>TOTAL</td>
                  <td style={{ padding:"12px 14px", textAlign:"right", fontSize:13, fontWeight:700, color:"#0F172A", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.charge,0).toFixed(2)}</td>
                  <td style={{ padding:"12px 14px", textAlign:"right", fontSize:13, fontWeight:800, color:"#065F46", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.paid,0).toFixed(2)}</td>
                  <td style={{ padding:"12px 14px", textAlign:"right", fontSize:13, color:"#475569", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.adj,0).toFixed(2)}</td>
                  <td style={{ padding:"12px 14px", textAlign:"right", fontSize:13, fontWeight:800, color:"#B45309", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.ptResp,0).toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            {/* Posting actions — large hit targets, visible focus styles */}
            <div style={{ display:"flex", gap:10, flexWrap:"wrap", padding:"16px 18px", borderTop:"2px solid #E2E8F0" }}>
              <button style={{ height:40, padding:"0 20px", border:"none", borderRadius:8, fontSize:14, fontWeight:700, color:"#fff", background:"#2563EB", cursor:"pointer" }}>Post Payment</button>
              {["Split Payment","Transfer Balance","Write Off","Client Billing"].map(a => (
                <button key={a} style={{ height:40, padding:"0 16px", border:"2px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#334155", background:"#fff", cursor:"pointer" }}>{a}</button>
              ))}
              <button style={{ height:40, padding:"0 16px", border:"2px solid #DC2626", borderRadius:8, fontSize:13, fontWeight:600, color:"#7F1D1D", background:"#FEF2F2", cursor:"pointer" }}>Create Refund</button>
            </div>
          </div>

          {/* Timeline — text labels, no color-only */}
          <div role="region" aria-label="Financial timeline" style={{ background:"#fff", border:"2px solid #E2E8F0", borderRadius:12, padding:"16px 18px" }}>
            <h2 style={{ fontSize:13, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"#475569", margin:"0 0 16px" }}>Financial Timeline</h2>
            {TIMELINE.map((t,i) => (
              <div key={i} style={{ display:"flex", gap:14, alignItems:"flex-start", paddingBottom: i<TIMELINE.length-1 ? 16:0, position:"relative" }}>
                {i<TIMELINE.length-1 && <div style={{ position:"absolute", left:11, top:24, width:2, bottom:0, background:"#E2E8F0" }} />}
                {/* Icon inside dot for non-color differentiation */}
                <div aria-hidden="true" style={{ width:24, height:24, borderRadius:"50%", background:t.color, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#fff", position:"relative", zIndex:1 }}>{t.icon}</div>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color:"#0F172A" }}>{t.label}</div>
                  <div style={{ fontSize:12.5, color:"#64748B", marginTop:2 }}>{t.date}</div>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
