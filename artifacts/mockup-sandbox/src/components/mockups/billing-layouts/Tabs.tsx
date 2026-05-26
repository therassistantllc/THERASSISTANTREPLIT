import React, { useState } from 'react';
import {
  LayoutDashboard, Users, Calendar, Inbox, DollarSign,
  CheckSquare, MessageSquare, BarChart2, Settings,
  Search, ChevronDown, Phone, RotateCcw,
  CheckCircle2, AlertCircle, FileText, X,
  ArrowRight, CreditCard, XCircle, Clock
} from 'lucide-react';

const GLOBAL_NAV = [
  { icon: LayoutDashboard, label: 'Dashboard' },
  { icon: Users, label: 'Patients' },
  { icon: Calendar, label: 'Schedule' },
  { icon: Inbox, label: 'Mailroom' },
  { icon: DollarSign, label: 'Billing', active: true },
  { icon: CheckSquare, label: 'Tasks' },
  { icon: MessageSquare, label: 'Inbox' },
  { icon: BarChart2, label: 'Reports' },
  { icon: Settings, label: 'Settings' },
];

const BILLING_TABS = [
  { id: 'submitted', label: 'Submitted', count: 156 },
  { id: 'recently_posted', label: 'Recently Posted', count: 18 },
  { id: 'no_response', label: 'No Response', count: 47, active: true },
  { id: 'denials', label: 'Denials', count: 12 },
  { id: 'manual_review', label: 'Manual Review', count: 7 },
  { id: 'patient_resp', label: 'Patient Resp.', count: 23 },
  { id: 'write_offs', label: 'Write-offs', count: 4 },
];

const KPIS = [
  { label: 'Open Claims', value: '47' },
  { label: 'Avg Days Outstanding', value: '38d' },
  { label: 'At-Risk Value', value: '$12,840' },
  { label: 'Recently Posted Today', value: '6' },
];

const MOCK_CLAIMS = [
  { id: 'CLM-20281', patient: 'Sarah Jenkins', dob: '1985-04-12', dos: '2024-02-15', payer: 'Aetna', billed: 185.00, daysOut: 42, status: 'No Response', lastAction: 'Submitted 42d ago', assignee: 'JD', aged: false },
  { id: 'CLM-20282', patient: 'Marcus Chen', dob: '1990-11-23', dos: '2024-01-10', payer: 'BCBS', billed: 210.00, daysOut: 78, status: 'No Response', lastAction: 'Followed up 14d ago', assignee: 'JD', aged: false },
  { id: 'CLM-20283', patient: 'Elena Rodriguez', dob: '1978-08-05', dos: '2023-11-20', payer: 'Cigna', billed: 150.00, daysOut: 95, status: 'No Response', lastAction: 'Submitted 95d ago', assignee: 'AS', aged: true },
  { id: 'CLM-20284', patient: 'James Wilson', dob: '1965-02-18', dos: '2023-11-15', payer: 'UHC', billed: 185.00, daysOut: 102, status: 'No Response', lastAction: 'Called payer 30d ago', assignee: 'JD', aged: true },
  { id: 'CLM-20285', patient: 'Olivia Taylor', dob: '1992-09-30', dos: '2024-02-01', payer: 'Medicare', billed: 125.00, daysOut: 56, status: 'No Response', lastAction: 'Submitted 56d ago', assignee: 'AS', aged: false },
  { id: 'CLM-20286', patient: 'David Miller', dob: '1980-12-14', dos: '2024-02-28', payer: 'Aetna', billed: 185.00, daysOut: 30, status: 'No Response', lastAction: 'Submitted 30d ago', assignee: 'JD', aged: false },
  { id: 'CLM-20287', patient: 'Sophia Anderson', dob: '1988-06-22', dos: '2023-12-05', payer: 'BCBS', billed: 210.00, daysOut: 85, status: 'No Response', lastAction: 'Followed up 21d ago', assignee: 'AS', aged: false },
  { id: 'CLM-20288', patient: 'Lucas Thomas', dob: '1975-03-08', dos: '2023-10-10', payer: 'Cigna', billed: 150.00, daysOut: 110, status: 'No Response', lastAction: 'Submitted 110d ago', assignee: 'JD', aged: true },
];

export default function TabsLayout() {
  const [selectedClaim, setSelectedClaim] = useState<typeof MOCK_CLAIMS[0] | null>(MOCK_CLAIMS[2]);

  return (
    <div className="flex h-screen w-full bg-[#f8fafc] text-slate-900 font-sans overflow-hidden">
      
      {/* GLOBAL SIDEBAR */}
      <div className="w-16 bg-[#0f172a] text-slate-400 flex flex-col items-center py-4 flex-shrink-0 z-20 shadow-xl">
        <div className="w-8 h-8 bg-blue-500 rounded-md mb-8 shadow-[0_0_15px_rgba(59,130,246,0.5)]"></div>
        <div className="flex flex-col gap-4 w-full">
          {GLOBAL_NAV.map((nav, i) => (
            <div 
              key={i} 
              className={`w-full flex justify-center py-3 cursor-pointer transition-colors relative group
                ${nav.active ? 'text-white' : 'hover:text-slate-200'}`}
              title={nav.label}
            >
              {nav.active && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500 rounded-r-md"></div>}
              <nav.icon size={20} className={nav.active ? 'drop-shadow-[0_0_8px_rgba(255,255,255,0.4)]' : ''} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* TOP TAB BAR (Pipeline) */}
        <div className="bg-white border-b border-slate-200 px-6 pt-4 pb-0 flex flex-col flex-shrink-0 z-10">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-semibold text-slate-800 tracking-tight">Billing</h1>
            <div className="flex gap-2">
              <button className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 transition-colors">
                Export
              </button>
            </div>
          </div>
          
          <div className="flex overflow-x-auto no-scrollbar gap-1 pb-px">
            {BILLING_TABS.map((tab, i) => (
              <div key={tab.id} className="flex items-center">
                <button
                  className={`
                    relative px-4 py-2.5 text-sm font-medium rounded-t-lg border-t border-x transition-all
                    flex items-center gap-2 whitespace-nowrap
                    ${tab.active 
                      ? 'bg-slate-50 border-slate-200 text-blue-700 pb-[11px] -mb-px z-10' 
                      : 'bg-white border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50/50'}
                  `}
                >
                  {tab.label}
                  <span className={`
                    px-1.5 py-0.5 rounded-full text-xs font-bold
                    ${tab.active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}
                  `}>
                    {tab.count}
                  </span>
                  {tab.active && (
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t-lg"></div>
                  )}
                </button>
                {i < BILLING_TABS.length - 1 && (
                  <ChevronDown size={14} className="mx-1 text-slate-300 -rotate-90 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden bg-slate-50 relative">
          
          {/* MAIN QUEUE CONTENT */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden border-r border-slate-200">
            {/* KPI ROW */}
            <div className="grid grid-cols-4 gap-4 p-6 flex-shrink-0">
              {KPIS.map((kpi, i) => (
                <div key={i} className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
                  <div className="text-slate-500 text-xs font-medium uppercase tracking-wider mb-1">{kpi.label}</div>
                  <div className="text-2xl font-bold text-slate-800">{kpi.value}</div>
                </div>
              ))}
            </div>

            {/* FILTER BAR */}
            <div className="px-6 pb-4 flex flex-shrink-0 items-center justify-between gap-4">
              <div className="flex items-center gap-2 flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input 
                    type="text" 
                    placeholder="Search claims..." 
                    className="pl-9 pr-4 py-2 border border-slate-300 rounded text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm"
                  />
                </div>
                
                <button className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded text-sm font-medium bg-white hover:bg-slate-50 shadow-sm text-slate-700">
                  Payer: All
                  <ChevronDown size={14} className="text-slate-400" />
                </button>
                
                <div className="flex items-center bg-white border border-slate-300 rounded shadow-sm text-sm font-medium p-0.5">
                  {['0–30', '31–60', '61–90', '90+'].map(bucket => (
                    <button key={bucket} className={`px-3 py-1.5 rounded-sm ${bucket === '90+' ? 'bg-rose-50 text-rose-700' : 'text-slate-600 hover:bg-slate-50'}`}>
                      {bucket}
                    </button>
                  ))}
                </div>
              </div>
              
              <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium shadow-sm flex items-center gap-2 transition-colors">
                <CheckSquare size={16} />
                Bulk Follow-up
              </button>
            </div>

            {/* TABLE */}
            <div className="flex-1 overflow-auto px-6 pb-6">
              <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden flex flex-col min-h-0 h-full">
                <table className="w-full text-left border-collapse text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase text-xs font-semibold sticky top-0 z-10">
                    <tr>
                      <th className="py-3 px-4 w-10"><input type="checkbox" className="rounded border-slate-300" /></th>
                      <th className="py-3 px-4">Patient</th>
                      <th className="py-3 px-4">Claim #</th>
                      <th className="py-3 px-4">DOS</th>
                      <th className="py-3 px-4">Payer</th>
                      <th className="py-3 px-4 text-right">Billed</th>
                      <th className="py-3 px-4 text-center">Days Out</th>
                      <th className="py-3 px-4">Last Action</th>
                      <th className="py-3 px-4 text-center">Owner</th>
                      <th className="py-3 px-4"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 overflow-y-auto">
                    {MOCK_CLAIMS.map((claim) => (
                      <tr 
                        key={claim.id} 
                        onClick={() => setSelectedClaim(claim)}
                        className={`
                          group cursor-pointer transition-colors
                          ${selectedClaim?.id === claim.id ? 'bg-blue-50/60' : 'hover:bg-slate-50'}
                          ${claim.aged && selectedClaim?.id !== claim.id ? 'bg-rose-50/30' : ''}
                        `}
                      >
                        <td className="py-3 px-4 border-l-2 border-transparent" style={{ borderLeftColor: selectedClaim?.id === claim.id ? '#3b82f6' : (claim.aged ? '#fda4af' : 'transparent') }}>
                          <input type="checkbox" className="rounded border-slate-300" onClick={e => e.stopPropagation()} />
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-800">{claim.patient}</div>
                          <div className="text-xs text-slate-500">DOB: {claim.dob}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600">{claim.id}</td>
                        <td className="py-3 px-4 text-slate-600">{claim.dos}</td>
                        <td className="py-3 px-4 text-slate-800">{claim.payer}</td>
                        <td className="py-3 px-4 text-right font-medium">${claim.billed.toFixed(2)}</td>
                        <td className="py-3 px-4 text-center">
                          <span className={`inline-flex px-2 py-1 rounded text-xs font-bold ${claim.aged ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>
                            {claim.daysOut}d
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-500 text-xs">{claim.lastAction}</td>
                        <td className="py-3 px-4 text-center">
                          <div className="w-6 h-6 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-[10px] font-bold mx-auto">
                            {claim.assignee}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Call Payer">
                              <Phone size={14} />
                            </button>
                            <button className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Resubmit">
                              <RotateCcw size={14} />
                            </button>
                            <button className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded" title="Mark Followed Up">
                              <CheckCircle2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* RIGHT DETAIL PANE */}
          {selectedClaim ? (
            <div className="w-[480px] bg-white flex flex-col flex-shrink-0 shadow-[-4px_0_15px_rgba(0,0,0,0.03)] z-20 border-l border-slate-200">
              {/* Detail Header */}
              <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/50">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">{selectedClaim.patient}</h2>
                    <div className="flex items-center gap-2 text-sm text-slate-500 mt-1">
                      <span className="font-mono">{selectedClaim.id}</span>
                      <span>•</span>
                      <span>DOS: {selectedClaim.dos}</span>
                    </div>
                  </div>
                  <button onClick={() => setSelectedClaim(null)} className="text-slate-400 hover:text-slate-600">
                    <X size={20} />
                  </button>
                </div>
                
                <div className="flex flex-wrap gap-2 mt-4">
                  <div className="bg-white border border-slate-200 px-3 py-1.5 rounded text-sm flex items-center gap-2 shadow-sm">
                    <span className="text-slate-500">Payer:</span>
                    <span className="font-semibold text-slate-800">{selectedClaim.payer}</span>
                  </div>
                  <div className="bg-white border border-slate-200 px-3 py-1.5 rounded text-sm flex items-center gap-2 shadow-sm">
                    <span className="text-slate-500">Billed:</span>
                    <span className="font-semibold text-slate-800">${selectedClaim.billed.toFixed(2)}</span>
                  </div>
                  <div className={`border px-3 py-1.5 rounded text-sm flex items-center gap-2 shadow-sm font-medium
                    ${selectedClaim.aged ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-white border-slate-200 text-slate-700'}
                  `}>
                    <Clock size={14} className={selectedClaim.aged ? 'text-rose-500' : 'text-slate-400'} />
                    {selectedClaim.daysOut} Days Out
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                
                {/* Timeline */}
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2">
                    <ActivityIcon />
                    Claim Timeline
                  </h3>
                  
                  <div className="relative border-l-2 border-slate-200 ml-3 space-y-6 pb-2">
                    <div className="relative pl-6">
                      <div className="absolute w-3 h-3 bg-blue-500 rounded-full -left-[7px] top-1 ring-4 ring-white"></div>
                      <div className="text-sm font-medium text-slate-800">Awaiting payer response</div>
                      <div className="text-xs text-slate-500 mt-0.5">Current Status</div>
                    </div>
                    
                    <div className="relative pl-6">
                      <div className="absolute w-3 h-3 bg-slate-300 rounded-full -left-[7px] top-1 ring-4 ring-white"></div>
                      <div className="text-sm font-medium text-slate-700">Followed up</div>
                      <div className="text-xs text-slate-500 mt-0.5">14 days ago by Jane Doe</div>
                      <div className="mt-2 text-sm bg-slate-50 border border-slate-200 rounded p-3 text-slate-600">
                        Called Aetna rep. Claim is in process, no additional info needed at this time. Expected resolution in 10-14 days.
                      </div>
                    </div>
                    
                    <div className="relative pl-6">
                      <div className="absolute w-3 h-3 bg-slate-300 rounded-full -left-[7px] top-1 ring-4 ring-white"></div>
                      <div className="text-sm font-medium text-slate-700">Submitted via Clearinghouse</div>
                      <div className="text-xs text-slate-500 mt-0.5">42 days ago</div>
                    </div>
                  </div>
                </div>

                {/* Attachments */}
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <FileText size={16} className="text-slate-400" />
                    Attachments
                  </h3>
                  <div className="bg-slate-50 border border-slate-200 border-dashed rounded-lg p-4 flex flex-col items-center justify-center text-center">
                    <FileText size={24} className="text-slate-300 mb-2" />
                    <div className="text-sm text-slate-600 font-medium">No EOBs attached</div>
                    <div className="text-xs text-slate-400 mt-1">Upload files or link from mailroom</div>
                    <button className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700">Browse Files</button>
                  </div>
                </div>

              </div>

              {/* Action Footer */}
              <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col gap-2">
                <button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded shadow-sm flex justify-center items-center gap-2 transition-colors">
                  <Phone size={16} />
                  Log Call Outcome
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button className="w-full bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-medium py-2 rounded shadow-sm flex justify-center items-center gap-2 text-sm transition-colors">
                    <RotateCcw size={14} />
                    Resubmit
                  </button>
                  <button className="w-full bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-medium py-2 rounded shadow-sm flex justify-center items-center gap-2 text-sm transition-colors text-rose-600 hover:text-rose-700 border-rose-200 hover:border-rose-300">
                    <XCircle size={14} />
                    Write Off
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="w-[480px] bg-slate-50/50 flex flex-col items-center justify-center flex-shrink-0 z-20 border-l border-slate-200 p-8 text-center">
              <div className="w-16 h-16 bg-white rounded-full shadow-sm flex items-center justify-center mb-4 border border-slate-200">
                <AlertCircle size={24} className="text-slate-300" />
              </div>
              <h3 className="text-lg font-medium text-slate-800 mb-2">No Claim Selected</h3>
              <p className="text-sm text-slate-500 max-w-[280px]">
                Select a claim from the queue to view its timeline, attachments, and take action.
              </p>
            </div>
          )}
          
        </div>
      </div>
    </div>
  );
}

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
