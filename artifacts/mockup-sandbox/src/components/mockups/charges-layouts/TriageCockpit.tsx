import React, { useState } from 'react';
import { 
  Search, AlertCircle, RefreshCw, Printer, Save, Send, 
  FileText, CheckCircle2, Clock, AlertTriangle, 
  Lock, ArrowRightCircle, User, Calendar, CreditCard, ShieldAlert,
  Plus
} from 'lucide-react';

type ChargeStatus = "unsigned" | "missing_dx" | "hold" | "ready" | "released";

interface Charge {
  id: string;
  client: string;
  dob: string;
  age: number;
  accountNo: string;
  charge: number;
  status: ChargeStatus;
  cpt: string;
  dos: string;
  primaryPayer: string;
  plan: string;
  memberId: string;
  payerType: string;
  diagnoses: string[];
  renderingProvider: string;
  npi: string;
  pos: string;
  copay: number;
  deductible: number;
  coinsurance: number;
  blockers: string[];
}

const CHARGES: Charge[] = [
  {
    id: "CHG-101", client: "Chen, David", dob: "1985-04-12", age: 38, accountNo: "ACC-8821",
    charge: 150.00, status: "unsigned", cpt: "90837", dos: "10/24/2023",
    primaryPayer: "Aetna", plan: "Choice POS II", memberId: "W11928374", payerType: "Commercial",
    diagnoses: ["F41.1"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "11 - Office",
    copay: 20, deductible: 0, coinsurance: 0, blockers: []
  },
  {
    id: "CHG-102", client: "Smith, Robert", dob: "1990-11-05", age: 33, accountNo: "ACC-9102",
    charge: 120.00, status: "unsigned", cpt: "90834", dos: "10/24/2023",
    primaryPayer: "BCBS", plan: "BlueCard PPO", memberId: "XEA123456789", payerType: "Commercial",
    diagnoses: ["F32.1"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "11 - Office",
    copay: 0, deductible: 50, coinsurance: 20, blockers: []
  },
  {
    id: "CHG-103", client: "Reyes, Marisol", dob: "1992-08-17", age: 31, accountNo: "ACC-7734",
    charge: 150.00, status: "missing_dx", cpt: "90837", dos: "10/23/2023",
    primaryPayer: "Cigna", plan: "Open Access Plus", memberId: "U99283746", payerType: "Commercial",
    diagnoses: [], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "02 - Telehealth",
    copay: 15, deductible: 0, coinsurance: 0, blockers: ["Missing Primary Diagnosis"]
  },
  {
    id: "CHG-104", client: "Washington, James", dob: "1978-02-22", age: 45, accountNo: "ACC-4412",
    charge: 250.00, status: "hold", cpt: "90791", dos: "10/22/2023",
    primaryPayer: "Medicare", plan: "Part B", memberId: "1EG4TE5MK73", payerType: "Medicare",
    diagnoses: ["F43.20", "F41.9"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "11 - Office",
    copay: 0, deductible: 0, coinsurance: 20, blockers: ["Awaiting credentialing approval for POS 11"]
  },
  {
    id: "CHG-105", client: "Nguyen, Emily", dob: "2001-05-30", age: 22, accountNo: "ACC-5521",
    charge: 150.00, status: "ready", cpt: "90837", dos: "10/21/2023",
    primaryPayer: "Aetna", plan: "Student Health", memberId: "W88273645", payerType: "Commercial",
    diagnoses: ["F41.1", "F33.1"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "11 - Office",
    copay: 25, deductible: 0, coinsurance: 0, blockers: []
  },
  {
    id: "CHG-106", client: "Johnson, Michael", dob: "1988-09-14", age: 35, accountNo: "ACC-2291",
    charge: 120.00, status: "ready", cpt: "90834", dos: "10/21/2023",
    primaryPayer: "UHC", plan: "Choice Plus", memberId: "991827364", payerType: "Commercial",
    diagnoses: ["F90.0"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "02 - Telehealth",
    copay: 10, deductible: 0, coinsurance: 0, blockers: []
  },
  {
    id: "CHG-107", client: "Patel, Anh", dob: "1995-12-01", age: 28, accountNo: "ACC-3310",
    charge: 150.00, status: "released", cpt: "90837", dos: "10/20/2023",
    primaryPayer: "BCBS", plan: "BlueOptions", memberId: "XEB987654321", payerType: "Commercial",
    diagnoses: ["F41.1"], renderingProvider: "Dr. Sarah Jenkins", npi: "1092837465", pos: "11 - Office",
    copay: 20, deductible: 0, coinsurance: 0, blockers: []
  }
];

const COLUMNS: { id: ChargeStatus; title: string; icon: React.FC<any>; color: string; bg: string; border: string; text: string }[] = [
  { id: "unsigned", title: "Unsigned", icon: Clock, color: "text-amber-600", bg: "bg-amber-50/50", border: "border-amber-200/60", text: "text-amber-800" },
  { id: "missing_dx", title: "Missing Dx", icon: AlertTriangle, color: "text-red-600", bg: "bg-red-50/50", border: "border-red-200/60", text: "text-red-800" },
  { id: "hold", title: "Hold", icon: Lock, color: "text-slate-500", bg: "bg-slate-100/50", border: "border-slate-200", text: "text-slate-700" },
  { id: "ready", title: "Ready", icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50/50", border: "border-emerald-200/60", text: "text-emerald-800" },
  { id: "released", title: "Released", icon: ArrowRightCircle, color: "text-blue-600", bg: "bg-blue-50/50", border: "border-blue-200/60", text: "text-blue-800" },
];

export function TriageCockpit() {
  const [selectedChargeId, setSelectedId] = useState<string>("CHG-103");
  const [searchQuery, setSearchQuery] = useState("");

  const selectedCharge = CHARGES.find(c => c.id === selectedChargeId) || CHARGES[2];

  const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);

  return (
    <div className="w-[1920px] h-[1080px] flex flex-col bg-slate-50 font-sans text-slate-900 overflow-hidden">
      
      {/* --- Top Header --- */}
      <header className="h-16 px-6 bg-slate-900 text-slate-100 border-b border-slate-800 flex items-center justify-between shrink-0 shadow-sm z-20">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-8 h-8 rounded bg-indigo-500 text-white font-bold text-lg">
            T
          </div>
          <h1 className="text-xl font-bold text-white">Charges</h1>
          <span className="text-slate-500">|</span>
          <span className="text-sm font-medium text-slate-300">Pipeline Triage</span>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search by client or CPT..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 w-72 rounded bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 focus:bg-slate-900 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 text-sm transition-all"
            />
          </div>
          <div className="flex items-center gap-3 border-l border-slate-700 pl-6">
            <div className="text-right">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Pipeline</div>
              <div className="text-sm font-bold text-white">{formatCurrency(1090.00)}</div>
            </div>
          </div>
        </div>
      </header>

      {/* --- Main Content Area: Split Top/Bottom --- */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        
        {/* UPPER: Kanban Pipeline (Fixed Height) */}
        <div className="h-[380px] shrink-0 overflow-x-auto overflow-y-hidden bg-slate-100 border-b border-slate-300 shadow-inner p-4 flex gap-4">
          {COLUMNS.map(col => {
            const columnCharges = CHARGES.filter(c => c.status === col.id);
            const columnTotal = columnCharges.reduce((sum, c) => sum + c.charge, 0);
            
            return (
              <div key={col.id} className={`flex-1 min-w-[300px] max-w-[360px] flex flex-col rounded-md border ${col.border} bg-white overflow-hidden shadow-sm`}>
                {/* Column Header */}
                <div className={`px-4 py-2.5 border-b border-slate-200/50 ${col.bg} flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    <col.icon className={`w-4 h-4 ${col.color}`} />
                    <h2 className={`font-semibold text-sm ${col.text}`}>{col.title}</h2>
                    <span className="px-2 py-0.5 rounded-full bg-white/60 text-xs font-medium border border-white/40 text-slate-700">
                      {columnCharges.length}
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-600">{formatCurrency(columnTotal)}</span>
                </div>
                
                {/* Column Cards */}
                <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2.5 bg-slate-50/50">
                  {columnCharges.map(charge => {
                    const isSelected = charge.id === selectedChargeId;
                    return (
                      <button
                        key={charge.id}
                        onClick={() => setSelectedId(charge.id)}
                        className={`text-left w-full relative bg-white rounded-md p-3 transition-all duration-150 group ${
                          isSelected 
                            ? 'ring-2 ring-indigo-500 shadow-md' 
                            : 'border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-1.5">
                          <div>
                            <div className="font-bold text-slate-900 text-[13px]">{charge.client}</div>
                            <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                              {charge.dos} <span className="mx-0.5">•</span> CPT {charge.cpt}
                            </div>
                          </div>
                          <div className="font-bold text-slate-700 text-[13px]">{formatCurrency(charge.charge)}</div>
                        </div>
                        {charge.blockers.length > 0 && (
                          <div className="mt-2 flex items-center text-[11px] text-red-600 font-semibold bg-red-50 border border-red-100 rounded px-1.5 py-0.5 w-fit">
                            <AlertCircle className="w-3 h-3 mr-1" />
                            {charge.blockers.length} Blocker{charge.blockers.length > 1 ? 's' : ''}
                          </div>
                        )}
                      </button>
                    )
                  })}
                  {columnCharges.length === 0 && (
                    <div className="h-24 flex items-center justify-center text-sm text-slate-400 font-medium border border-dashed border-slate-200 rounded-md m-1">
                      Empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* LOWER: Editor Workspace */}
        <div className="flex-1 flex flex-col bg-white z-20 relative shadow-[0_-4px_12px_rgba(0,0,0,0.03)]">
          
          {/* Workspace Header / Client Bar */}
          <div className="h-[52px] px-6 border-b border-slate-200 bg-slate-50 flex items-center gap-8 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
              <span className="text-[11px] font-bold uppercase tracking-widest text-indigo-600">Now Editing</span>
            </div>
            
            <div className="h-5 w-px bg-slate-300"></div>
            
            <div className="flex items-center gap-6 flex-1 text-sm">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-slate-400" />
                <span className="font-bold text-slate-900 text-[15px]">{selectedCharge.client}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs uppercase font-bold text-slate-400">DOB</span>
                <span className="text-slate-800 font-medium text-[13px]">{selectedCharge.dob} <span className="text-slate-400">({selectedCharge.age})</span></span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs uppercase font-bold text-slate-400">Acct #</span>
                <span className="text-slate-800 font-medium font-mono text-[13px]">{selectedCharge.accountNo}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs uppercase font-bold text-slate-400">Service Date</span>
                <span className="text-slate-800 font-medium text-[13px]">{selectedCharge.dos}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px] uppercase font-bold text-slate-400">Status</span>
                <span className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border
                  ${selectedCharge.status === 'ready' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 
                    selectedCharge.status === 'missing_dx' ? 'text-red-700 bg-red-50 border-red-200' : 
                    selectedCharge.status === 'unsigned' ? 'text-amber-700 bg-amber-50 border-amber-200' : 
                    selectedCharge.status === 'released' ? 'text-blue-700 bg-blue-50 border-blue-200' : 
                    'text-slate-700 bg-slate-100 border-slate-200'}`}
                >
                  {selectedCharge.status.replace('_', ' ')}
                </span>
              </div>
            </div>
          </div>

          {/* Workspace Grid */}
          <div className="flex-1 overflow-y-auto p-6 bg-white">
            <div className="grid grid-cols-[400px_1fr] gap-6 h-full max-w-[1700px] mx-auto items-start">
              
              {/* LEFT COLUMN: Nesting smaller panels */}
              <div className="flex flex-col gap-5">
                
                {/* Case Info */}
                <div className="border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                  <div className="bg-slate-50/80 px-4 py-2 border-b border-slate-200">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5" /> Case Information
                    </h3>
                  </div>
                  <div className="p-4 grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Primary Payer</label>
                      <div className="text-[13px] font-medium text-slate-900 border border-slate-200 bg-slate-50 px-2 py-1.5 rounded">{selectedCharge.primaryPayer}</div>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Type</label>
                      <div className="text-[13px] text-slate-700 border border-slate-200 bg-slate-50 px-2 py-1.5 rounded">{selectedCharge.payerType}</div>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Plan</label>
                      <div className="text-[13px] text-slate-700 border border-slate-200 bg-slate-50 px-2 py-1.5 rounded">{selectedCharge.plan}</div>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Member ID</label>
                      <div className="text-[13px] font-mono font-medium text-slate-900 border border-slate-200 bg-slate-50 px-2 py-1.5 rounded">{selectedCharge.memberId}</div>
                    </div>
                  </div>
                </div>

                {/* Diagnoses */}
                <div className={`border rounded-lg overflow-hidden shadow-sm ${selectedCharge.status === 'missing_dx' ? 'border-red-300 ring-1 ring-red-100' : 'border-slate-200'}`}>
                  <div className={`px-4 py-2 border-b flex items-center justify-between ${selectedCharge.status === 'missing_dx' ? 'bg-red-50 border-red-200' : 'bg-slate-50/80 border-slate-200'}`}>
                    <h3 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${selectedCharge.status === 'missing_dx' ? 'text-red-700' : 'text-slate-600'}`}>
                      <FileText className="w-3.5 h-3.5" /> Diagnosis (ICD-10)
                    </h3>
                    {selectedCharge.status === 'missing_dx' && (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-red-600 bg-white border border-red-200 px-2 py-0.5 rounded">Required</span>
                    )}
                  </div>
                  <div className="p-4 grid grid-cols-2 gap-3">
                    {[1, 2, 3, 4].map(num => {
                      const dx = selectedCharge.diagnoses[num - 1] || "";
                      return (
                        <div key={num} className="flex flex-col relative">
                          <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">D{num}{num === 1 ? '*' : ''}</label>
                          <input 
                            type="text" 
                            defaultValue={dx} 
                            placeholder="---"
                            className={`w-full text-sm font-mono px-3 py-1.5 rounded border ${num === 1 && !dx ? 'border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-200'} focus:outline-none focus:ring-2`} 
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Payments */}
                <div className="border border-slate-200 rounded-lg overflow-hidden shadow-sm">
                  <div className="bg-slate-50/80 px-4 py-2 border-b border-slate-200">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <CreditCard className="w-3.5 h-3.5" /> Client Payments
                    </h3>
                  </div>
                  <div className="p-4 grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Co-Pay</label>
                      <input type="text" defaultValue={formatCurrency(selectedCharge.copay)} className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 bg-white" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Deductible</label>
                      <input type="text" defaultValue={formatCurrency(selectedCharge.deductible)} className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 bg-white" />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Co-Ins %</label>
                      <input type="text" defaultValue={`${selectedCharge.coinsurance}%`} className="w-full text-sm px-2 py-1.5 rounded border border-slate-300 bg-white" />
                    </div>
                  </div>
                </div>

                {/* Blockers */}
                {selectedCharge.blockers.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 shadow-sm">
                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-red-800 flex items-center gap-1.5 mb-2">
                      <AlertTriangle className="w-3.5 h-3.5" /> Blockers
                    </h3>
                    <ul className="list-disc pl-5 text-[13px] text-red-700 space-y-1 font-medium">
                      {selectedCharge.blockers.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN: Proc Lines & Add'l Info */}
              <div className="flex flex-col gap-5">
                
                {/* Procedure Lines Table */}
                <div className="border border-slate-200 rounded-lg shadow-sm bg-white overflow-hidden">
                  <div className="bg-slate-50/80 px-5 py-2.5 border-b border-slate-200 flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Procedure Lines</h3>
                    <button className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 hover:text-indigo-700 flex items-center gap-1 bg-white border border-indigo-200 px-2 py-1 rounded shadow-sm">
                      <Plus className="w-3 h-3" /> Add Line
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                      <thead className="bg-slate-50/50">
                        <tr className="border-b border-slate-200">
                          <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">Proc</th>
                          <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">DOS From</th>
                          <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">DOS To</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">DX Ptr</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">M1</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">M2</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">M3</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">M4</th>
                          <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-right">Units</th>
                          <th className="px-2 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">UOM</th>
                          <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-right">Charge</th>
                          <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-right">Total</th>
                          <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">POS</th>
                          <th className="px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">Auth #</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-3">
                            <input type="text" defaultValue={selectedCharge.cpt} className="w-16 px-2 py-1.5 border border-slate-300 rounded text-sm font-mono focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none" />
                          </td>
                          <td className="px-3 py-3">
                            <input type="text" defaultValue={selectedCharge.dos} className="w-24 px-2 py-1.5 border border-slate-300 rounded text-[13px] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none" />
                          </td>
                          <td className="px-3 py-3">
                            <input type="text" defaultValue={selectedCharge.dos} className="w-24 px-2 py-1.5 border border-slate-300 rounded text-[13px] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none" />
                          </td>
                          <td className="px-2 py-3">
                            <input type="text" defaultValue="1" className="w-10 px-2 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none text-center" />
                          </td>
                          <td className="px-2 py-3">
                            <input type="text" className="w-8 px-1 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none uppercase text-center" />
                          </td>
                          <td className="px-2 py-3">
                            <input type="text" className="w-8 px-1 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none uppercase text-center" />
                          </td>
                          <td className="px-2 py-3">
                            <input type="text" className="w-8 px-1 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none uppercase text-center" />
                          </td>
                          <td className="px-2 py-3">
                            <input type="text" className="w-8 px-1 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none uppercase text-center" />
                          </td>
                          <td className="px-3 py-3">
                            <input type="text" defaultValue="1" className="w-12 px-2 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none text-right" />
                          </td>
                          <td className="px-2 py-3">
                            <select className="w-14 px-1 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 outline-none bg-white">
                              <option>UN</option>
                              <option>MJ</option>
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <input type="text" defaultValue={selectedCharge.charge.toFixed(2)} className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none text-right font-mono" />
                          </td>
                          <td className="px-4 py-3 font-bold text-slate-800 text-right font-mono">
                            {formatCurrency(selectedCharge.charge)}
                          </td>
                          <td className="px-4 py-3">
                            <input type="text" defaultValue={selectedCharge.pos.split(' ')[0]} className="w-10 px-2 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none text-center" />
                          </td>
                          <td className="px-4 py-3">
                            <input type="text" className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none" />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="bg-slate-50/80 px-6 py-4 border-t border-slate-200 flex justify-end">
                    <div className="flex items-center gap-4">
                      <div className="text-xs uppercase font-bold text-slate-500 tracking-wider">Total Charge</div>
                      <div className="text-xl font-bold text-slate-900 font-mono bg-white px-3 py-1 border border-slate-200 rounded">{formatCurrency(selectedCharge.charge)}</div>
                    </div>
                  </div>
                </div>

                {/* Additional Info */}
                <div className="border border-slate-200 rounded-lg shadow-sm bg-white overflow-hidden">
                  <div className="bg-slate-50/80 px-5 py-2.5 border-b border-slate-200">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Additional Information</h3>
                  </div>
                  <div className="p-5 grid grid-cols-2 gap-x-8 gap-y-5">
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Rendering Provider</label>
                      <select className="w-full px-3 py-2 rounded border border-slate-300 text-[13px] font-medium text-slate-800 focus:border-indigo-500 outline-none bg-white">
                        <option>{selectedCharge.renderingProvider}</option>
                        <option>Dr. Alan Grant</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Rendering NPI</label>
                      <input type="text" defaultValue={selectedCharge.npi} className="w-full px-3 py-2 rounded border border-slate-300 text-[13px] font-mono focus:border-indigo-500 outline-none" />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Place of Service</label>
                      <select className="w-full max-w-md px-3 py-2 rounded border border-slate-300 text-[13px] focus:border-indigo-500 outline-none bg-white">
                        <option>{selectedCharge.pos}</option>
                        <option>02 - Telehealth</option>
                        <option>10 - Telehealth in Home</option>
                      </select>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>

          {/* Action Bar (Footer) */}
          <div className="h-16 px-6 bg-white border-t border-slate-200 flex items-center justify-between shrink-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.02)] relative z-30">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
              <span className="text-red-500 text-sm leading-none mt-1">*</span> required field
            </div>
            
            <div className="flex items-center gap-3">
              <button className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded transition-colors shadow-sm">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
              <button className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 hover:border-slate-300 rounded transition-colors shadow-sm">
                <Printer className="w-3.5 h-3.5" /> Print Superbill
              </button>
              
              <div className="w-px h-6 bg-slate-200 mx-2"></div>
              
              <button className="flex items-center gap-2 px-6 py-2.5 text-[13px] font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded transition-colors shadow-sm">
                <Save className="w-4 h-4" /> Save
              </button>
              <button 
                className={`flex items-center gap-2 px-6 py-2.5 text-[13px] font-bold uppercase tracking-wider text-white rounded transition-all shadow-md hover:shadow-lg hover:-translate-y-px ${
                  selectedCharge.status === 'ready' 
                    ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20' 
                    : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/20'
                }`}
              >
                <Send className="w-4 h-4" /> Release to Billing
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
