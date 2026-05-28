/**
 * Mailroom filing — pure state/payload helpers shared by the filing UI.
 *
 * Extracted from MailroomItemClient so the filing-disabled rules and the
 * destination → entity-type mapping can be unit-tested without rendering React.
 */

import type { MailroomSearchType } from "./search";

export type FilingDestination =
  | "patient_chart"
  | "claim"
  | "encounter"
  | "practice_documents";

export const DESTINATION_TO_ENTITY: Record<
  Exclude<FilingDestination, "practice_documents">,
  MailroomSearchType
> = {
  patient_chart: "client",
  claim: "claim",
  encounter: "encounter",
};

export function destinationRequiresTarget(destination: FilingDestination): boolean {
  return destination !== "practice_documents";
}

export function getEntityTypeForDestination(
  destination: FilingDestination,
): MailroomSearchType | null {
  if (!destinationRequiresTarget(destination)) return null;
  return DESTINATION_TO_ENTITY[destination as Exclude<FilingDestination, "practice_documents">];
}

export type CanFileInput = {
  filing: boolean;
  itemStatus: string | null | undefined;
  destination: FilingDestination;
  selectedEntityId: string | null | undefined;
};

/**
 * Single source of truth for whether the "File Document" button is enabled.
 * The rule: not already submitting, the item is not already filed, and — if
 * the destination needs a target — an entity has been picked. This is what
 * keeps the submit-while-empty regression from coming back.
 */
export function canFileDocument(input: CanFileInput): boolean {
  if (input.filing) return false;
  if (input.itemStatus === "filed") return false;
  if (destinationRequiresTarget(input.destination) && !input.selectedEntityId) return false;
  return true;
}

export type FilePayloadInput = {
  organizationId: string;
  mailroomItemId: string;
  destination: FilingDestination;
  selectedEntityId: string | null | undefined;
  adminComments: string;
};

export type FilePayload = {
  organization_id: string;
  mailroom_item_id: string;
  filing_destination: FilingDestination;
  target_id: string | null;
  admin_comments: string;
};

/**
 * Builds the POST body for /api/mailroom/file. The picker always hands us the
 * resolved UUID via `selectedEntityId`; we never send raw user input.
 */
export function buildFilePayload(input: FilePayloadInput): FilePayload {
  return {
    organization_id: input.organizationId,
    mailroom_item_id: input.mailroomItemId,
    filing_destination: input.destination,
    target_id: input.selectedEntityId ?? null,
    admin_comments: input.adminComments,
  };
}
