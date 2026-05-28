import React from "react";
import { 
  APPOINTMENTS, 
  SUMMARY, 
  DATE_LABEL, 
  type ScheduleAppointment, 
  type AppointmentStatus 
} from "./_data";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Clock, 
  Video, 
  MapPin, 
  AlertTriangle, 
  CheckCircle2, 
  DollarSign, 
  Calendar as CalendarIcon, 
  Filter, 
  Search, 
  Plus, 
  MoreHorizontal,
  MessageSquare,
  FileSignature,
  FileText
} from "lucide-react";

type ColumnDef = {
  id: string;
  title: string;
  statuses: AppointmentStatus[];
  icon: React.ElementType;
  colorClass: string;
  bgClass: string;
};

const COLUMNS: ColumnDef[] = [
  { 
    id: "upcoming", 
    title: "Upcoming", 
    statuses: ["scheduled"],
    icon: Clock,
    colorClass: "text-slate-500",
    bgClass: "bg-slate-100/50"
  },
  { 
    id: "waiting", 
    title: "Checked In / Waiting", 
    statuses: ["checked_in"],
    icon: MapPin,
    colorClass: "text-amber-500",
    bgClass: "bg-amber-50/50"
  },
  { 
    id: "in_session", 
    title: "In Session", 
    statuses: ["in_session"],
    icon: Video,
    colorClass: "text-emerald-500",
    bgClass: "bg-emerald-50/50"
  },
  { 
    id: "wrap_up", 
    title: "Wrap-up (Needs Action)", 
    statuses: ["needs_signature"],
    icon: FileSignature,
    colorClass: "text-indigo-500",
    bgClass: "bg-indigo-50/50"
  },
  { 
    id: "done", 
    title: "Done / No-show", 
    statuses: ["completed", "no_show", "cancelled"],
    icon: CheckCircle2,
    colorClass: "text-slate-400",
    bgClass: "bg-slate-50"
  },
];

function AppointmentCard({ appt }: { appt: ScheduleAppointment }) {
  const isTelehealth = appt.location === "Telehealth";
  
  return (
    <Card className="mb-3 overflow-hidden border-slate-200 shadow-sm hover:shadow-md transition-shadow group relative cursor-pointer">
      <div className="absolute top-0 left-0 w-1 h-full bg-slate-200 group-hover:bg-slate-300 transition-colors" />
      
      {appt.alerts.length > 0 && (
        <div className="absolute top-0 left-0 w-1 h-full bg-red-400" />
      )}
      
      <div className="p-3 pl-4">
        <div className="flex justify-between items-start mb-1">
          <div className="font-semibold text-sm text-slate-900 truncate pr-2">
            {appt.patientName}
          </div>
          <div className="flex-shrink-0 text-xs font-medium text-slate-500 flex items-center gap-1">
            {appt.timeStart}
          </div>
        </div>
        
        <div className="flex items-center text-xs text-slate-500 mb-2.5">
          <span className="truncate">{appt.type}</span>
          <span className="mx-1.5 opacity-50">•</span>
          <span className="truncate">{appt.provider.split(',')[0]}</span>
        </div>
        
        {appt.alerts.length > 0 && (
          <div className="mb-2.5 space-y-1">
            {appt.alerts.map((alert, i) => (
              <div key={i} className={`flex items-start gap-1.5 text-xs px-2 py-1 rounded-md ${
                alert.tone === 'red' ? 'bg-red-50 text-red-700' :
                alert.tone === 'amber' ? 'bg-amber-50 text-amber-700' :
                alert.tone === 'blue' ? 'bg-blue-50 text-blue-700' :
                'bg-purple-50 text-purple-700'
              }`}>
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="leading-tight font-medium">{alert.text}</span>
              </div>
            ))}
          </div>
        )}
        
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
          <div className="flex gap-1.5">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-slate-100 text-slate-600 hover:bg-slate-200 font-medium">
              {isTelehealth ? (
                <span className="flex items-center gap-1"><Video className="w-3 h-3" /> Telehealth</span>
              ) : (
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> Office</span>
              )}
            </Badge>
          </div>
          
          <div className="flex">
            {appt.status === 'scheduled' && (
              <Button size="sm" variant="outline" className="h-6 text-xs px-2 shadow-none border-slate-200">
                Check In
              </Button>
            )}
            {appt.status === 'checked_in' && (
              <Button size="sm" className="h-6 text-xs px-2 shadow-none bg-emerald-600 hover:bg-emerald-700">
                Start Session
              </Button>
            )}
            {appt.status === 'in_session' && (
              <Button size="sm" variant="outline" className="h-6 text-xs px-2 shadow-none border-slate-200">
                End Session
              </Button>
            )}
            {appt.status === 'needs_signature' && (
              <Button size="sm" className="h-6 text-xs px-2 shadow-none bg-indigo-600 hover:bg-indigo-700">
                Sign Note
              </Button>
            )}
            {(appt.status === 'completed' || appt.status === 'no_show') && (
              <Button size="icon" variant="ghost" className="h-6 w-6 text-slate-400 hover:text-slate-600">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function StatusPipelineBoard() {
  // Distribute appointments into columns
  const columnData = COLUMNS.map(col => ({
    ...col,
    appointments: APPOINTMENTS.filter(appt => col.statuses.includes(appt.status))
      .sort((a, b) => a.startMinutes - b.startMinutes)
  }));

  return (
    <div className="min-h-screen bg-white flex flex-col font-sans text-slate-900">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style dangerouslySetInnerHTML={{__html: `
        .font-sans { font-family: 'Inter', sans-serif; }
        /* Custom scrollbar for kanban board */
        .kanban-scroll::-webkit-scrollbar { height: 8px; width: 8px; }
        .kanban-scroll::-webkit-scrollbar-track { background: transparent; }
        .kanban-scroll::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 20px; }
      `}} />

      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-6 py-4 flex items-center justify-between shrink-0 sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Schedule Pipeline</h1>
            <p className="text-sm text-slate-500 flex items-center gap-1.5 mt-0.5">
              <CalendarIcon className="w-3.5 h-3.5" />
              {DATE_LABEL}
            </p>
          </div>
          
          <div className="h-8 w-px bg-slate-200 mx-2 hidden md:block"></div>
          
          <div className="hidden md:flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-50 border border-slate-100 text-sm">
              <span className="font-semibold text-slate-700">{SUMMARY.total}</span>
              <span className="text-slate-500 text-xs">Total</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-100 text-sm">
              <span className="font-semibold text-amber-700">{SUMMARY.unsigned}</span>
              <span className="text-amber-600 text-xs">Unsigned</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 border border-red-100 text-sm">
              <span className="font-semibold text-red-700">{SUMMARY.noShow}</span>
              <span className="text-red-600 text-xs">No-show</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="relative hidden md:block w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Find client..." 
              className="w-full h-9 pl-9 pr-4 text-sm bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-shadow"
            />
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 shadow-none border-slate-200 text-slate-600">
            <Filter className="w-4 h-4" />
            <span className="hidden sm:inline">Filter</span>
          </Button>
          <Button size="sm" className="h-9 gap-1.5 bg-slate-900 hover:bg-slate-800 text-white shadow-none">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Appt</span>
          </Button>
        </div>
      </header>

      {/* Board */}
      <main className="flex-1 overflow-x-auto overflow-y-hidden kanban-scroll bg-white">
        <div className="flex h-full p-6 gap-6 min-w-max items-start">
          {columnData.map((col) => (
            <div key={col.id} className={`w-80 shrink-0 flex flex-col max-h-full rounded-xl border border-slate-200/60 ${col.bgClass}`}>
              {/* Column Header */}
              <div className="p-3.5 pb-2 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <col.icon className={`w-4 h-4 ${col.colorClass}`} />
                  <h2 className="font-medium text-sm text-slate-700">{col.title}</h2>
                </div>
                <Badge variant="secondary" className="bg-white/60 text-slate-600 font-medium px-1.5 py-0 h-5">
                  {col.appointments.length}
                </Badge>
              </div>
              
              {/* Column Content */}
              <div className="p-3 pt-1 overflow-y-auto kanban-scroll flex-1">
                {col.appointments.length > 0 ? (
                  col.appointments.map((appt) => (
                    <AppointmentCard key={appt.id} appt={appt} />
                  ))
                ) : (
                  <div className="h-24 flex items-center justify-center border-2 border-dashed border-slate-200/50 rounded-lg bg-white/30 text-xs text-slate-400 font-medium">
                    No appointments
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
