// File: lib/store/activeContext.ts
// Global Active Context Store for THERASSISTANT EHR/PM
// Tracks the currently active patient, appointment, and encounter across all pages.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Active Context State
 * 
 * This represents the "operational focus" of the user at any given moment.
 * When a user clicks an appointment, patient, or encounter anywhere in the system,
 * that selection updates this global state, and all pages react accordingly.
 */
interface ActiveContextState {
  // Core identifiers
  organizationId: string | null;
  patientId: string | null;
  appointmentId: string | null;
  encounterId: string | null;

  // Optional metadata (for display/debugging)
  patientName?: string | null;
  appointmentDate?: string | null;
  encounterStatus?: string | null;

  // Actions
  setContext: (partial: Partial<Omit<ActiveContextState, 'setContext' | 'clearContext' | 'clearAppointment' | 'clearEncounter'>>) => void;
  clearContext: () => void;
  clearAppointment: () => void;
  clearEncounter: () => void;
}

/**
 * Global Active Context Store
 * 
 * Usage:
 * 
 * // Setting context from Scheduling page
 * const { setContext } = useActiveContext();
 * setContext({ 
 *   patientId: appointment.client_id, 
 *   appointmentId: appointment.id,
 *   patientName: appointment.client?.name 
 * });
 * 
 * // Reading context from Billing page
 * const { patientId, appointmentId, encounterId } = useActiveContext();
 * 
 * // Clearing appointment but keeping patient
 * const { clearAppointment } = useActiveContext();
 * clearAppointment();
 * 
 * // Full reset
 * const { clearContext } = useActiveContext();
 * clearContext();
 */
export const useActiveContext = create<ActiveContextState>()(
  persist(
    (set) => ({
      // Initial state
      organizationId: null,
      patientId: null,
      appointmentId: null,
      encounterId: null,
      patientName: null,
      appointmentDate: null,
      encounterStatus: null,

      // Merge updates into state
      setContext: (partial) => {
        set((state) => {
          const newState = { ...state, ...partial };

          // Validation rules:
          // 1. If setting an encounterId, must have a patientId
          if (partial.encounterId && !newState.patientId) {
            console.warn('[ActiveContext] Cannot set encounterId without patientId');
            return state;
          }

          // 2. If setting an appointmentId, must have a patientId
          if (partial.appointmentId && !newState.patientId) {
            console.warn('[ActiveContext] Cannot set appointmentId without patientId');
            return state;
          }

          console.log('[ActiveContext] Updated:', {
            patientId: newState.patientId,
            appointmentId: newState.appointmentId,
            encounterId: newState.encounterId,
          });

          return newState;
        });
      },

      // Clear all context
      clearContext: () => {
        console.log('[ActiveContext] Cleared all context');
        set({
          organizationId: null,
          patientId: null,
          appointmentId: null,
          encounterId: null,
          patientName: null,
          appointmentDate: null,
          encounterStatus: null,
        });
      },

      // Clear appointment and encounter, but keep patient
      clearAppointment: () => {
        console.log('[ActiveContext] Cleared appointment (kept patient)');
        set((state) => ({
          ...state,
          appointmentId: null,
          encounterId: null,
          appointmentDate: null,
          encounterStatus: null,
        }));
      },

      // Clear encounter, but keep patient and appointment
      clearEncounter: () => {
        console.log('[ActiveContext] Cleared encounter (kept patient and appointment)');
        set((state) => ({
          ...state,
          encounterId: null,
          encounterStatus: null,
        }));
      },
    }),
    {
      name: 'therassistant-active-context',
      // Use sessionStorage so context clears when browser closes
      // Change to localStorage if you want persistence across sessions
      storage: {
        getItem: (name) => {
          const str = sessionStorage.getItem(name);
          return str ? JSON.parse(str) : null;
        },
        setItem: (name, value) => {
          sessionStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          sessionStorage.removeItem(name);
        },
      },
    }
  )
);

/**
 * Convenience hook to check if any context is active
 */
export function useHasActiveContext() {
  const { patientId, appointmentId, encounterId } = useActiveContext();
  return patientId !== null || appointmentId !== null || encounterId !== null;
}

/**
 * Convenience hook to get a human-readable context summary
 */
export function useActiveContextSummary() {
  const { patientId, patientName, appointmentId, appointmentDate, encounterId, encounterStatus } = useActiveContext();

  if (!patientId && !appointmentId && !encounterId) {
    return 'No active context';
  }

  const parts: string[] = [];
  
  if (patientName) {
    parts.push(`Patient: ${patientName}`);
  } else if (patientId) {
    parts.push(`Patient: ${patientId.slice(0, 8)}`);
  }

  if (appointmentDate) {
    parts.push(`Appt: ${appointmentDate}`);
  } else if (appointmentId) {
    parts.push(`Appt: ${appointmentId.slice(0, 8)}`);
  }

  if (encounterStatus) {
    parts.push(`Encounter: ${encounterStatus}`);
  } else if (encounterId) {
    parts.push(`Encounter: ${encounterId.slice(0, 8)}`);
  }

  return parts.join(' • ');
}
