import React, { useState } from "react";
import { 
  Search, Filter, Calendar, ChevronDown, CheckSquare, MoreHorizontal, 
  Printer, Save, Send, AlertCircle, X, ChevronUp, Clock, FileText, AlertTriangle, PlayCircle
} from "lucide-react";

type ChargeStatus = "ready" | "unsigned" | "missing_dx" | "hold" | "released";

interface ChargeRow {
  id: string;
  patient: string;
  dob: string;
  age: string;
  acct: string;
  dos: string;
  cpt: string;
  provider: string;
  npi: string;
  insurance: string;
  plan: string;
  memberId: string;
  type: string;
  charge: number;
  status: ChargeStatus;
  blockers: string[];
}

const CHARGES: ChargeRow[] = [
  {
    id: "CHG-1001",
    patient: "Reyes, Marisol",
    dob: "1985-04-12",
    age: "38",
    acct: "PT-8832",
    dos: "2023-10-24",
    cpt: "90837",
    provider: "Dr. Sarah Jenkins",
    npi: "1928374650",
    insurance: "Aetna",
    plan: "Aetna Choice POS II",
    memberId: "W123456789",
    type: "Commercial",
    charge: 150.0,
    status: "ready",
    blockers: [],
  },
  {
    id: "CHG-1002",
    patient: "Chen, David",
    dob: "1990-11-05",
    age: "33",
    acct: "PT-9941",
    dos: "2023-10-24",
    cpt: "90834",
    provider: "Dr. Sarah Jenkins",
    npi: "1928374650",
    insurance: "BCBS",
    plan: "BlueCard PPO",
    memberId: "XYZ987654321",
    type: "Commercial",
    charge: 120.0,
    status: "unsigned",
    blockers: ["Provider signature missing"],
  },
  {
    id: "CHG-1003",
    patient: "Smith, James",
    dob: "1972-02-18",
    age: "51",
    acct: "PT-2210",
    dos: "2023-10-23",
    cpt: "90791",
    provider: "Dr. Robert Clark",
    npi: "1548293041",
    insurance: "Medicare",
    plan: "Medicare Part B",
    memberId: "1EG4TE5MK73",
    type: "Medicare",
    charge: 200.0,
    status: "missing_dx",
    blockers: ["Missing primary diagnosis"],
  },
  {
    id: "CHG-1004",
    patient: "Johnson, Emily",
    dob: "2001-08-30",
    age: "22",
    acct: "PT-4456",
    dos: "2023-10-23",
    cpt: "90837",
    provider: "Dr. Sarah Jenkins",
    npi: "1928374650",
    insurance: "Cigna",
    plan: "Cigna Open Access",
    memberId: "U99887766",
    type: "Commercial",
    charge: 150.0,
    status: "hold",
    blockers: ["Credentialing pending with payer"],
  },
  {
    id: "CHG-1005",
    patient: "Williams, Michael",
    dob: "1965-12-10",
    age: "58",
    acct: "PT-1122",
    dos: "2023-10-22",
    cpt: "90834",
    provider: "Dr. Robert Clark",
    npi: "1548293041",
    insurance: "Aetna",
    plan: "Aetna Select",
    memberId: "W987654321",
    type: "Commercial",
    charge: 120.0,
    status: "released",
    blockers: [],
  },
  {
    id: "CHG-1006",
    patient: "Brown, Jessica",
    dob: "1995-03-25",
    age: "28",
    acct: "PT-3344",
    dos: "2023-10-22",
    cpt: "90837",
    provider: "Dr. Sarah Jenkins",
    npi: "1928374650",
    insurance: "BCBS",
    plan: "BlueCard PPO",
    memberId: "XYZ123456789",
    type: "Commercial",
    charge: 150.0,
    status: "ready",
    blockers: [],
  },
];

const STATUS_CONFIG: Record<ChargeStatus, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  ready: { label: "Ready", color: "text-emerald-700", bg: "bg-emerald-50", icon: <CheckSquare className="w-3 h-3 mr-1" /> },
  unsigned: { label: "Unsigned", color: "text-amber-700", bg: "bg-amber-50", icon: <Clock className="w-3 h-3 mr-1" /> },
  missing_dx: { label: "Missing DX", color: "text-red-700", bg: "bg-red-50", icon: <AlertCircle className="w-3 h-3 mr-1" /> },
  hold: { label: "Hold", color: "text-slate-700", bg: "bg-slate-100", icon: <AlertTriangle className="w-3 h-3 mr-1" /> },
  released: { label: "Released", color: "text-blue-700", bg: "bg-blue-50", icon: <PlayCircle className="w-3 h-3 mr-1" /> },
};

export function WorklistTable() {
  const [selectedId, setSelectedId] = useState<string | null>("CHG-1001");
  const selectedCharge = CHARGES.find(c => c.id === selectedId);

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {/* Header & Toolbar */}
      <div className="bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-slate-900">Charges</h1>
            <div className="h-6 w-px bg-slate-200"></div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Queue Status</span>
              <div className="flex gap-1">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">All (6)</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">Ready (2)</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">Unsigned (1)</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">Action Needed (2)</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search patient, CPT..." 
                className="pl-9 pr-4 py-1.5 w-64 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400"
              />
            </div>
            <button className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors">
              <Filter className="w-4 h-4" />
              Filter
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors">
              <Calendar className="w-4 h-4" />
              This Week
            </button>
            <div className="h-6 w-px bg-slate-200 ml-2"></div>
            <button className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors shadow-sm">
              <CheckSquare className="w-4 h-4" />
              Release Ready (2)
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        
        {/* Top: Worklist Table */}
        <div className={`flex-1 overflow-auto bg-white transition-all duration-300 ${selectedId ? 'border-b border-slate-300 shadow-sm z-10' : ''}`}>
          <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-20 text-xs font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3 w-10 text-center"><input type="checkbox" className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer" /></th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">Patient</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">DOB</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">DOS</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">CPT</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">Provider</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">Payer</th>
                <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-100 transition-colors">Charge</th>
                <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">Status</th>
                <th className="px-6 py-3">Blockers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {CHARGES.map((row) => (
                <tr 
                  key={row.id} 
                  onClick={() => setSelectedId(row.id)}
                  className={`cursor-pointer transition-colors hover:bg-slate-50 group ${selectedId === row.id ? 'bg-blue-50/50 hover:bg-blue-50/80 border-l-2 border-l-blue-600' : 'border-l-2 border-l-transparent'}`}
                >
                  <td className="px-6 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{row.patient}</div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">{row.acct}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.dob}</td>
                  <td className="px-4 py-3 text-slate-900 font-medium">{row.dos}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded font-mono text-xs bg-slate-100 text-slate-700 border border-slate-200">
                      {row.cpt}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.provider}</td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{row.insurance}</div>
                    <div className="text-xs text-slate-500 truncate max-w-[120px]">{row.plan}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">${row.charge.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${STATUS_CONFIG[row.status].bg} ${STATUS_CONFIG[row.status].color}`}>
                      {STATUS_CONFIG[row.status].icon}
                      {STATUS_CONFIG[row.status].label}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    {row.blockers.length > 0 ? (
                      <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-100 px-2 py-1 rounded w-fit max-w-[200px]">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{row.blockers[0]}</span>
                        {row.blockers.length > 1 && <span className="font-semibold shrink-0">+{row.blockers.length - 1}</span>}
                      </div>
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Bottom: Detail Drawer/Panel */}
        {selectedCharge && (
          <div className="h-[55%] flex flex-col bg-slate-100 border-t border-slate-300 relative z-20 shrink-0">
            {/* Detail Header & Action Bar */}
            <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-sm z-10">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  {selectedCharge.patient}
                </h2>
                <div className="h-5 w-px bg-slate-300"></div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-slate-500">DOS: <span className="font-medium text-slate-900">{selectedCharge.dos}</span></span>
                  <span className="text-slate-500">Acct: <span className="font-medium text-slate-900 font-mono">{selectedCharge.acct}</span></span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_CONFIG[selectedCharge.status].bg} ${STATUS_CONFIG[selectedCharge.status].color}`}>
                    {STATUS_CONFIG[selectedCharge.status].label}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 italic mr-2">* required field</span>
                <button className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Refresh">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                </button>
                <button className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors" title="Print Superbill">
                  <Printer className="w-4 h-4" />
                </button>
                <div className="h-5 w-px bg-slate-200 mx-1"></div>
                <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition-colors">
                  <Save className="w-4 h-4" />
                  Save
                </button>
                <button 
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white rounded shadow-sm transition-colors ${
                    selectedCharge.status === 'ready' 
                      ? 'bg-blue-600 hover:bg-blue-700' 
                      : 'bg-blue-400 cursor-not-allowed'
                  }`}
                  disabled={selectedCharge.status !== 'ready'}
                >
                  <Send className="w-4 h-4" />
                  Release to Billing
                </button>
                <button onClick={() => setSelectedId(null)} className="ml-2 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors" title="Close Drawer">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Detail Content */}
            <div className="flex-1 overflow-auto p-6">
              <div className="max-w-[1400px] mx-auto space-y-6">
                
                {/* Blockers Alert */}
                {selectedCharge.blockers.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-md p-4 flex gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-bold text-red-800">Action Required</h4>
                      <ul className="mt-1 space-y-1 text-sm text-red-700 list-disc list-inside ml-1">
                        {selectedCharge.blockers.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-12 gap-6">
                  {/* Left Column: Patient & Case (4 cols) */}
                  <div className="col-span-4 space-y-6">
                    {/* Patient Card */}
                    <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Patient Information</h3>
                      </div>
                      <div className="p-4 grid grid-cols-2 gap-4">
                        <div className="col-span-2">
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Patient Name</label>
                          <div className="text-sm font-medium text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.patient}</div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">DOB</label>
                          <div className="text-sm text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.dob}</div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Age</label>
                          <div className="text-sm text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.age}</div>
                        </div>
                      </div>
                    </div>

                    {/* Case Card */}
                    <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Case Information</h3>
                      </div>
                      <div className="p-4 space-y-4">
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Primary Payer</label>
                          <div className="text-sm font-medium text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.insurance}</div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Plan</label>
                          <div className="text-sm text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200 truncate">{selectedCharge.plan}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Member ID</label>
                            <div className="text-sm font-mono text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.memberId}</div>
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Type</label>
                            <div className="text-sm text-slate-900 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">{selectedCharge.type}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Diagnoses & Procedures & Additional (8 cols) */}
                  <div className="col-span-8 space-y-6">
                    {/* Diagnoses */}
                    <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Diagnosis (ICD-10)</h3>
                      </div>
                      <div className="p-4 grid grid-cols-4 gap-4">
                        {['D1*', 'D2', 'D3', 'D4'].map((label, i) => (
                          <div key={label}>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">{label}</label>
                            <input 
                              type="text" 
                              defaultValue={i === 0 ? "F41.1" : i === 1 ? "F33.1" : ""} 
                              className="w-full text-sm font-mono px-3 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none uppercase"
                              placeholder="---"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Procedure Lines Table */}
                    <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex justify-between items-center">
                        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Procedure Lines</h3>
                        <button className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors">+ Add Line</button>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs text-left whitespace-nowrap">
                          <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                            <tr>
                              <th className="px-3 py-2">Proc*</th>
                              <th className="px-3 py-2">DOS From*</th>
                              <th className="px-3 py-2">DOS To*</th>
                              <th className="px-3 py-2 text-center" title="Diagnosis Pointer">DX Ptr</th>
                              <th className="px-2 py-2 w-10 text-center" title="Modifier 1">M1</th>
                              <th className="px-2 py-2 w-10 text-center" title="Modifier 2">M2</th>
                              <th className="px-2 py-2 w-10 text-center" title="Modifier 3">M3</th>
                              <th className="px-2 py-2 w-10 text-center" title="Modifier 4">M4</th>
                              <th className="px-3 py-2 text-right">Units*</th>
                              <th className="px-3 py-2">UOM*</th>
                              <th className="px-3 py-2 text-right">Charge*</th>
                              <th className="px-3 py-2 text-right">Total</th>
                              <th className="px-3 py-2 w-16">POS</th>
                              <th className="px-3 py-2">Auth #</th>
                              <th className="px-2 py-2"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            <tr>
                              <td className="px-2 py-2"><input type="text" defaultValue={selectedCharge.cpt} className="w-16 font-mono px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2"><input type="date" defaultValue={selectedCharge.dos} className="w-[105px] px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2"><input type="date" defaultValue={selectedCharge.dos} className="w-[105px] px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2"><input type="text" defaultValue="1" className="w-10 text-center px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-1 py-2"><input type="text" className="w-8 text-center px-1 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none uppercase" /></td>
                              <td className="px-1 py-2"><input type="text" className="w-8 text-center px-1 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none uppercase" /></td>
                              <td className="px-1 py-2"><input type="text" className="w-8 text-center px-1 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none uppercase" /></td>
                              <td className="px-1 py-2"><input type="text" className="w-8 text-center px-1 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none uppercase" /></td>
                              <td className="px-2 py-2"><input type="number" defaultValue="1" min="1" className="w-12 text-right px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2">
                                <select className="w-12 bg-transparent px-1 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none">
                                  <option>UN</option>
                                  <option>MJ</option>
                                </select>
                              </td>
                              <td className="px-2 py-2"><input type="text" defaultValue={selectedCharge.charge.toFixed(2)} className="w-16 text-right px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-3 py-2 text-right font-medium text-slate-900">${selectedCharge.charge.toFixed(2)}</td>
                              <td className="px-2 py-2"><input type="text" defaultValue="11" className="w-10 px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2"><input type="text" className="w-20 px-2 py-1 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none" /></td>
                              <td className="px-2 py-2 text-center">
                                <button className="text-red-500 hover:text-red-700 transition-colors p-1" title="Remove line"><X className="w-3.5 h-3.5" /></button>
                              </td>
                            </tr>
                          </tbody>
                          <tfoot className="bg-slate-50 border-t border-slate-200">
                            <tr>
                              <td colSpan={11} className="px-3 py-2 text-right font-semibold text-slate-600">Total Charge:</td>
                              <td className="px-3 py-2 text-right font-bold text-slate-900">${selectedCharge.charge.toFixed(2)}</td>
                              <td colSpan={3}></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>

                    {/* Bottom Split: Additional Info & Payments */}
                    <div className="grid grid-cols-2 gap-6">
                      <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                        <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Additional Information</h3>
                        </div>
                        <div className="p-4 space-y-4">
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Rendering Provider</label>
                            <select className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none bg-white">
                              <option>{selectedCharge.provider}</option>
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">NPI</label>
                              <input type="text" defaultValue={selectedCharge.npi} className="w-full text-sm font-mono px-3 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none bg-slate-50" readOnly />
                            </div>
                            <div>
                              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Place of Service (Default)</label>
                              <select className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none bg-white">
                                <option value="11">11 - Office</option>
                                <option value="02">02 - Telehealth</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-white border border-slate-200 rounded-md shadow-sm overflow-hidden">
                        <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Patient Payments</h3>
                        </div>
                        <div className="p-4 grid grid-cols-3 gap-4">
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Co-Pay</label>
                            <div className="relative">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                              <input type="text" defaultValue="25.00" className="w-full text-sm text-right px-3 pl-6 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none" />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Deductible</label>
                            <div className="relative">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                              <input type="text" defaultValue="0.00" className="w-full text-sm text-right px-3 pl-6 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none" />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Co-Ins %</label>
                            <div className="relative">
                              <input type="text" defaultValue="0" className="w-full text-sm text-right px-3 pr-6 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 outline-none" />
                              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm">%</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
