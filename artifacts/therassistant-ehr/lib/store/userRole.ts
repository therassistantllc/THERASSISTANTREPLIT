"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AppRole, normalizeRole } from "@/lib/navigation/roles";

type UserRoleState = {
  role: AppRole;
  setRole: (role: AppRole) => void;
};

export const useUserRole = create<UserRoleState>()(
  persist(
    (set) => ({
      role: "admin_biller",
      setRole: (role) => set({ role: normalizeRole(role) }),
    }),
    {
      name: "therassistant-user-role",
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const raw = sessionStorage.getItem(name);
          return raw ? JSON.parse(raw) : null;
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          sessionStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          sessionStorage.removeItem(name);
        },
      },
    },
  ),
);
