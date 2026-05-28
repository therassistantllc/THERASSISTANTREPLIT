import React, { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Inbox,
  CreditCard,
  CheckSquare,
  MessageSquare,
  BarChart2,
  Settings,
  Search,
  Filter,
  ChevronDown,
  Phone,
  RefreshCw,
  XCircle,
  FileText,
  Clock,
  AlertCircle,
  CheckCircle2,
  X,
  FileUp,
  History,
  Info
} from "lucide-react";

// --- MOCK DATA ---
const GLOBAL_NAV = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { id: "clients", icon: Users, label: "Clients" },
  { id: "schedule", icon: Calendar, label: "Schedule" },
  { id: "mailroom", icon: Inbox, label: "Mailroom" },
  { id: "billing", icon: CreditCard, label: "Billing", active: true },
  { id: "tasks", icon: CheckSquare, label: "Tasks" },
  { id: "inbox", icon: MessageSquare, label: "Inbox" },
  { id: "reports", icon: BarChart2, label: "Reports" },
  { id: "settings", icon: Settings, label: "Settings", bottom: true },
];

const BILLING_QUEUES = [
  { id: "no_response", label: "No Response", count: 47, value: 12840, dist: [10, 15, 12, 10], active: true },
  { id: "denials", label: "Denials", count: 12, value: 4200, dist: [5, 4, 2, 1] },
  { id: "pt_resp", label: "Client Responsibility", count: 23, value: 3150, dist: [8, 10, 5, 0] },
  { id: "writeoffs", label: "Write-offs", count: 4, value: 850, dist: [0, 1, 1, 2] },
  { id: "submitted", label: "Submitted", count: 156, value: 45200, dist: [120, 26, 10, 0] },
  { id: "recently_posted", label: "Recently Posted", count: 18, value: 0, dist: [18, 0, 0, 0] },
  { id: "manual_review", label: "Manual Review", count: 7, value: 2100, dist: [2, 3, 1, 1] },
];

const CLAIMS = [
  { id: "CLM-20281", client: "Sarah Jenkins", dob: "1985-04-12", dos: "2023-10-15", payer: "Aetna", billed: 150.00, daysOut: 42, status: "No Response", lastAction: "Submitted", assignee: "JD", aged: false },
  { id: "CLM-20282", client: "Michael Chen", dob: "1990-08-22", dos: "2023-09-02", payer: "BCBS", billed: 200.00, daysOut: 85, status: "No Response", lastAction: "Followed up 14d ago", assignee: "JD", aged: false },
  { id: "CLM-20283", client: "Emily Rodriguez", dob: "1978-11-05", dos: "2023-07-20", payer: "UHC", billed: 175.00, daysOut: 128, status: "No Response", lastAction: "Call logged", assignee: "AM", aged: true },
  { id: "CLM-20284", client: "David Smith", dob: "1982-01-30", dos: "2023-10-01", payer: "Medicare", billed: 120.00, daysOut: 56, status: "No Response", lastAction: "Submitted", assignee: "JD", aged: false },
  { id: "CLM-20285", client: "Jessica Taylor", dob: "1995-06-18", dos: "2023-08-15", payer: "Cigna", billed: 180.00, daysOut: 103, status: "No Response", lastAction: "Appealed", assignee: "AM", aged: true },
  { id: "CLM-20286", client: "Robert Johnson", dob: "1970-03-25", dos: "2023-11-05", payer: "Aetna", billed: 150.00, daysOut: 21, status: "No Response", lastAction: "Submitted", assignee: "Unassigned", aged: false },
  { id: "CLM-20287", client: "Amanda Davis", dob: "1988-09-14", dos: "2023-08-01", payer: "BCBS", billed: 200.00, daysOut: 117, status: "No Response", lastAction: "Followed up 30d ago", assignee: "JD", aged: true },
  { id: "CLM-20288", client: "James Wilson", dob: "1975-12-08", dos: "2023-10-20", payer: "UHC", billed: 175.00, daysOut: 37, status: "No Response", lastAction: "Submitted", assignee: "AM", aged: false },
  { id: "CLM-20289", client: "Ashley Moore", dob: "1992-05-19", dos: "2023-09-15", payer: "Medicare", billed: 120.00, daysOut: 72, status: "No Response", lastAction: "Submitted", assignee: "Unassigned", aged: false },
  { id: "CLM-20290", client: "William Taylor", dob: "1980-02-28", dos: "2023-07-05", payer: "Cigna", billed: 180.00, daysOut: 143, status: "No Response", lastAction: "Call logged", assignee: "JD", aged: true },
];

export default function RailLayout() {
  const [selectedClaim, setSelectedClaim] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedClaim(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans overflow-hidden selection:bg-indigo-100">
      
      {/* 1. ICON RAIL (Global Nav) */}
      <nav className="w-16 bg-slate-900 flex flex-col items-center py-4 border-r border-slate-800 shrink-0 z-20 relative">
        <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center text-white font-bold mb-8 shadow-sm">
          T
        </div>
        
        <div className="flex flex-col gap-3 w-full items-center flex-1">
          {GLOBAL_NAV.filter(n => !n.bottom).map(nav => (
            <div key={nav.id} className="relative group cursor-pointer w-full flex justify-center">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors duration-150 ${nav.active ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}>
                <nav.icon className="w-5 h-5" />
              </div>
              {/* Tooltip */}
              <div className="absolute left-14 px-2 py-1 bg-slate-800 text-slate-200 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap z-50 shadow-md border border-slate-700">
                {nav.label}
              </div>
              {/* Active Indicator */}
              {nav.active && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-500 rounded-r-full shadow-[0_0_8px_rgba(99,102,241,0.6)]" />}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 w-full items-center mt-auto">
          {GLOBAL_NAV.filter(n => n.bottom).map(nav => (
             <div key={nav.id} className="relative group cursor-pointer w-full flex justify-center">
             <div className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors duration-150">
               <nav.icon className="w-5 h-5" />
             </div>
             <div className="absolute left-14 px-2 py-1 bg-slate-800 text-slate-200 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap z-50 shadow-md border border-slate-700">
               {nav.label}
             </div>
           </div>
          ))}
          <div className="w-8 h-8 rounded-full bg-slate-700 mt-2 border border-slate-600 overflow-hidden cursor-pointer">
            <img src="https://api.dicebear.com/7.x/notionists/svg?seed=JD&backgroundColor=e2e8f0" alt="Avatar" className="w-full h-full object-cover" />
          </div>
        </div>
      </nav>

      {/* 2. SECOND COLUMN (Billing Workqueues) */}
      <aside className="w-[280px] bg-white border-r border-slate-200 flex flex-col shrink-0 z-10 relative shadow-[1px_0_4px_rgba(0,0,0,0.02)]">
        <div className="p-4 px-5 border-b border-slate-100">
          <h2 className="text-sm font-semibold tracking-tight text-slate-800 uppercase flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-slate-400" />
            Billing Workspace
          </h2>
        </div>
        
        <div className="flex-1 overflow-y-auto py-3">
          <div className="px-3 pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Workqueues</div>
          
          <div className="flex flex-col gap-0.5 px-2">
            {BILLING_QUEUES.map(q => (
              <div 
                key={q.id} 
                className={`group flex flex-col px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 ${q.active ? 'bg-indigo-50/80 border border-indigo-100/50 shadow-sm' : 'hover:bg-slate-50 border border-transparent'}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`text-sm font-medium ${q.active ? 'text-indigo-900' : 'text-slate-700 group-hover:text-slate-900'}`}>
                    {q.label}
                  </span>
                  <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${q.active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>
                    {q.count}
                  </span>
                </div>
                
                <div className="flex items-center justify-between mt-1">
                  {/* Mini-bar for aging dist */}
                  <div className="flex h-1.5 w-16 bg-slate-100 rounded-full overflow-hidden flex-shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
                    {q.dist.map((val, i) => {
                      const total = q.dist.reduce((a,b)=>a+b, 0);
                      const pct = total === 0 ? 0 : (val/total)*100;
                      // Colors: 0-30 green, 31-60 blue, 61-90 yellow, 90+ orange
                      const colors = ['bg-emerald-400', 'bg-indigo-400', 'bg-amber-400', 'bg-orange-500'];
                      return <div key={i} style={{width: `${pct}%`}} className={colors[i]} />
                    })}
                  </div>
                  <span className={`text-xs ${q.active ? 'text-indigo-600' : 'text-slate-400'}`}>
                    ${q.value.toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* 3. MAIN AREA */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#F8FAFC] relative">
        {/* Header & KPIs */}
        <header className="px-8 pt-8 pb-6 border-b border-slate-200/60 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.01)] shrink-0 z-0">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">No Response</h1>
              <p className="text-sm text-slate-500 mt-1">Claims submitted with no payer response past aging threshold.</p>
            </div>
          </div>
          
          {/* KPI Row */}
          <div className="flex gap-4">
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col justify-center">
              <div className="text-slate-500 text-xs font-medium mb-1 uppercase tracking-wide">Open Claims</div>
              <div className="text-2xl font-semibold text-slate-900">47</div>
            </div>
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col justify-center">
              <div className="text-slate-500 text-xs font-medium mb-1 uppercase tracking-wide">Avg Days Out</div>
              <div className="text-2xl font-semibold text-slate-900">38d</div>
            </div>
            <div className="flex-1 bg-orange-50 border border-orange-100 rounded-xl p-4 flex flex-col justify-center shadow-sm shadow-orange-100/20">
              <div className="text-orange-700/80 text-xs font-bold mb-1 uppercase tracking-wide flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                At-Risk Value
              </div>
              <div className="text-2xl font-semibold text-orange-900">$12,840</div>
            </div>
            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col justify-center">
              <div className="text-slate-500 text-xs font-medium mb-1 uppercase tracking-wide">Recently Posted</div>
              <div className="text-2xl font-semibold text-emerald-700 flex items-center gap-2">
                6
                <span className="text-xs font-medium bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded uppercase tracking-wider">Today</span>
              </div>
            </div>
          </div>
        </header>

        {/* Filter Bar */}
        <div className="px-8 py-3 bg-white border-b border-slate-200 flex items-center justify-between shrink-0 sticky top-0 z-10 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input type="text" placeholder="Search claims..." className="pl-9 pr-4 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-shadow w-64" />
            </div>
            
            <div className="h-4 w-px bg-slate-200 mx-1"></div>
            
            <button className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 text-slate-700 transition-colors">
              Payer <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 text-slate-700 transition-colors">
              Assignee <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>
            
            <div className="flex bg-slate-100 rounded-lg p-0.5 ml-2 border border-slate-200/50">
              {['0-30', '31-60', '61-90', '90+'].map((b, i) => (
                <button key={b} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${i === 3 ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                  {b}
                </button>
              ))}
            </div>
          </div>
          
          <button className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors shadow-sm shadow-indigo-200">
            <CheckSquare className="w-4 h-4" />
            Bulk Follow-up
          </button>
        </div>

        {/* Table Area */}
        <div className="flex-1 overflow-auto p-8">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden relative">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="px-5 py-3 w-10 text-center"><input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20" /></th>
                  <th className="px-5 py-3">Client</th>
                  <th className="px-5 py-3">Claim Info</th>
                  <th className="px-5 py-3">Payer</th>
                  <th className="px-5 py-3 text-right">Billed</th>
                  <th className="px-5 py-3 text-center">Days Out</th>
                  <th className="px-5 py-3">Last Action</th>
                  <th className="px-5 py-3">Assignee</th>
                  <th className="px-5 py-3 text-right"></th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100/80">
                {CLAIMS.map((claim) => (
                  <tr 
                    key={claim.id} 
                    onClick={() => setSelectedClaim(claim.id)}
                    className={`group cursor-pointer transition-colors
                      ${selectedClaim === claim.id ? 'bg-indigo-50/50' : 'hover:bg-slate-50'}
                      ${claim.aged && selectedClaim !== claim.id ? 'bg-orange-50/30' : ''}
                    `}
                  >
                    <td className="px-5 py-3.5 text-center">
                      <input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20" onClick={e=>e.stopPropagation()} />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-900">{claim.client}</div>
                      <div className="text-xs text-slate-500 mt-0.5">DOB: {claim.dob}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="font-mono text-slate-700 text-xs mb-0.5">{claim.id}</div>
                      <div className="text-xs text-slate-500">DOS: {claim.dos}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-medium">
                        {claim.payer}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-right font-medium text-slate-700">
                      ${claim.billed.toFixed(2)}
                    </td>
                    <td className="px-5 py-3.5 text-center">
                      <div className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${claim.aged ? 'bg-orange-100 text-orange-700 ring-1 ring-orange-200' : 'bg-slate-100 text-slate-600'}`}>
                        {claim.daysOut}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        <span className="truncate max-w-[120px]">{claim.lastAction}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      {claim.assignee !== "Unassigned" ? (
                        <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold border border-indigo-200">
                          {claim.assignee}
                        </div>
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 border-dashed flex items-center justify-center">
                          <Users className="w-3.5 h-3.5 text-slate-400" />
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="flex items-center justify-end gap-2">
                        <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Call">
                          <Phone className="w-4 h-4" />
                        </button>
                        <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Resubmit">
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="h-12" /> {/* Spacer */}
        </div>
      </main>

      {/* 4. SLIDE-OVER DETAIL PANEL */}
      {/* Backdrop */}
      {selectedClaim && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-[1px] z-30 transition-opacity duration-300" onClick={() => setSelectedClaim(null)} />
      )}
      
      {/* Panel */}
      <div 
        className={`fixed top-0 bottom-0 right-0 w-[520px] bg-white shadow-2xl z-40 transform transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] border-l border-slate-200 flex flex-col ${selectedClaim ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {selectedClaim && (() => {
          const claim = CLAIMS.find(c => c.id === selectedClaim)!;
          return (
            <>
              {/* Header */}
              <div className="px-6 py-5 border-b border-slate-200 flex items-start justify-between bg-slate-50/50">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h2 className="text-xl font-semibold text-slate-900">{claim.id}</h2>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${claim.aged ? 'bg-orange-100 text-orange-700' : 'bg-slate-200 text-slate-700'}`}>
                      {claim.daysOut} Days Out
                    </span>
                  </div>
                  <p className="text-sm text-slate-500">
                    <span className="font-medium text-slate-700">{claim.client}</span> • DOS: {claim.dos}
                  </p>
                </div>
                <button 
                  onClick={() => setSelectedClaim(null)}
                  className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Action Bar */}
              <div className="px-6 py-3 border-b border-slate-100 flex items-center gap-3 bg-white">
                <button className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center justify-center gap-2">
                  <Phone className="w-4 h-4" />
                  Log Call Outcome
                </button>
                <button className="flex-1 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4" />
                  Resubmit
                </button>
                <button className="flex-1 bg-white hover:bg-red-50 text-red-600 border border-slate-200 hover:border-red-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                  <XCircle className="w-4 h-4" />
                  Write off
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 bg-white">
                
                {/* Financial Summary */}
                <div className="grid grid-cols-3 gap-4 mb-8">
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">Total Billed</div>
                    <div className="text-lg font-semibold text-slate-900">${claim.billed.toFixed(2)}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">Expected</div>
                    <div className="text-lg font-semibold text-emerald-700">${(claim.billed * 0.8).toFixed(2)}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">Payer</div>
                    <div className="text-sm font-semibold text-slate-900 truncate mt-1">{claim.payer}</div>
                  </div>
                </div>

                {/* Timeline */}
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-400" />
                    Claim Timeline
                  </h3>
                  
                  <div className="relative pl-4 space-y-6 before:absolute before:inset-y-2 before:left-[11px] before:w-px before:bg-slate-200">
                    <div className="relative">
                      <div className="absolute -left-6 top-1 w-3 h-3 bg-indigo-500 rounded-full ring-4 ring-white" />
                      <div className="text-sm font-medium text-slate-900">Awaiting payer response</div>
                      <div className="text-xs text-slate-500 mt-1">Current Status</div>
                    </div>
                    
                    <div className="relative">
                      <div className="absolute -left-6 top-1 w-3 h-3 bg-slate-300 rounded-full ring-4 ring-white" />
                      <div className="text-sm font-medium text-slate-700">Followed up by AM</div>
                      <div className="text-xs text-slate-500 mt-1">14 days ago • Note: Called payer, rep said claim is in review process. Expect update in 7-10 biz days.</div>
                    </div>
                    
                    <div className="relative">
                      <div className="absolute -left-6 top-1 w-3 h-3 bg-slate-300 rounded-full ring-4 ring-white" />
                      <div className="text-sm font-medium text-slate-700">Pending Adjudication</div>
                      <div className="text-xs text-slate-500 mt-1">32 days ago • Payer acknowledged receipt</div>
                    </div>

                    <div className="relative">
                      <div className="absolute -left-6 top-1 w-3 h-3 bg-slate-300 rounded-full ring-4 ring-white" />
                      <div className="text-sm font-medium text-slate-700">Submitted</div>
                      <div className="text-xs text-slate-500 mt-1">42 days ago • Batch #837-19284</div>
                    </div>
                  </div>
                </div>

                {/* Attachments Stub */}
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-400" />
                    Documents & EOBs
                  </h3>
                  <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50 flex flex-col items-center justify-center gap-2 text-center">
                    <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center mb-1">
                      <FileUp className="w-5 h-5 text-slate-400" />
                    </div>
                    <div className="text-sm font-medium text-slate-700">No documents attached</div>
                    <p className="text-xs text-slate-500">Upload EOBs, clinical notes, or correspondence.</p>
                    <button className="mt-2 text-sm text-indigo-600 font-medium hover:text-indigo-700">Upload File</button>
                  </div>
                </div>

              </div>
            </>
          );
        })()}
      </div>

    </div>
  );
}
