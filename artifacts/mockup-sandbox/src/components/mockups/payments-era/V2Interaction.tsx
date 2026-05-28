import "./_group.css";
import { useState, useMemo } from "react";

/* ── Data ── */
type PS = "ready" | "partial" | "exception" | "review" | "posted";
type Method = "ERA" | "Client" | "Check" | "Card" | "ACH";
interface Pmt { id:string; source:string; eraId?:string; payer?:string; client?:string; amount:number; method:Method; status:PS; date:string; exception?:string; }

const PAYMENTS: Pmt[] = [
  { id:"p1", source:"ERA #ERA-2026-0234", eraId:"ERA-2026-0234", payer:"BCBS Colorado",           amount:1248.22, method:"ERA",     status:"partial",   date:"05/19/2026", exception:"Payment amount exceeds remaining balance by $42.18" },
  { id:"p2", source:"ERA #ERA-2026-0235", eraId:"ERA-2026-0235", payer:"Aetna",                   amount:892.50,  method:"ERA",     status:"ready",     date:"05/19/2026" },
  { id:"p3", source:"Client – Dana Patel",                       client:"Dana Patel",            amount:40.00,   method:"Card",    status:"posted",    date:"05/19/2026" },
  { id:"p4", source:"Client – James Rivera",                     client:"James Rivera",          amount:0.00,    method:"Client", status:"review",    date:"05/18/2026", exception:"Copay collected: $0 — verify Medicare advantage plan" },
  { id:"p5", source:"ERA #ERA-2026-0231", eraId:"ERA-2026-0231", payer:"Colorado Medicaid",       amount:2104.80, method:"ERA",     status:"posted",    date:"05/16/2026" },
  { id:"p6", source:"Check #44821",                                                                amount:618.00,  method:"Check",   status:"ready",     date:"05/15/2026" },
  { id:"p7", source:"ERA #ERA-2026-0229", eraId:"ERA-2026-0229", payer:"United Behavioral Health", amount:330.00, method:"ERA",     status:"exception", date:"05/14/2026", exception:"Unmatched claim — no matching claim found in system" },
  { id:"p8", source:"Client – Sofia Martinez",                   client:"Sofia Martinez",        amount:0.00,    method:"ACH",     status:"review",    date:"05/13/2026", exception:"ACH returned — insufficient funds" },
];

const LEDGER = [
  { dos:"05/02", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/25", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/11", cpt:"90834", charge:120, paid:0,     adj:0,     ptResp:120 },
  { dos:"03/28", cpt:"90837", charge:150, paid:98.22, adj:31.78, ptResp:20  },
  { dos:"03/14", cpt:"90791", charge:195, paid:130.5, adj:44.5,  ptResp:20  },
];

const TIMELINE = [
  { label:"Claim Submitted",           date:"04/25/2026", color:"#3B82F6" },
  { label:"ERA Received from BCBS",    date:"05/12/2026", color:"#059669" },
  { label:"Payment Partially Applied", date:"05/19/2026", color:"#D97706" },
  { label:"Client Balance – $20",     date:"05/19/2026", color:"#3B82F6" },
  { label:"Statement Pending",         date:"—",          color:"#94A3B8" },
];

type QueueTab = "all"|"era"|"client"|"checks"|"unapplied"|"exceptions";
const TAB_INFO: { id:QueueTab; label:string }[] = [
  { id:"all",        label:"All"        },
  { id:"era",        label:"ERA"        },
  { id:"client",    label:"Client"    },
  { id:"checks",     label:"Checks"     },
  { id:"unapplied",  label:"Unapplied"  },
  { id:"exceptions", label:"Exceptions" },
];

const STATUS_META: Record<PS,{label:string;bg:string;color:string}> = {
  ready:     { label:"Ready to Post",    bg:"#D1FAE5", color:"#065F46" },
  partial:   { label:"Partially Applied",bg:"#FEF3C7", color:"#92400E" },
  exception: { label:"Exception",        bg:"#FEE2E2", color:"#991B1B" },
  review:    { label:"Needs Review",     bg:"#DBEAFE", color:"#1D4ED8" },
  posted:    { label:"Posted",           bg:"#F1F5F9", color:"#475569" },
};

function methodIcon(m: Method) {
  if (m==="ERA")    return { bg:"#EDE9FE", color:"#7C3AED", text:"ERA" };
  if (m==="Check")  return { bg:"#DBEAFE", color:"#1D4ED8", text:"CHK" };
  if (m==="Client"||m==="Card"||m==="ACH") return { bg:"#D1FAE5", color:"#065F46", text:"$" };
  return { bg:"#FEE2E2", color:"#991B1B", text:"!" };
}

const $ = (v:number) => v.toLocaleString(undefined,{style:"currency",currency:"USD"});

/* Row with hover quick-actions */
function QueueRow({ pmt, isSelected, onSelect }: { pmt:Pmt; isSelected:boolean; onSelect:()=>void }) {
  const [hovered, setHovered] = useState(false);
  const icon = methodIcon(pmt.method);
  const sm = STATUS_META[pmt.status];
  const canPost = pmt.status === "ready" || pmt.status === "partial";
  const hasException = !!pmt.exception;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
      style={{ padding:"10px 14px", borderBottom:"1px solid #F1F5F9", background: isSelected ? "#EFF6FF" : hovered ? "#F8FAFC" : "#fff", borderLeft: isSelected ? "3px solid #3B82F6" : "3px solid transparent", cursor:"pointer", transition:"background 0.1s", position:"relative" }}
    >
      <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
        {/* Icon */}
        <div style={{ width:32, height:32, borderRadius:8, background:icon.bg, color:icon.color, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:800, flexShrink:0, marginTop:1 }}>{icon.text}</div>

        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
            <span style={{ fontSize:13, fontWeight:600, color:"#0F172A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 }}>{pmt.source}</span>
            <span style={{ fontSize:13.5, fontWeight:700, color:"#0F172A", fontVariantNumeric:"tabular-nums", flexShrink:0 }}>{$(pmt.amount)}</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            <span style={{ background:sm.bg, color:sm.color, padding:"1px 7px", borderRadius:20, fontSize:10.5, fontWeight:700 }}>{sm.label}</span>
            <span style={{ fontSize:11, color:"#94A3B8" }}>{pmt.payer ?? pmt.client ?? pmt.method} · {pmt.date}</span>
          </div>
        </div>
      </div>

      {/* Hover quick-action strip — affordance visible on hover */}
      {(hovered || isSelected) && (
        <div style={{ display:"flex", gap:6, marginTop:10, paddingTop:8, borderTop:"1px solid #E2E8F0" }}>
          {canPost && (
            <button onClick={e => e.stopPropagation()} style={{ height:28, padding:"0 12px", border:"none", borderRadius:6, fontSize:11.5, fontWeight:700, color:"#fff", background:"#3B82F6", cursor:"pointer" }}>
              ↑ Post Payment
            </button>
          )}
          {hasException && (
            <button onClick={e => e.stopPropagation()} style={{ height:28, padding:"0 12px", border:"1px solid #FCD34D", borderRadius:6, fontSize:11.5, fontWeight:600, color:"#92400E", background:"#FEF9C3", cursor:"pointer" }}>
              ⚠ Resolve
            </button>
          )}
          <button onClick={e => e.stopPropagation()} style={{ height:28, padding:"0 12px", border:"1px solid #E2E8F0", borderRadius:6, fontSize:11.5, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>
            View Detail →
          </button>
        </div>
      )}
    </div>
  );
}

export function V2Interaction() {
  const [sel, setSel] = useState("p1");
  const [tab, setTab] = useState<QueueTab>("all");
  const selected = PAYMENTS.find(p => p.id === sel)!;

  const counts: Record<QueueTab, number> = useMemo(() => ({
    all:        PAYMENTS.length,
    era:        PAYMENTS.filter(p => p.method === "ERA").length,
    client:    PAYMENTS.filter(p => ["Client","Card","ACH"].includes(p.method)).length,
    checks:     PAYMENTS.filter(p => p.method === "Check").length,
    unapplied:  PAYMENTS.filter(p => p.status === "ready" || p.status === "partial").length,
    exceptions: PAYMENTS.filter(p => p.status === "exception" || p.status === "review").length,
  }), []);

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
    exceptions: PAYMENTS.filter(p => p.status==="exception"||p.status==="review").length,
    refunds: 3,
    client: $(PAYMENTS.filter(p => ["Client","Card","ACH"].includes(p.method)).reduce((s,p)=>s+p.amount,0)),
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden", background:"#F8FAFC", fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {/* Header — primary CTA is unmissable */}
      <header style={{ background:"#fff", borderBottom:"1px solid #E2E8F0", padding:"0 20px", display:"flex", alignItems:"center", height:52, flexShrink:0, gap:10 }}>
        <span style={{ fontSize:16, fontWeight:700, color:"#0F172A" }}>Payments &amp; ERA</span>
        <div style={{ flex:1 }} />
        {/* Contextual search with clear placeholder */}
        <div style={{ position:"relative" }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", color:"#94A3B8", pointerEvents:"none", display:"flex" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input style={{ height:32, padding:"0 10px 0 32px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:13, color:"#1E293B", background:"#F8FAFC", outline:"none", width:220 }} placeholder="Search ERA #, client, payer…" />
        </div>
        <input type="date" style={{ height:32, padding:"0 10px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:12.5, color:"#1E293B", background:"#F8FAFC", outline:"none" }} defaultValue="2026-05-19" />
        {/* Secondary actions clearly labeled */}
        <button style={{ height:32, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export
        </button>
        <button style={{ height:32, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import ERA
        </button>
        {/* Primary CTA — high-contrast, large hit target */}
        <button style={{ height:36, padding:"0 18px", border:"none", borderRadius:8, fontSize:14, fontWeight:700, color:"#fff", background:"#3B82F6", cursor:"pointer", display:"flex", alignItems:"center", gap:6, boxShadow:"0 1px 4px rgba(59,130,246,0.3)" }}>
          <span style={{ fontSize:16, lineHeight:1 }}>+</span> Post Payment
        </button>
      </header>

      {/* KPI Row — each card has a direct action link */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:1, background:"#E2E8F0", borderBottom:"1px solid #E2E8F0", flexShrink:0 }}>
        {[
          { label:"Posted Today",    value:kpi.posted,          sub:"↑ 12% vs last week",  color:"#059669", action:null },
          { label:"Pending ERAs",    value:String(kpi.pendingEra),sub:"Click to review",   color:"#3B82F6", action:()=>setTab("era") },
          { label:"Unapplied Cash",  value:kpi.unapplied,       sub:"Click to post",       color:"#D97706", action:()=>setTab("unapplied") },
          { label:"Client Payments",value:kpi.client,          sub:"Click to review",    color:"#0F172A", action:()=>setTab("client") },
          { label:"Refund Requests", value:"3",                  sub:"Pending approval",   color:"#0F172A", action:null },
          { label:"Exceptions",      value:String(kpi.exceptions),sub:"Click to resolve",  color:"#DC2626", action:()=>setTab("exceptions") },
        ].map(k => (
          <div key={k.label} onClick={() => k.action?.()} style={{ background:"#fff", padding:"12px 16px", cursor: k.action ? "pointer":"default", transition:"background 0.1s" }}>
            <div style={{ fontSize:20, fontWeight:700, color:k.color, lineHeight:1 }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#94A3B8", fontWeight:500, marginTop:3 }}>{k.label}</div>
            {k.action && <div style={{ fontSize:10.5, color:"#3B82F6", marginTop:4, fontWeight:500 }}>{k.sub} →</div>}
            {!k.action && <div style={{ fontSize:10.5, color:"#94A3B8", marginTop:4 }}>{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ display:"flex", flex:1, minHeight:0 }}>
        {/* Queue */}
        <div style={{ width:420, flexShrink:0, borderRight:"1px solid #E2E8F0", display:"flex", flexDirection:"column", background:"#fff", overflow:"hidden" }}>
          {/* Tabs with counts — affordance visibility */}
          <div style={{ display:"flex", borderBottom:"1px solid #E2E8F0", flexShrink:0, overflowX:"auto" }}>
            {TAB_INFO.map(t => {
              const count = counts[t.id];
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{ padding:"10px 12px", fontSize:12, fontWeight: active ? 700:500, color: active ? "#3B82F6":"#64748B", border:"none", borderBottom: active ? "2px solid #3B82F6":"2px solid transparent", background:"transparent", marginBottom:-1, whiteSpace:"nowrap", cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                  {t.label}
                  {/* Count badge — tells user there's work to do */}
                  {count > 0 && (
                    <span style={{ background: active ? "#DBEAFE":"#F1F5F9", color: active ? "#1D4ED8":"#64748B", borderRadius:10, fontSize:10, fontWeight:700, padding:"1px 6px", minWidth:18, textAlign:"center" }}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Queue list with hover actions */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {filtered.map(p => (
              <QueueRow key={p.id} pmt={p} isSelected={sel===p.id} onSelect={() => setSel(p.id)} />
            ))}
          </div>

          {/* Bulk action bar (contextual footer) */}
          <div style={{ borderTop:"1px solid #E2E8F0", padding:"10px 14px", background:"#F8FAFC", display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
            <span style={{ fontSize:12, color:"#94A3B8", flex:1 }}>{filtered.filter(p=>p.status==="ready"||p.status==="partial").length} ready to post</span>
            <button style={{ height:30, padding:"0 14px", border:"none", borderRadius:7, fontSize:12, fontWeight:700, color:"#fff", background:"#3B82F6", cursor:"pointer" }}>Batch Post All</button>
          </div>
        </div>

        {/* Detail — sticky primary action */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
          {/* Sticky action bar at top of detail */}
          <div style={{ borderBottom:"1px solid #E2E8F0", background:"#fff", padding:"10px 20px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
            <div style={{ flex:1 }}>
              <span style={{ fontSize:14, fontWeight:700, color:"#0F172A" }}>{selected.source}</span>
              <span style={{ marginLeft:10 }}>
                <span style={{ background:STATUS_META[selected.status].bg, color:STATUS_META[selected.status].color, padding:"2px 9px", borderRadius:20, fontSize:11.5, fontWeight:700 }}>{STATUS_META[selected.status].label}</span>
              </span>
            </div>
            {/* Primary action always visible */}
            {(selected.status==="ready"||selected.status==="partial") && (
              <button style={{ height:36, padding:"0 20px", border:"none", borderRadius:8, fontSize:14, fontWeight:700, color:"#fff", background:"#059669", cursor:"pointer", boxShadow:"0 1px 3px rgba(5,150,105,0.25)" }}>
                ✓ Post Payment
              </button>
            )}
            {(selected.status==="exception"||selected.status==="review") && (
              <button style={{ height:36, padding:"0 20px", border:"1px solid #FCD34D", borderRadius:8, fontSize:14, fontWeight:700, color:"#92400E", background:"#FEF9C3", cursor:"pointer" }}>
                ⚠ Resolve Exception
              </button>
            )}
          </div>

          <div style={{ flex:1, overflowY:"auto", padding:20, display:"flex", flexDirection:"column", gap:16 }}>
            {/* Summary card */}
            <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, padding:16 }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                {[
                  { label:"Amount", value:$(selected.amount), large:true },
                  { label:"Method", value:selected.method },
                  { label:"Received", value:selected.date },
                  { label:"Payer / Client", value:selected.payer ?? selected.client ?? "—" },
                  { label:"ERA #", value:selected.eraId ?? "—" },
                ].map(f => (
                  <div key={f.label}>
                    <div style={{ fontSize:10.5, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:"#94A3B8", marginBottom:2 }}>{f.label}</div>
                    <div style={{ fontSize: f.large ? 20:13, fontWeight: f.large ? 800:600, color:"#0F172A" }}>{f.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Exception with clearly labeled, large action buttons */}
            {selected.exception && (
              <div style={{ background:"#FEF3C7", border:"1px solid #FDE68A", borderRadius:8, padding:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#92400E", marginBottom:12 }}>⚠ {selected.exception}</div>
                {/* Large, labeled buttons — affordance obvious */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8 }}>
                  {[
                    { label:"Apply as Credit", desc:"Keep in account", bg:"#D1FAE5", color:"#065F46", border:"#6EE7B7" },
                    { label:"Refund",           desc:"Return to payer", bg:"#FEE2E2", color:"#991B1B", border:"#FCA5A5" },
                    { label:"Transfer",         desc:"Move to client", bg:"#DBEAFE", color:"#1D4ED8", border:"#93C5FD" },
                    { label:"Dismiss",          desc:"Mark resolved",   bg:"#F1F5F9", color:"#475569", border:"#E2E8F0" },
                  ].map(a => (
                    <button key={a.label} style={{ padding:"10px 12px", border:`1px solid ${a.border}`, borderRadius:8, fontSize:12, fontWeight:700, color:a.color, background:a.bg, cursor:"pointer", textAlign:"center", display:"flex", flexDirection:"column", gap:2, alignItems:"center" }}>
                      <span>{a.label}</span>
                      <span style={{ fontSize:10.5, fontWeight:400, opacity:0.75 }}>{a.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Ledger */}
            <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, overflow:"hidden" }}>
              <div style={{ padding:"12px 16px", borderBottom:"1px solid #F1F5F9" }}>
                <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#64748B" }}>Payment Ledger</span>
              </div>
              <table>
                <thead>
                  <tr style={{ background:"#F8FAFC" }}>
                    {["DOS","CPT","Charge","Paid","Adj","Pt Resp"].map((h,i) => (
                      <th key={h} style={{ padding:"8px 12px", paddingLeft: i===0 ? 16:undefined, textAlign: i<2?"left":"right", fontSize:10.5, fontWeight:700, color:"#94A3B8", letterSpacing:"0.06em", textTransform:"uppercase", borderBottom:"1px solid #E2E8F0" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LEDGER.map((r,i) => (
                    <tr key={i}>
                      <td style={{ padding:"9px 12px", paddingLeft:16, fontSize:12, color:"#1E293B", borderBottom:"1px solid #F8FAFC" }}>{r.dos}</td>
                      <td style={{ padding:"9px 12px", fontSize:12, fontFamily:"monospace", fontWeight:600, color:"#0F172A", borderBottom:"1px solid #F8FAFC" }}>{r.cpt}</td>
                      <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.charge.toFixed(2)}</td>
                      <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, fontWeight:600, color: r.paid>0?"#059669":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.paid>0?r.paid.toFixed(2):"0.00"}</td>
                      <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, color: r.adj>0?"#94A3B8":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.adj>0?r.adj.toFixed(2):"—"}</td>
                      <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, fontWeight:600, color: r.ptResp>0?"#D97706":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.ptResp>0?r.ptResp.toFixed(2):"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Posting actions — clear primary vs secondary */}
              <div style={{ display:"flex", gap:8, flexWrap:"wrap", padding:"14px 16px", borderTop:"1px solid #F1F5F9" }}>
                <button style={{ height:34, padding:"0 18px", border:"none", borderRadius:8, fontSize:13, fontWeight:700, color:"#fff", background:"#3B82F6", cursor:"pointer" }}>↑ Post Payment</button>
                <button style={{ height:34, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>⇄ Split</button>
                <button style={{ height:34, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>→ Transfer Balance</button>
                <button style={{ height:34, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>✕ Write Off</button>
                <button style={{ height:34, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>✉ Client Billing</button>
                <button style={{ height:34, padding:"0 14px", border:"1px solid #FCA5A5", borderRadius:8, fontSize:13, fontWeight:500, color:"#DC2626", background:"#fff", cursor:"pointer" }}>↩ Refund</button>
              </div>
            </div>

            {/* Timeline */}
            <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, padding:"14px 16px" }}>
              <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#64748B", marginBottom:14 }}>Financial Timeline</div>
              {TIMELINE.map((t,i) => (
                <div key={i} style={{ display:"flex", gap:12, alignItems:"flex-start", paddingBottom: i<TIMELINE.length-1 ? 14:0, position:"relative" }}>
                  {i<TIMELINE.length-1 && <div style={{ position:"absolute", left:9, top:20, width:2, bottom:0, background:"#E2E8F0" }} />}
                  <div style={{ width:20, height:20, borderRadius:"50%", background:t.color, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#fff", position:"relative", zIndex:1 }}>✓</div>
                  <div>
                    <div style={{ fontSize:12.5, fontWeight:600, color:"#1E293B" }}>{t.label}</div>
                    <div style={{ fontSize:11.5, color:"#94A3B8", marginTop:1 }}>{t.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
