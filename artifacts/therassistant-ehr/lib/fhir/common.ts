// Shared FHIR R4 helpers and structural types used by every resource route.
// Lives alongside patient.ts (which keeps its Patient-specific types).

import { NextResponse } from "next/server";
import { requireAuthentication } from "@/lib/rbac/middleware";
import { operationOutcome } from "./patient";

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirReference {
  reference?: string;
  type?: string;
  display?: string;
  identifier?: { system?: string; value: string };
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirAttachment {
  contentType?: string;
  url?: string;
  title?: string;
  size?: number;
  creation?: string;
}

export function s(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const out = String(value).trim();
  return out ? out : undefined;
}

export function toFiniteInt(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// PostgREST .or() / .ilike() filter values are interpolated into a filter DSL
// where `,`, `(`, `)`, `:`, `*`, `%`, and quotes have special meaning. Strip
// anything outside a conservative allowlist so user input cannot break out of
// the intended filter expression.
export function safeTerm(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _.'\-]/g, "").trim().slice(0, 100);
}

// FHIR search params for references accept either a bare id or a typed
// "ResourceType/id" form. Strip the prefix for our SQL query.
export function stripRefPrefix(raw: string | null, prefix: string): string {
  if (!raw) return "";
  const v = raw.trim();
  if (v.toLowerCase().startsWith(prefix.toLowerCase() + "/")) return v.slice(prefix.length + 1);
  return v;
}

export function baseUrlOf(request: Request) {
  const { protocol, host } = new URL(request.url);
  return `${protocol}//${host}/api/fhir/R4`;
}

export type AuthOk = { kind: "ok"; organizationId: string };
export type AuthErr = { kind: "error"; response: Response };

/**
 * Reuse the existing `requireAuthentication` middleware that gates every
 * other protected EHR API, but translate the JSON 401/403 it returns into a
 * spec-shaped FHIR OperationOutcome.
 */
export async function requireFhirAuth(): Promise<AuthOk | AuthErr> {
  const auth = await requireAuthentication();
  if (auth instanceof NextResponse) {
    const status = auth.status;
    const code = status === 401 ? "login" : "forbidden";
    return {
      kind: "error",
      response: operationOutcome(
        "error",
        code,
        status === 401 ? "Not authenticated" : "Access denied",
        status,
      ),
    };
  }
  return { kind: "ok", organizationId: auth.organizationId };
}

// UUID v1..v5 shape — used to validate :id path params before touching the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
