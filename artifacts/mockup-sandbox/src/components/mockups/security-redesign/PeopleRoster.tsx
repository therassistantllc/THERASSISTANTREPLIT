import React, { useState } from "react";
import { Shell } from "./_shared/Shell";
import "./_group.css";
import { 
  Search, 
  MoreHorizontal, 
  Shield, 
  Activity, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  Users,
  Download,
  UserPlus,
  Filter,
  ChevronDown
} from "lucide-react";

const STAFF_DATA = [
  { id: 1, name: "Rivera, J.", initials: "JR", role: "Admin", email: "j.rivera@sunrisebehavioral.com", mfa: true, lastSignIn: "2 mins ago", status: "Active" },
  { id: 2, name: "Dr. Sarah Whitfield, LCSW", initials: "SW", role: "Clinician", email: "swhitfield@sunrisebehavioral.com", mfa: true, lastSignIn: "1 hr ago", status: "Active" },
  { id: 3, name: "Marcus Chen", initials: "MC", role: "Biller", email: "mchen@sunrisebehavioral.com", mfa: false, lastSignIn: "4 hrs ago", status: "Active" },
  { id: 4, name: "Elena Rostova", initials: "ER", role: "Front desk", email: "erostova@sunrisebehavioral.com", mfa: true, lastSignIn: "Yesterday", status: "Active" },
  { id: 5, name: "Dr. James Wilson, MD", initials: "JW", role: "Clinician", email: "jwilson@sunrisebehavioral.com", mfa: true, lastSignIn: "2 days ago", status: "Active" },
  { id: 6, name: "Amelia Pond", initials: "AP", role: "Biller", email: "apond@sunrisebehavioral.com", mfa: true, lastSignIn: "3 days ago", status: "Active" },
  { id: 7, name: "Dr. Gregory House", initials: "GH", role: "Clinician", email: "ghouse@sunrisebehavioral.com", mfa: false, lastSignIn: "Never", status: "Invited" },
  { id: 8, name: "Lisa Cuddy", initials: "LC", role: "Admin", email: "lcuddy@sunrisebehavioral.com", mfa: true, lastSignIn: "1 week ago", status: "Active" },
  { id: 9, name: "Eric Foreman", initials: "EF", role: "Clinician", email: "eforeman@sunrisebehavioral.com", mfa: true, lastSignIn: "1 week ago", status: "Active" },
  { id: 10, name: "Robert Chase", initials: "RC", role: "Clinician", email: "rchase@sunrisebehavioral.com", mfa: true, lastSignIn: "2 weeks ago", status: "Deactivated" },
  { id: 11, name: "Allison Cameron", initials: "AC", role: "Clinician", email: "acameron@sunrisebehavioral.com", mfa: true, lastSignIn: "1 month ago", status: "Active" },
  { id: 12, name: "Chris Taub", initials: "CT", role: "Clinician", email: "ctaub@sunrisebehavioral.com", mfa: false, lastSignIn: "Never", status: "Invited" },
];

const getRoleColor = (role: string) => {
  switch (role) {
    case "Admin": return "bg-purple-100 text-purple-800 border-purple-200";
    case "Clinician": return "bg-blue-100 text-blue-800 border-blue-200";
    case "Biller": return "bg-amber-100 text-amber-800 border-amber-200";
    case "Front desk": return "bg-slate-100 text-slate-800 border-slate-200";
    default: return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case "Active": return "text-emerald-700 bg-emerald-50 border-emerald-200";
    case "Invited": return "text-amber-700 bg-amber-50 border-amber-200";
    case "Deactivated": return "text-slate-500 bg-slate-50 border-slate-200";
    default: return "text-gray-700 bg-gray-50 border-gray-200";
  }
};

export function PeopleRoster() {
  return (
    <Shell>
      <div className="flex flex-col h-full gap-4 max-w-6xl mx-auto">
        
        {/* Header */}
        <div className="flex items-end justify-between pb-2 border-b border-[var(--line)]">
          <div>
            <p className="eyebrow">Settings</p>
            <h1 className="text-[22px] font-semibold text-[var(--navy)] m-0 leading-tight">Security &amp; Access</h1>
            <p className="text-[13px] text-[var(--muted)] mt-1">Manage staff accounts, access control, and review audit logs.</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="button button-secondary gap-2 text-[13px] h-[32px] px-3">
              <Download size={14} />
              Bulk import
            </button>
            <button className="button gap-2 text-[13px] h-[32px] px-3">
              <UserPlus size={14} />
              Invite staff
            </button>
          </div>
        </div>

        <div className="flex items-start gap-6 mt-2">
          {/* Main Roster Content */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            
            {/* Filters & Search */}
            <div className="flex items-center justify-between bg-[var(--card)] p-3 border border-[var(--line)] rounded-md shadow-sm">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                <button className="px-3 py-1.5 text-[13px] rounded-full bg-[var(--navy)] text-white font-medium">All 23</button>
                <button className="px-3 py-1.5 text-[13px] rounded-full bg-[var(--sage-soft)] text-[var(--navy)] hover:bg-[var(--sage-mid)] transition-colors border border-transparent">Admin 2</button>
                <button className="px-3 py-1.5 text-[13px] rounded-full bg-[var(--sage-soft)] text-[var(--navy)] hover:bg-[var(--sage-mid)] transition-colors border border-transparent">Biller 4</button>
                <button className="px-3 py-1.5 text-[13px] rounded-full bg-[var(--sage-soft)] text-[var(--navy)] hover:bg-[var(--sage-mid)] transition-colors border border-transparent">Clinician 14</button>
                <button className="px-3 py-1.5 text-[13px] rounded-full bg-[var(--sage-soft)] text-[var(--navy)] hover:bg-[var(--sage-mid)] transition-colors border border-transparent">Front desk 3</button>
              </div>
              <div className="flex items-center gap-3 ml-4">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                  <input 
                    type="text" 
                    placeholder="Search staff..." 
                    className="h-[32px] pl-8 pr-3 text-[13px] border border-[var(--line)] rounded-md w-[200px] focus:outline-none focus:border-[var(--sage)]"
                  />
                </div>
                <button className="flex items-center gap-2 h-[32px] px-3 text-[13px] border border-[var(--line)] rounded-md bg-white text-[var(--text)] hover:bg-gray-50">
                  <Filter size={14} className="text-[var(--muted)]" />
                  Status
                  <ChevronDown size={14} className="text-[var(--muted)] ml-1" />
                </button>
              </div>
            </div>

            {/* Table Panel */}
            <div className="panel !p-0 overflow-hidden shadow-sm flex flex-col mb-8">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50/50 border-b border-[var(--line)]">
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider">Staff Member</th>
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider">Role</th>
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider">MFA</th>
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider">Last Sign-in</th>
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider">Status</th>
                      <th className="px-4 py-3 text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider w-10 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)] bg-white text-[13px]">
                    {STAFF_DATA.map((staff) => (
                      <tr key={staff.id} className="hover:bg-gray-50/50 transition-colors group">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[var(--sage-mid)] text-[var(--navy)] flex items-center justify-center font-semibold text-[11px] shrink-0">
                              {staff.initials}
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium text-[var(--navy)] truncate">{staff.name}</span>
                              <span className="text-[12px] text-[var(--muted)] truncate">{staff.email}</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${getRoleColor(staff.role)}`}>
                            {staff.role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {staff.mfa ? (
                            <div className="flex items-center gap-1.5 text-emerald-600">
                              <CheckCircle2 size={14} />
                              <span className="text-[12px] font-medium">Enabled</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-amber-600">
                              <AlertTriangle size={14} />
                              <span className="text-[12px] font-medium">Not enrolled</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          {staff.lastSignIn}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${getStatusColor(staff.status)}`}>
                            {staff.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button className="p-1.5 text-[var(--muted)] hover:text-[var(--navy)] hover:bg-gray-100 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all">
                            <MoreHorizontal size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-[var(--line)] bg-gray-50 flex items-center justify-between text-[12px] text-[var(--muted)]">
                <span>Showing 1-12 of 23 staff members</span>
                <div className="flex items-center gap-2">
                  <button className="px-2 py-1 rounded hover:bg-gray-200 disabled:opacity-50" disabled>Previous</button>
                  <button className="px-2 py-1 rounded hover:bg-gray-200">Next</button>
                </div>
              </div>
            </div>
            
          </div>

          {/* Right Rail */}
          <div className="w-[280px] shrink-0 flex flex-col gap-4">
            
            <div className="panel p-4 flex flex-col gap-3 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-[var(--sage)]"></div>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-[var(--sage)] bg-[var(--sage-soft)] p-1.5 rounded">
                  <Shield size={16} />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-[var(--navy)] m-0">Roles &amp; Permissions</h3>
                  <p className="text-[12px] text-[var(--muted)] mt-1 mb-3">Supabase RLS currently enforces 3 system roles across all tables.</p>
                  <a href="#" className="text-[12px] font-medium text-[var(--sage)] hover:underline flex items-center gap-1">
                    Manage role definitions
                  </a>
                </div>
              </div>
            </div>

            <div className="panel p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-[var(--muted)] bg-gray-100 p-1.5 rounded">
                  <Activity size={16} />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-[var(--navy)] m-0">Audit Logs</h3>
                  <p className="text-[12px] text-[var(--muted)] mt-1 mb-2">Review 142 system events logged today, including PHI access.</p>
                  <a href="#" className="text-[12px] font-medium text-[var(--navy)] border border-[var(--line)] rounded px-2 py-1 inline-flex items-center hover:bg-gray-50 transition-colors">
                    Open event log
                  </a>
                </div>
              </div>
            </div>

            <div className="panel p-4 flex flex-col gap-3 bg-blue-50/50 border-blue-100">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 text-blue-600 bg-blue-100 p-1.5 rounded">
                  <Clock size={16} />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-blue-900 m-0">Pending Invites</h3>
                  <p className="text-[12px] text-blue-700 mt-1 mb-2">2 staff members haven't accepted their invitations yet.</p>
                  <a href="#" className="text-[12px] font-medium text-blue-700 hover:underline flex items-center gap-1">
                    Resend invitations
                  </a>
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </Shell>
  );
}
