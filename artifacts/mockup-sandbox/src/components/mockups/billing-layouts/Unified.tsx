/** @jsx React.createElement */
import React, { useState } from "react";
import "./_group.css";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Inbox,
  CreditCard,
  CheckSquare,
  BarChart2,
  Settings,
  ChevronDown,
  ChevronRight,
  Search,
  Phone,
  RefreshCw,
  Check,
  FileText,
} from "lucide-react";

const KPIS = [
  { label: "Open Claims", value: "47" },
  { label: "Avg Days Outstanding", value: "38d" },
  { label: "At-Risk Value", value: "$12,840" },
  { label: "Recently Posted Today", value: "6" },
];

const SUB_NAV = [
  { name: "No Response", count: 47, active: true },
  { name: "Denials", count: 12 },
  { name: "Patient Responsibility", count: 23 },
  { name: "Write-offs", count: 4 },
  { name: "Submitted", count: 156 },
  { name: "Recently Posted", count: 18 },
  { name: "Manual Review", count: 7 },
];

const CLAIMS = [
  { id: "CLM-20281", patient: "Sarah Jenkins", dob: "1985-04-12", dos: "2023-10-15", payer: "Aetna", billed: "$150.00", daysOut: 42, status: "No Response", lastAction: "Followed up 14d ago", assignee: "JS", urgent: false },
  { id: "CLM-20282", patient: "Michael Chang", dob: "1978-11-23", dos: "2023-09-02", payer: "BCBS", billed: "$200.00", daysOut: 95, status: "No Response", lastAction: "Call dropped", assignee: "JS", urgent: true },
  { id: "CLM-20283", patient: "Emma Watson", dob: "1992-02-18", dos: "2023-10-20", payer: "Cigna", billed: "$150.00", daysOut: 37, status: "No Response", lastAction: "Submitted", assignee: "AW", urgent: false },
  { id: "CLM-20284", patient: "David Rodriguez", dob: "1980-07-05", dos: "2023-11-01", payer: "UHC", billed: "$175.00", daysOut: 26, status: "No Response", lastAction: "Submitted", assignee: "JS", urgent: false },
  { id: "CLM-20285", patient: "Lisa Kudrow", dob: "1965-09-14", dos: "2023-08-15", payer: "Medicare", billed: "$120.00", daysOut: 102, status: "No Response", lastAction: "Appealed", assignee: "AW", urgent: true },
  { id: "CLM-20286", patient: "Tom Holland", dob: "1996-06-01", dos: "2023-10-25", payer: "Aetna", billed: "$150.00", daysOut: 32, status: "No Response", lastAction: "Submitted", assignee: "JS", urgent: false },
  { id: "CLM-20287", patient: "Zendaya Coleman", dob: "1996-09-01", dos: "2023-10-28", payer: "BCBS", billed: "$200.00", daysOut: 29, status: "No Response", lastAction: "Submitted", assignee: "AW", urgent: false },
];

export default function Unified() {
  const [selectedClaim, setSelectedClaim] = useState("CLM-20282");
  const [billingExpanded, setBillingExpanded] = useState(true);

  return (
    <div className="unified-layout">
      <aside className="sidebar-container">
        <div className="sidebar-header">
          TherassistantEHR
        </div>
        <div style={{ padding: '12px 0' }}>
          <div className="nav-item">
            <LayoutDashboard size={18} className="nav-icon" /> Dashboard
          </div>
          <div className="nav-item">
            <Users size={18} className="nav-icon" /> Patients
          </div>
          <div className="nav-item">
            <Calendar size={18} className="nav-icon" /> Schedule
          </div>
          <div className="nav-item">
            <Inbox size={18} className="nav-icon" /> Mailroom
          </div>
          
          <div 
            className={`nav-item ${billingExpanded ? 'active' : ''}`}
            onClick={() => setBillingExpanded(!billingExpanded)}
          >
            <CreditCard size={18} className="nav-icon" /> 
            <span style={{ flex: 1 }}>Billing</span>
            {billingExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          
          <div className="tree-container" style={{ maxHeight: billingExpanded ? '400px' : '0' }}>
            <div className="tree-line"></div>
            {SUB_NAV.map((nav) => (
              <div key={nav.name} className={`tree-item ${nav.active ? 'active' : ''}`}>
                {nav.name}
                <span className="badge">{nav.count}</span>
              </div>
            ))}
          </div>

          <div className="nav-item">
            <CheckSquare size={18} className="nav-icon" /> Tasks
          </div>
          <div className="nav-item">
            <BarChart2 size={18} className="nav-icon" /> Reports
          </div>
          <div className="nav-item">
            <Settings size={18} className="nav-icon" /> Settings
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--ehr-text-main)' }}>No Response</h1>
            <span style={{ color: 'var(--ehr-text-muted)', fontSize: '14px' }}>47 Claims</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--ehr-text-muted)' }} />
              <input 
                type="text" 
                placeholder="Search claims..." 
                style={{ padding: '8px 12px 8px 32px', border: '1px solid var(--ehr-border)', borderRadius: '6px', fontSize: '13px', width: '240px' }}
              />
            </div>
            <button className="btn-primary">Bulk follow-up</button>
          </div>
        </header>

        <div className="kpi-row">
          {KPIS.map(kpi => (
            <div key={kpi.label} className="kpi-card">
              <span className="kpi-value">{kpi.value}</span>
              <span className="kpi-label">{kpi.label}</span>
            </div>
          ))}
        </div>

        <div className="content-body">
          <div className="toolbar">
            <div className="filters">
              <select className="filter-select">
                <option>All Payers</option>
                <option>Aetna</option>
                <option>BCBS</option>
                <option>Cigna</option>
                <option>UHC</option>
                <option>Medicare</option>
              </select>
              
              <div className="pill-group">
                <div className="pill">0–30</div>
                <div className="pill">31–60</div>
                <div className="pill">61–90</div>
                <div className="pill active">90+</div>
              </div>

              <select className="filter-select">
                <option>Assignee: All</option>
                <option>JS</option>
                <option>AW</option>
              </select>
            </div>
          </div>

          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Claim #</th>
                  <th>DOS</th>
                  <th>Payer</th>
                  <th>Billed</th>
                  <th>Days Out</th>
                  <th>Status</th>
                  <th>Last Action</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {CLAIMS.map((claim) => (
                  <React.Fragment key={claim.id}>
                    <tr 
                      className={`row-main ${selectedClaim === claim.id ? 'row-selected' : ''} ${claim.urgent && selectedClaim !== claim.id ? 'row-danger' : ''}`}
                      onClick={() => setSelectedClaim(selectedClaim === claim.id ? "" : claim.id)}
                    >
                      <td>
                        <div style={{ fontWeight: 500 }}>{claim.patient}</div>
                        <div style={{ fontSize: '11px', color: 'var(--ehr-text-muted)' }}>DOB: {claim.dob}</div>
                      </td>
                      <td style={{ fontFamily: 'monospace' }}>{claim.id}</td>
                      <td>{claim.dos}</td>
                      <td>{claim.payer}</td>
                      <td>{claim.billed}</td>
                      <td style={{ color: claim.urgent ? 'var(--ehr-danger-text)' : 'inherit', fontWeight: claim.urgent ? 600 : 400 }}>
                        {claim.daysOut}d
                      </td>
                      <td>
                        <span className="status-badge">{claim.status}</span>
                      </td>
                      <td style={{ color: 'var(--ehr-text-muted)' }}>{claim.lastAction}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                          <button className="btn-outline" style={{ padding: '4px 8px' }} onClick={(e) => { e.stopPropagation(); }}>
                            <Phone size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    
                    {selectedClaim === claim.id && (
                      <tr>
                        <td colSpan={9} style={{ padding: 0 }}>
                          <div className="inline-detail">
                            <div className="detail-content">
                              <div style={{ flex: '0 0 300px' }}>
                                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px' }}>Claim Timeline</h3>
                                <div className="timeline">
                                  <div className="timeline-item">
                                    <div className="timeline-dot"></div>
                                    <div style={{ fontSize: '12px', color: 'var(--ehr-text-muted)' }}>2 hours ago</div>
                                    <div style={{ fontSize: '13px', fontWeight: 500 }}>Awaiting payer response</div>
                                  </div>
                                  <div className="timeline-item">
                                    <div className="timeline-dot active"></div>
                                    <div style={{ fontSize: '12px', color: 'var(--ehr-text-muted)' }}>14 days ago</div>
                                    <div style={{ fontSize: '13px', fontWeight: 500 }}>Followed up via phone</div>
                                    <div style={{ fontSize: '12px', color: 'var(--ehr-text-muted)', marginTop: '4px' }}>Spoke with rep. Claim is in review.</div>
                                  </div>
                                  <div className="timeline-item">
                                    <div className="timeline-dot"></div>
                                    <div style={{ fontSize: '12px', color: 'var(--ehr-text-muted)' }}>95 days ago</div>
                                    <div style={{ fontSize: '13px', fontWeight: 500 }}>Submitted via Availity</div>
                                  </div>
                                </div>
                              </div>
                              
                              <div style={{ flex: 1 }}>
                                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px' }}>Attachments</h3>
                                <div style={{ border: '1px dashed var(--ehr-border)', borderRadius: '6px', padding: '16px', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white' }}>
                                  <FileText size={20} color="var(--ehr-text-muted)" />
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: '13px', fontWeight: 500 }}>Initial_Claim_Form.pdf</div>
                                    <div style={{ fontSize: '12px', color: 'var(--ehr-text-muted)' }}>Added Oct 15, 2023</div>
                                  </div>
                                  <button className="btn-outline" style={{ padding: '4px 8px', fontSize: '12px' }}>View</button>
                                </div>
                              </div>

                              <div style={{ flex: '0 0 200px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                  <Phone size={14} /> Log call outcome
                                </button>
                                <button className="btn-outline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                  <RefreshCw size={14} /> Resubmit
                                </button>
                                <button className="btn-outline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--ehr-danger-text)', borderColor: '#fecaca' }}>
                                  <Check size={14} /> Write off
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}