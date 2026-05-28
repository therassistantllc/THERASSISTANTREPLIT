import "./_group.css";
import { useState, useMemo } from "react";

/* ── Data ── */
type PS = "ready" | "partial" | "exception" | "review" | "posted";
type Method = "ERA" | "Client" | "Check" | "Card" | "ACH";
interface Pmt { id:string; source:string; eraId?:string; payer?:string; client?:string; amount:number; method:Method; status:PS; date:string; exception?:string; }

const PAYMENTS: Pmt[] = [
  { id:"p1", source:"ERA #ERA-2026-0234", eraId:"ERA-2026-0234", payer:"BCBS Colorado",          amount:1248.22, method:"ERA",     status:"partial",    date:"05/19/2026", exception:"Payment amount exceeds remaining balance by $42.18" },
  { id:"p2", source:"ERA #ERA-2026-0235", eraId:"ERA-2026-0235", payer:"Aetna",                  amount:892.50,  method:"ERA",     status:"ready",      date:"05/19/2026" },
  { id:"p3", source:"Client – Dana Patel",                       client:"Dana Patel",           amount:40.00,   method:"Card",    status:"posted",     date:"05/19/2026" },
  { id:"p4", source:"Client – James Rivera",                     client:"James Rivera",         amount:0.00,    method:"Client", status:"review",     date:"05/18/2026", exception:"Copay collected: $0 — verify Medicare advantage plan" },
  { id:"p5", source:"ERA #ERA-2026-0231", eraId:"ERA-2026-0231", payer:"Colorado Medicaid",      amount:2104.80, method:"ERA",     status:"posted",     date:"05/16/2026" },
  { id:"p6", source:"Check #44821",                                                               amount:618.00,  method:"Check",   status:"ready",      date:"05/15/2026" },
  { id:"p7", source:"ERA #ERA-2026-0229", eraId:"ERA-2026-0229", payer:"United Behavioral Health",amount:330.00, method:"ERA",     status:"exception",  date:"05/14/2026", exception:"Unmatched claim — no matching claim found in system" },
  { id:"p8", source:"Client – Sofia Martinez",                   client:"Sofia Martinez",       amount:0.00,    method:"ACH",     status:"review",     date:"05/13/2026", exception:"ACH returned — insufficient funds" },
];

const LEDGER = [
  { dos:"05/02", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/25", cpt:"90837", charge:150, paid:98,    adj:32,    ptResp:20  },
  { dos:"04/11", cpt:"90834", charge:120, paid:0,     adj:0,     ptResp:120 },
  { dos:"03/28", cpt:"90837", charge:150, paid:98.22, adj:31.78, ptResp:20  },
  { dos:"03/14", cpt:"90791", charge:195, paid:130.5, adj:44.5,  ptResp:20  },
];

const TIMELINE = [
  { label:"Claim Submitted",             date:"04/25/2026", color:"#3B82F6" },
  { label:"ERA Received from BCBS",      date:"05/12/2026", color:"#059669" },
  { label:"Payment Partially Applied",   date:"05/19/2026", color:"#D97706" },
  { label:"Client Balance Created – $20", date:"05/19/2026", color:"#3B82F6" },
  { label:"Statement Pending",           date:"—",          color:"#94A3B8" },
];

const STATUS_META: Record<PS, { label:string; bg:string; color:string; tier:number }> = {
  exception: { label:"Exception",       bg:"#FEE2E2", color:"#991B1B", tier:1 },
  review:    { label:"Needs Review",    bg:"#DBEAFE", color:"#1D4ED8", tier:2 },
  partial:   { label:"Partially Applied",bg:"#FEF3C7",color:"#92400E", tier:2 },
  ready:     { label:"Ready to Post",   bg:"#D1FAE5", color:"#065F46", tier:3 },
  posted:    { label:"Posted",          bg:"#F1F5F9", color:"#475569", tier:4 },
};

const $ = (v:number) => v.toLocaleString(undefined,{style:"currency",currency:"USD"});

/* ── Section label ── */
function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:"#94A3B8", padding:"12px 16px 6px", borderBottom:"1px solid #F1F5F9" }}>
      {children}
    </div>
  );
}

/* ── Status pill ── */
function Pill({ status }: { status: PS }) {
  const m = STATUS_META[status];
  return <span style={{ background:m.bg, color:m.color, padding:"2px 8px", borderRadius:20, fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>{m.label}</span>;
}

export function V1Hierarchy() {
  const [sel, setSel] = useState<string>("p1");
  const [tab, setTab] = useState("all");
  const selected = PAYMENTS.find(p => p.id === sel)!;

  /* Sort by urgency tier then date */
  const sorted = useMemo(() => {
    let list = [...PAYMENTS];
    if (tab === "era")        list = list.filter(p => p.method === "ERA");
    if (tab === "unapplied")  list = list.filter(p => p.status === "ready" || p.status === "partial");
    if (tab === "exceptions") list = list.filter(p => p.status === "exception" || p.status === "review");
    return list.sort((a, b) => STATUS_META[a.status].tier - STATUS_META[b.status].tier);
  }, [tab]);

  /* Group by tier */
  const urgent   = sorted.filter(p => STATUS_META[p.status].tier <= 2);
  const actionable = sorted.filter(p => STATUS_META[p.status].tier === 3);
  const done     = sorted.filter(p => STATUS_META[p.status].tier === 4);

  const kpi = {
    posted:    $(PAYMENTS.filter(p => p.status === "posted").reduce((s,p) => s+p.amount, 0)),
    pendingEra: PAYMENTS.filter(p => p.method === "ERA" && p.status !== "posted").length,
    unapplied: $(PAYMENTS.filter(p => p.status === "ready" || p.status === "partial").reduce((s,p) => s+p.amount, 0)),
    exceptions: PAYMENTS.filter(p => p.status === "exception" || p.status === "review").length,
  };

  const TABS = ["all","era","unapplied","exceptions"] as const;
  const TAB_LABELS: Record<string,string> = { all:"All", era:"ERA", unapplied:"Unapplied", exceptions:"Exceptions" };

  const renderGroup = (items: Pmt[], label: string, accent: string) => {
    if (!items.length) return null;
    return (
      <>
        <SectionLabel>{label}</SectionLabel>
        {items.map(p => {
          const isSelected = sel === p.id;
          return (
            <div key={p.id} onClick={() => setSel(p.id)} style={{ padding:"12px 16px", borderBottom:"1px solid #F1F5F9", background: isSelected ? "#EFF6FF" : "#fff", borderLeft: isSelected ? `3px solid ${accent}` : "3px solid transparent", cursor:"pointer", transition:"background 0.1s" }}>
              {/* Row top: source dominant */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 }}>
                <span style={{ fontSize:13, fontWeight:700, color:"#0F172A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }}>{p.source}</span>
                {/* Amount — dominant number */}
                <span style={{ fontSize:15, fontWeight:800, color:"#0F172A", fontVariantNumeric:"tabular-nums", flexShrink:0 }}>{$(p.amount)}</span>
              </div>
              {/* Row bottom: status + meta at lower weight */}
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Pill status={p.status} />
                <span style={{ fontSize:11, color:"#94A3B8" }}>{p.payer ?? p.client ?? p.method} · {p.date}</span>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden", background:"#F8FAFC", fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Header — minimal, title is the hero */}
      <header style={{ background:"#fff", borderBottom:"1px solid #E2E8F0", padding:"0 20px", display:"flex", alignItems:"center", height:52, flexShrink:0, gap:12 }}>
        <span style={{ fontSize:18, fontWeight:800, color:"#0F172A", letterSpacing:"-0.02em" }}>Payments &amp; ERA</span>
        <div style={{ flex:1 }} />
        <input type="date" style={{ height:32, padding:"0 10px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:12.5, color:"#1E293B", background:"#F8FAFC", outline:"none" }} defaultValue="2026-05-19" />
        <button style={{ height:32, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:7, fontSize:13, fontWeight:500, color:"#475569", background:"#fff" }}>Export</button>
        <button style={{ height:32, padding:"0 14px", border:"1px solid #3B82F6", borderRadius:7, fontSize:13, fontWeight:700, color:"#fff", background:"#3B82F6" }}>+ Post Payment</button>
      </header>

      {/* KPI Row — ordered by urgency: exceptions lead */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:1, background:"#E2E8F0", borderBottom:"1px solid #E2E8F0", flexShrink:0 }}>
        {[
          { label:"Exceptions", value:String(kpi.exceptions), sub:"Needs attention", color:"#DC2626" },
          { label:"Unapplied Cash", value:kpi.unapplied, sub:"Awaiting posting", color:"#D97706" },
          { label:"Pending ERAs", value:String(kpi.pendingEra), sub:"ERA queue", color:"#3B82F6" },
          { label:"Posted Today", value:kpi.posted, sub:"↑ 12% vs last week", color:"#059669" },
        ].map(k => (
          <div key={k.label} style={{ background:"#fff", padding:"14px 16px" }}>
            {/* Label first — hierarchy: context before number */}
            <div style={{ fontSize:11, fontWeight:600, letterSpacing:"0.05em", textTransform:"uppercase", color:"#94A3B8", marginBottom:6 }}>{k.label}</div>
            <div style={{ fontSize:22, fontWeight:800, color:k.color, lineHeight:1, marginBottom:4 }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#94A3B8" }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Body */}
      <div style={{ display:"flex", flex:1, minHeight:0 }}>
        {/* Queue */}
        <div style={{ width:380, flexShrink:0, borderRight:"1px solid #E2E8F0", display:"flex", flexDirection:"column", background:"#fff", overflow:"hidden" }}>
          {/* Tabs */}
          <div style={{ display:"flex", borderBottom:"1px solid #E2E8F0", flexShrink:0, overflowX:"auto" }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ padding:"10px 14px", fontSize:12.5, fontWeight: tab===t ? 700 : 500, color: tab===t ? "#3B82F6" : "#64748B", border:"none", borderBottom: tab===t ? "2px solid #3B82F6" : "2px solid transparent", background:"transparent", marginBottom:-1, whiteSpace:"nowrap", cursor:"pointer" }}>{TAB_LABELS[t]}</button>
            ))}
          </div>

          {/* Grouped list — hierarchy-sorted */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {renderGroup(urgent,    "Needs Attention", "#DC2626")}
            {renderGroup(actionable,"Ready to Post",   "#059669")}
            {renderGroup(done,      "Posted",          "#94A3B8")}
          </div>
        </div>

        {/* Detail */}
        <div style={{ flex:1, overflowY:"auto", padding:20, display:"flex", flexDirection:"column", gap:16, minWidth:0 }}>
          {/* Payment summary — amount is hero */}
          <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
              <div>
                <div style={{ fontSize:12, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", color:"#94A3B8", marginBottom:4 }}>{selected.method} · {selected.date}</div>
                {/* Title as H2, amount as H1 */}
                <div style={{ fontSize:13, fontWeight:600, color:"#475569", marginBottom:2 }}>{selected.source}</div>
                <div style={{ fontSize:32, fontWeight:800, color:"#0F172A", lineHeight:1, letterSpacing:"-0.02em" }}>{$(selected.amount)}</div>
              </div>
              <Pill status={selected.status} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, borderTop:"1px solid #F1F5F9", paddingTop:14 }}>
              {[
                { label:"Payer / Client", value: selected.payer ?? selected.client ?? "—" },
                { label:"ERA #",           value: selected.eraId ?? "—" },
                { label:"Received",        value: selected.date },
              ].map(f => (
                <div key={f.label}>
                  <div style={{ fontSize:10.5, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#94A3B8", marginBottom:3 }}>{f.label}</div>
                  <div style={{ fontSize:13, fontWeight:600, color:"#1E293B" }}>{f.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Exception */}
          {selected.exception && (
            <div style={{ background:"#FEF3C7", border:"1px solid #FDE68A", borderRadius:8, padding:"14px 16px" }}>
              <div style={{ fontSize:12, fontWeight:700, color:"#92400E", marginBottom:10 }}>⚠ {selected.exception}</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {["Apply as Credit","Refund","Transfer","Dismiss"].map(a => (
                  <button key={a} style={{ height:28, padding:"0 12px", border:"1px solid #FCD34D", borderRadius:6, fontSize:12, fontWeight:600, color:"#92400E", background:"#FEF9C3", cursor:"pointer" }}>{a}</button>
                ))}
              </div>
            </div>
          )}

          {/* Ledger — data dense, clear column hierarchy */}
          <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, overflow:"hidden" }}>
            <div style={{ padding:"12px 16px", borderBottom:"1px solid #F1F5F9" }}>
              <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#64748B" }}>Payment Ledger</span>
            </div>
            <table>
              <thead>
                <tr style={{ background:"#F8FAFC" }}>
                  {["DOS","CPT","Charge","Paid","Adj","Pt Resp"].map((h,i) => (
                    <th key={h} style={{ padding:"8px 12px", textAlign: i<2 ? "left":"right", fontSize:10.5, fontWeight:700, color:"#94A3B8", letterSpacing:"0.06em", textTransform:"uppercase", borderBottom:"1px solid #E2E8F0", paddingLeft: i===0 ? 16 : undefined }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LEDGER.map((r,i) => (
                  <tr key={i}>
                    <td style={{ padding:"9px 12px", paddingLeft:16, fontSize:12, fontWeight:500, color:"#1E293B", borderBottom:"1px solid #F8FAFC" }}>{r.dos}</td>
                    <td style={{ padding:"9px 12px", fontSize:12, fontFamily:"monospace", fontWeight:600, color:"#0F172A", borderBottom:"1px solid #F8FAFC" }}>{r.cpt}</td>
                    <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, color:"#1E293B", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.charge.toFixed(2)}</td>
                    <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, fontWeight:600, color: r.paid > 0 ? "#059669":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.paid > 0 ? r.paid.toFixed(2):"0.00"}</td>
                    <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, color: r.adj > 0 ? "#94A3B8":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.adj > 0 ? r.adj.toFixed(2):"—"}</td>
                    <td style={{ padding:"9px 12px", textAlign:"right", fontSize:12, fontWeight:600, color: r.ptResp > 0 ? "#D97706":"#CBD5E1", fontVariantNumeric:"tabular-nums", borderBottom:"1px solid #F8FAFC" }}>{r.ptResp > 0 ? r.ptResp.toFixed(2):"—"}</td>
                  </tr>
                ))}
                <tr style={{ background:"#F8FAFC" }}>
                  <td colSpan={2} style={{ padding:"10px 12px", paddingLeft:16, fontSize:12, fontWeight:800, color:"#0F172A" }}>TOTAL</td>
                  <td style={{ padding:"10px 12px", textAlign:"right", fontSize:12, fontWeight:700, color:"#0F172A", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.charge,0).toFixed(2)}</td>
                  <td style={{ padding:"10px 12px", textAlign:"right", fontSize:12, fontWeight:700, color:"#059669", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.paid,0).toFixed(2)}</td>
                  <td style={{ padding:"10px 12px", textAlign:"right", fontSize:12, color:"#94A3B8", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.adj,0).toFixed(2)}</td>
                  <td style={{ padding:"10px 12px", textAlign:"right", fontSize:12, fontWeight:700, color:"#D97706", fontVariantNumeric:"tabular-nums" }}>{LEDGER.reduce((s,r)=>s+r.ptResp,0).toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            {/* Post actions */}
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", padding:"14px 16px", borderTop:"1px solid #F1F5F9" }}>
              <button style={{ height:34, padding:"0 18px", border:"none", borderRadius:8, fontSize:13, fontWeight:700, color:"#fff", background:"#3B82F6", cursor:"pointer" }}>Post Payment</button>
              {["Split Payment","Transfer Balance","Write Off","Send to Client Billing"].map(a => (
                <button key={a} style={{ height:34, padding:"0 14px", border:"1px solid #E2E8F0", borderRadius:8, fontSize:13, fontWeight:500, color:"#475569", background:"#fff", cursor:"pointer" }}>{a}</button>
              ))}
              <button style={{ height:34, padding:"0 14px", border:"1px solid #FCA5A5", borderRadius:8, fontSize:13, fontWeight:500, color:"#DC2626", background:"#fff", cursor:"pointer" }}>Create Refund</button>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ background:"#fff", border:"1px solid #E2E8F0", borderRadius:10, padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#64748B", marginBottom:14 }}>Financial Timeline</div>
            {TIMELINE.map((t, i) => (
              <div key={i} style={{ display:"flex", gap:12, alignItems:"flex-start", paddingBottom: i < TIMELINE.length-1 ? 14 : 0, position:"relative" }}>
                {i < TIMELINE.length-1 && <div style={{ position:"absolute", left:9, top:20, width:2, bottom:0, background:"#E2E8F0" }} />}
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
  );
}
