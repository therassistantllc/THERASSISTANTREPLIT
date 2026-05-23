import React, { useState } from "react";
import { Shell } from "./_shared/Shell";
import { Shield, Plus, Download, Clock, Info, Check, User, Users } from "lucide-react";
import "./_group.css";

const DOMAINS = [
  {
    name: "Clinical",
    color: "rgba(94, 138, 106, 0.05)",
    border: "rgba(94, 138, 106, 0.2)",
    capabilities: [
      { id: "view_phi", label: "View PHI" },
      { id: "edit_charts", label: "Edit charts" },
      { id: "sign_notes", label: "Sign notes" },
    ]
  },
  {
    name: "Billing",
    color: "rgba(26, 61, 104, 0.03)",
    border: "rgba(26, 61, 104, 0.15)",
    capabilities: [
      { id: "post_ins_pmt", label: "Post insurance payments" },
      { id: "post_client_pmt", label: "Post client payments" },
      { id: "issue_refunds", label: "Issue refunds" },
      { id: "submit_837p", label: "Submit 837P" },
      { id: "view_eras", label: "View ERAs" },
    ]
  },
  {
    name: "Admin",
    color: "rgba(176, 32, 32, 0.03)",
    border: "rgba(176, 32, 32, 0.1)",
    capabilities: [
      { id: "manage_payers", label: "Manage payer enrollments" },
      { id: "manage_staff", label: "Manage staff" },
      { id: "config_billing", label: "Configure billing defaults" },
      { id: "view_audit", label: "View audit logs" },
    ]
  }
];

const ROLES = [
  { id: "admin", label: "Admin" },
  { id: "biller", label: "Biller" },
  { id: "clinician", label: "Clinician" },
  { id: "front_desk", label: "Front Desk" },
  { id: "auditor", label: "Read-only Auditor" }
];

const INITIAL_PERMISSIONS: Record<string, string[]> = {
  admin: ["view_phi", "edit_charts", "sign_notes", "post_ins_pmt", "post_client_pmt", "issue_refunds", "submit_837p", "view_eras", "manage_payers", "manage_staff", "config_billing", "view_audit"],
  biller: ["view_phi", "post_ins_pmt", "post_client_pmt", "issue_refunds", "submit_837p", "view_eras", "manage_payers", "config_billing"],
  clinician: ["view_phi", "edit_charts", "sign_notes", "view_eras"],
  front_desk: ["view_phi", "post_client_pmt"],
  auditor: ["view_phi", "view_eras", "view_audit"],
};

const RECENT_CHANGES = [
  { user: "Rivera, J.", action: "granted", role: "Clinician", capability: "Sign notes", time: "2 hours ago" },
  { user: "Whitfield, S.", action: "revoked", role: "Front Desk", capability: "Issue refunds", time: "1 day ago" },
  { user: "System", action: "created", role: "Read-only Auditor", capability: "New Role", time: "3 days ago" },
];

const ASSIGNMENTS = [
  { role: "Admin", count: 2, users: "Rivera, J., Whitfield, S." },
  { role: "Biller", count: 3, users: "Chen, M., Davis, L., +1 more" },
  { role: "Clinician", count: 14, users: "Patel, A., Martinez, R., +12 more" },
  { role: "Front Desk", count: 4, users: "Smith, K., Johnson, T., +2 more" },
  { role: "Read-only Auditor", count: 1, users: "External Auditor" },
];

export function PermissionMatrix() {
  const [permissions, setPermissions] = useState<Record<string, string[]>>(INITIAL_PERMISSIONS);

  const togglePermission = (roleId: string, capId: string) => {
    setPermissions(prev => {
      const rolePerms = prev[roleId] || [];
      if (rolePerms.includes(capId)) {
        return { ...prev, [roleId]: rolePerms.filter(id => id !== capId) };
      } else {
        return { ...prev, [roleId]: [...rolePerms, capId] };
      }
    });
  };

  const totalCaps = DOMAINS.reduce((acc, d) => acc + d.capabilities.length, 0);

  return (
    <Shell>
      <div className="flex flex-col gap-6 max-w-[1200px] pb-12">
        <section className="hero-panel mb-0">
          <div>
            <p className="eyebrow">Settings</p>
            <h1>Security &amp; Access</h1>
            <p className="hero-copy">Manage roles and exact capabilities for staff members.</p>
          </div>
          <div className="hero-actions">
            <button className="button button-secondary">
              <Download size={14} className="mr-2" />
              Export CSV
            </button>
            <button className="button button-secondary">
              <Plus size={14} className="mr-2" />
              Add Capability
            </button>
            <button className="button">
              <Plus size={14} className="mr-2" />
              Add Role
            </button>
          </div>
        </section>

        <div className="bg-blue-50 border border-blue-100 rounded-md p-3 flex items-start gap-3 text-sm text-blue-900">
          <Info size={16} className="mt-0.5 text-blue-600 flex-shrink-0" />
          <div>
            <strong>Permissions are enforced server-side via Supabase RLS.</strong> Changes applied here are synced and take effect globally within 30 seconds.
          </div>
        </div>

        <section className="panel p-0 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-[var(--line)] flex justify-between items-end">
            <div>
              <h2 style={{ marginBottom: 4 }}>Permission Matrix</h2>
              <div className="text-[13px] text-[var(--muted)]">
                {ROLES.length} roles, {totalCaps} capabilities
              </div>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse" style={{ minWidth: 800 }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white border-b border-r border-[var(--line)] p-3 text-[13px] font-semibold text-[var(--navy)] min-w-[160px]">
                    Role
                  </th>
                  {DOMAINS.map(domain => (
                    <th 
                      key={domain.name} 
                      colSpan={domain.capabilities.length}
                      className="border-b border-r border-[var(--line)] p-2 text-center text-[12px] font-bold tracking-wider uppercase text-[var(--navy)]"
                      style={{ background: domain.color, borderBottomColor: domain.border }}
                    >
                      {domain.name}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="sticky left-0 z-10 bg-white border-b border-r border-[var(--line)] p-0"></th>
                  {DOMAINS.map(domain => (
                    domain.capabilities.map((cap, i) => (
                      <th 
                        key={cap.id}
                        className="border-b border-r border-[var(--line)] p-3 text-[12px] font-medium text-[var(--muted)] whitespace-nowrap align-bottom"
                        style={{ background: domain.color, borderRightColor: i === domain.capabilities.length - 1 ? 'var(--line)' : domain.border }}
                      >
                        <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }} className="h-32 mb-2">
                          {cap.label}
                        </div>
                      </th>
                    ))
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROLES.map(role => (
                  <tr key={role.id} className="hover:bg-gray-50/50">
                    <td className="sticky left-0 z-10 bg-white border-b border-r border-[var(--line)] p-3 text-[13px] font-medium text-[var(--navy)]">
                      {role.label}
                    </td>
                    {DOMAINS.map(domain => (
                      domain.capabilities.map((cap, i) => {
                        const isChecked = permissions[role.id]?.includes(cap.id);
                        return (
                          <td 
                            key={cap.id}
                            className="border-b border-r border-[var(--line)] p-0 text-center cursor-pointer hover:bg-black/5 transition-colors"
                            onClick={() => togglePermission(role.id, cap.id)}
                            style={{ borderRightColor: i === domain.capabilities.length - 1 ? 'var(--line)' : domain.border }}
                          >
                            <div className="w-full h-full min-h-[44px] flex items-center justify-center">
                              <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${isChecked ? 'bg-[var(--navy)] text-white' : 'border border-[var(--line)] bg-white'}`}>
                                {isChecked && <Check size={14} strokeWidth={3} />}
                              </div>
                            </div>
                          </td>
                        );
                      })
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className="sticky left-0 z-10 bg-white border-b border-r border-[var(--line)] p-3">
                    <button className="text-[13px] text-[var(--sage)] font-medium flex items-center hover:underline">
                      <Plus size={14} className="mr-1" />
                      New role
                    </button>
                  </td>
                  <td colSpan={totalCaps} className="border-b border-[var(--line)] bg-gray-50/30"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          <section className="panel">
            <div className="flex items-center justify-between mb-4">
              <h2 className="!mb-0">Recently Changed</h2>
              <button className="text-[12px] font-medium text-[var(--sage)]">View full log</button>
            </div>
            <div className="flex flex-col gap-4">
              {RECENT_CHANGES.map((change, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <div className="mt-0.5 bg-[var(--background)] p-1.5 rounded-full text-[var(--muted)]">
                    <Clock size={14} />
                  </div>
                  <div className="text-[13px] leading-relaxed">
                    <span className="font-medium text-[var(--navy)]">{change.user}</span>{' '}
                    <span className={change.action === 'granted' ? 'text-green-700' : change.action === 'revoked' ? 'text-red-700' : 'text-blue-700'}>
                      {change.action}
                    </span>{' '}
                    <span className="font-medium">{change.role}</span>{' '}
                    {change.capability !== 'New Role' ? `the '${change.capability}' capability` : 'role'}
                    <div className="text-[12px] text-[var(--muted)] mt-0.5">{change.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2 className="mb-4">Role Assignments</h2>
            <div className="border border-[var(--line)] rounded-md overflow-hidden">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="bg-[var(--background)] border-b border-[var(--line)]">
                    <th className="p-2 px-3 font-medium text-[var(--muted)]">Role</th>
                    <th className="p-2 px-3 font-medium text-[var(--muted)] w-16 text-right">Count</th>
                    <th className="p-2 px-3 font-medium text-[var(--muted)]">People</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {ASSIGNMENTS.map((assignment, i) => (
                    <tr key={i}>
                      <td className="p-2 px-3 font-medium text-[var(--navy)]">{assignment.role}</td>
                      <td className="p-2 px-3 text-right">
                        <span className="inline-flex items-center justify-center bg-[var(--sage-soft)] text-[var(--sage)] font-semibold rounded-full h-5 px-2 text-[11px]">
                          {assignment.count}
                        </span>
                      </td>
                      <td className="p-2 px-3 text-[var(--muted)] truncate max-w-[200px]">
                        {assignment.users}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}
