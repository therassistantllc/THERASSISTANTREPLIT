import React, { useState } from 'react';
import { Search, RefreshCw, Printer, Save, Send, AlertCircle, FileWarning, Clock, PauseCircle, CheckCircle2 } from 'lucide-react';

// --- Types ---
type ChargeStatus = 'ready' | 'unsigned' | 'missing_dx' | 'hold' | 'released';

interface ChargeRow {
  id: string;
  client: string;
  charge: number;
  status: ChargeStatus;
  cpt: string;
  dos: string;
  payer: string;
}

// --- Mock Data ---
const MOCK_CHARGES: ChargeRow[] = [
  { id: '1', client: 'Reyes, Marisol', charge: 175.00, status: 'missing_dx', cpt: '90837', dos: '10/24/2023', payer: 'Aetna PPO' },
  { id: '2', client: 'Chen, David', charge: 150.00, status: 'unsigned', cpt: '90834', dos: '10/24/2023', payer: 'BCBS Texas' },
  { id: '3', client: 'Smith, James', charge: 225.00, status: 'ready', cpt: '90791', dos: '10/23/2023', payer: 'Medicare' },
  { id: '4', client: 'Johnson, Emily', charge: 175.00, status: 'released', cpt: '90837', dos: '10/22/2023', payer: 'Cigna PPO' },
  { id: '5', client: 'Williams, Michael', charge: 150.00, status: 'hold', cpt: '90834', dos: '10/21/2023', payer: 'UnitedHealthcare' },
  { id: '6', client: 'Brown, Sarah', charge: 175.00, status: 'ready', cpt: '90837', dos: '10/21/2023', payer: 'Aetna HMO' },
  { id: '7', client: 'Davis, Robert', charge: 225.00, status: 'unsigned', cpt: '90791', dos: '10/20/2023', payer: 'BCBS Texas' },
];

const STATUS_CONFIG: Record<ChargeStatus, { label: string; classes: string; icon: React.FC<any> }> = {
  ready: { label: 'Ready', classes: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2 },
  unsigned: { label: 'Unsigned', classes: 'bg-amber-100 text-amber-800 border-amber-200', icon: Clock },
  missing_dx: { label: 'Missing DX', classes: 'bg-red-100 text-red-800 border-red-200', icon: FileWarning },
  hold: { label: 'Hold', classes: 'bg-slate-200 text-slate-700 border-slate-300', icon: PauseCircle },
  released: { label: 'Released', classes: 'bg-blue-100 text-blue-800 border-blue-200', icon: Send },
};

// --- Components ---

function StatusBadge({ status }: { status: ChargeStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${config.classes}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

function Input({ value, readOnly, className = '', ...props }: any) {
  return (
    <input
      value={value}
      readOnly={readOnly}
      className={`h-8 w-full rounded border px-2.5 text-[13px] outline-none transition-colors
        ${readOnly 
          ? 'bg-slate-50 border-slate-200 text-slate-600 cursor-default' 
          : 'bg-white border-slate-300 text-slate-900 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
        } ${className}`}
      {...props}
    />
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1 block">
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function Section({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden ${className}`}>
      {title && (
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50">
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{title}</h3>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

// --- Main Layout ---

export function SplitView() {
  const [selectedId, setSelectedId] = useState<string>('1');
  const [search, setSearch] = useState('');

  const selectedCharge = MOCK_CHARGES.find(c => c.id === selectedId) || MOCK_CHARGES[0];

  return (
    <div className="flex h-screen w-full bg-slate-100 text-slate-900 overflow-hidden font-sans selection:bg-indigo-100">
      
      {/* LEFT PANE: Worklist */}
      <aside className="w-[340px] flex-shrink-0 flex flex-col bg-white border-r border-slate-200 z-20">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 bg-white">
          <h1 className="text-lg font-bold text-slate-900 mb-4">Charges</h1>
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search client, CPT..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 bg-slate-50 border border-slate-200 rounded-md text-[13px] outline-none focus:bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 transition-all placeholder:text-slate-400"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {MOCK_CHARGES.map((charge) => {
            const isActive = selectedId === charge.id;
            return (
              <button
                key={charge.id}
                onClick={() => setSelectedId(charge.id)}
                className={`w-full text-left p-3 border-b border-slate-100 transition-colors flex flex-col gap-2 relative
                  ${isActive ? 'bg-indigo-50/60' : 'hover:bg-slate-50 bg-white'}`}
              >
                {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-indigo-600 rounded-r" />}
                
                <div className="flex justify-between items-start">
                  <span className={`font-semibold text-[14px] ${isActive ? 'text-indigo-900' : 'text-slate-800'}`}>
                    {charge.client}
                  </span>
                  <span className="font-semibold text-slate-700 text-[13px] tabular-nums">
                    ${charge.charge.toFixed(2)}
                  </span>
                </div>
                
                <div className="flex justify-between items-center">
                  <StatusBadge status={charge.status} />
                  <span className="text-[12px] text-slate-500 font-medium">{charge.dos}</span>
                </div>
                
                <div className="flex justify-between items-center mt-0.5">
                  <span className="text-[12px] font-mono text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">{charge.cpt}</span>
                  <span className="text-[12px] text-slate-500 truncate max-w-[140px] text-right">{charge.payer}</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* RIGHT PANE: Detail Editor */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">
        
        {/* Sticky Client Bar */}
        <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-3 shadow-sm flex items-center gap-6 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <Label>Client</Label>
            <div className="text-[15px] font-bold text-slate-900 leading-none mt-1">{selectedCharge.client}</div>
          </div>
          <div>
            <Label>DOB</Label>
            <div className="text-[14px] text-slate-700 font-medium">04/12/1985</div>
          </div>
          <div>
            <Label>Age</Label>
            <div className="text-[14px] text-slate-700 font-medium">38</div>
          </div>
          <div>
            <Label>Acct #</Label>
            <div className="text-[14px] text-slate-700 font-medium font-mono">MR-48291</div>
          </div>
          <div>
            <Label>Service Date</Label>
            <div className="text-[14px] text-slate-900 font-semibold">{selectedCharge.dos}</div>
          </div>
          <div className="pl-4 border-l border-slate-200">
            <Label>Status</Label>
            <div className="mt-0.5">
              <StatusBadge status={selectedCharge.status} />
            </div>
          </div>
        </header>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl mx-auto flex flex-col gap-5">
            
            {/* Blockers */}
            {selectedCharge.status === 'missing_dx' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-3 shadow-sm">
                <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
                <div>
                  <h4 className="text-[13px] font-bold text-red-900">Claim blocked from release</h4>
                  <ul className="mt-1 text-[13px] text-red-800 list-disc list-inside pl-4">
                    <li>Primary diagnosis code (D1) is required for billing.</li>
                  </ul>
                </div>
              </div>
            )}

            {/* Case Information */}
            <Section title="Case Information">
              <div className="grid grid-cols-4 gap-4">
                <div className="col-span-1">
                  <Label>Primary Payer</Label>
                  <Input value={selectedCharge.payer} readOnly />
                </div>
                <div className="col-span-1">
                  <Label>Plan</Label>
                  <Input value="Choice POS II" readOnly />
                </div>
                <div className="col-span-1">
                  <Label>Member ID</Label>
                  <Input value="W829481102" readOnly />
                </div>
                <div className="col-span-1">
                  <Label>Type</Label>
                  <Input value="Commercial" readOnly />
                </div>
              </div>
            </Section>

            {/* Diagnoses */}
            <Section title="Diagnosis (ICD-10)">
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <Label required>D1 (Primary)</Label>
                  <Input defaultValue={selectedCharge.status === 'missing_dx' ? '' : 'F41.1'} placeholder="Search ICD-10..." className={selectedCharge.status === 'missing_dx' ? 'border-red-300 bg-red-50/50' : ''} />
                  {selectedCharge.status !== 'missing_dx' && <div className="mt-1 text-[11px] text-slate-500 truncate">Generalized anxiety disorder</div>}
                </div>
                <div>
                  <Label>D2</Label>
                  <Input defaultValue="" placeholder="Optional..." />
                </div>
                <div>
                  <Label>D3</Label>
                  <Input defaultValue="" placeholder="Optional..." />
                </div>
                <div>
                  <Label>D4</Label>
                  <Input defaultValue="" placeholder="Optional..." />
                </div>
              </div>
            </Section>

            {/* Procedure Lines */}
            <Section title="Procedure Lines" className="overflow-visible">
              <div className="border border-slate-200 rounded-md overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      <th className="p-2 pl-3 w-8 text-center">#</th>
                      <th className="p-2 w-28">Proc <span className="text-red-500">*</span></th>
                      <th className="p-2 w-28">DOS From <span className="text-red-500">*</span></th>
                      <th className="p-2 w-28">DOS To <span className="text-red-500">*</span></th>
                      <th className="p-2 w-20">DX Ptr <span className="text-red-500">*</span></th>
                      <th className="p-2 w-16">M1</th>
                      <th className="p-2 w-16">M2</th>
                      <th className="p-2 w-16">M3</th>
                      <th className="p-2 w-16">M4</th>
                      <th className="p-2 w-16">Units <span className="text-red-500">*</span></th>
                      <th className="p-2 w-16">UOM</th>
                      <th className="p-2 w-24">Charge <span className="text-red-500">*</span></th>
                      <th className="p-2 w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50">
                      <td className="p-2 pl-3 text-[12px] font-medium text-slate-400 text-center">1</td>
                      <td className="p-2"><Input defaultValue={selectedCharge.cpt} /></td>
                      <td className="p-2"><Input type="date" defaultValue="2023-10-24" /></td>
                      <td className="p-2"><Input type="date" defaultValue="2023-10-24" /></td>
                      <td className="p-2"><Input defaultValue="1" /></td>
                      <td className="p-2"><Input defaultValue="" /></td>
                      <td className="p-2"><Input defaultValue="" /></td>
                      <td className="p-2"><Input defaultValue="" /></td>
                      <td className="p-2"><Input defaultValue="" /></td>
                      <td className="p-2"><Input type="number" defaultValue="1" /></td>
                      <td className="p-2">
                        <select className="h-8 w-full rounded border border-slate-300 px-1 text-[13px] outline-none bg-white text-slate-900 focus:border-indigo-500 focus:ring-1">
                          <option>UN</option>
                          <option>MJ</option>
                        </select>
                      </td>
                      <td className="p-2">
                        <div className="relative">
                          <span className="absolute left-2 top-[7px] text-slate-400 text-[13px]">$</span>
                          <Input type="number" defaultValue={selectedCharge.charge} className="pl-5 tabular-nums" />
                        </div>
                      </td>
                      <td className="p-2 pr-3">
                        <div className="h-8 flex items-center px-2 text-[13px] font-semibold text-slate-700 tabular-nums bg-slate-50 rounded border border-transparent">
                          ${selectedCharge.charge.toFixed(2)}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50/80 border-t border-slate-200">
                      <td colSpan={11} className="p-2 text-right text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Total Charges:</td>
                      <td colSpan={2} className="p-2 pr-3">
                        <div className="text-[15px] font-bold text-slate-900 tabular-nums ml-2">
                          ${selectedCharge.charge.toFixed(2)}
                        </div>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Section>

            {/* Bottom Row: Additional Info + Payments */}
            <div className="grid grid-cols-2 gap-5 mb-4">
              <Section title="Additional Information" className="h-full">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Label required>Rendering Provider</Label>
                    <select className="h-8 w-full rounded border border-slate-300 px-2 text-[13px] outline-none bg-white text-slate-900 focus:border-indigo-500 focus:ring-1">
                      <option>Dr. Sarah Jenkins, PhD</option>
                      <option>Dr. Marcus Webb, MD</option>
                    </select>
                  </div>
                  <div className="col-span-1">
                    <Label>NPI</Label>
                    <Input value="1892348712" readOnly />
                  </div>
                  <div className="col-span-1">
                    <Label required>Place of Service</Label>
                    <select className="h-8 w-full rounded border border-slate-300 px-2 text-[13px] outline-none bg-white text-slate-900 focus:border-indigo-500 focus:ring-1">
                      <option>11 - Office</option>
                      <option>02 - Telehealth</option>
                      <option>10 - Telehealth In-Home</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <Label>Auth #</Label>
                    <Input defaultValue="" placeholder="Optional prior auth number..." />
                  </div>
                </div>
              </Section>

              <Section title="Client Payments (Memo)" className="h-full">
                <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
                  Amounts expected from the client based on their policy. These do not alter the claim total.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Co-Pay</Label>
                    <div className="relative">
                      <span className="absolute left-2 top-[7px] text-slate-400 text-[13px]">$</span>
                      <Input type="number" defaultValue="25.00" className="pl-5 tabular-nums" />
                    </div>
                  </div>
                  <div>
                    <Label>Deductible Remaining</Label>
                    <div className="relative">
                      <span className="absolute left-2 top-[7px] text-slate-400 text-[13px]">$</span>
                      <Input type="number" defaultValue="0.00" className="pl-5 tabular-nums" />
                    </div>
                  </div>
                  <div>
                    <Label>Co-Ins %</Label>
                    <div className="relative">
                      <Input type="number" defaultValue="0" className="pr-5 tabular-nums" />
                      <span className="absolute right-2 top-[7px] text-slate-400 text-[13px]">%</span>
                    </div>
                  </div>
                </div>
              </Section>
            </div>
            
          </div>
        </div>

        {/* Sticky Action Bar */}
        <footer className="sticky bottom-0 z-10 bg-white border-t border-slate-200 px-6 py-3.5 flex items-center justify-between shadow-[0_-4px_6px_-1px_rgb(0,0,0,0.02)]">
          <div className="text-[12px] text-slate-500 font-medium">
            <span className="text-red-500">*</span> required field
          </div>
          
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors">
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors mr-2">
              <Printer className="w-4 h-4" />
              Print Superbill
            </button>
            
            <div className="w-px h-6 bg-slate-200 mr-2"></div>
            
            <button className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 hover:border-slate-400 rounded-md shadow-sm transition-all">
              <Save className="w-4 h-4 text-slate-500" />
              Save
            </button>
            <button 
              className={`flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-white rounded-md shadow-sm transition-all
                ${selectedCharge.status === 'missing_dx' 
                  ? 'bg-indigo-400 cursor-not-allowed opacity-80' 
                  : 'bg-indigo-600 hover:bg-indigo-700 hover:shadow'}`}
            >
              <Send className="w-4 h-4" />
              Release to Billing
            </button>
          </div>
        </footer>

      </main>
    </div>
  );
}
