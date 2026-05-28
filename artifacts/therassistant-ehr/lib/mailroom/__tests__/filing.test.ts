/**
 * Tests for the mailroom item detail page filing flow (Task #151).
 *
 * The interactive bits of MailroomItemClient that matter for "submit-while-empty"
 * and "switching destination clears the previous selection" are pure rules:
 *
 *   - destinationRequiresTarget / getEntityTypeForDestination drive whether
 *     the EntityPicker is rendered at all.
 *   - canFileDocument is the single rule the File button's `disabled` reads.
 *   - buildFilePayload is what the POST body is built from — it always sends
 *     the resolved UUID, never the user's raw input.
 *
 * We unit-test those rules here, plus a regression source-pin on the React
 * component so the destination → reset useEffect, the picker → setter wiring,
 * and the canFile guard can't silently disappear.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  buildFilePayload,
  canFileDocument,
  destinationRequiresTarget,
  DESTINATION_TO_ENTITY,
  getEntityTypeForDestination,
} from "../filing";

describe("destination → entity-type mapping", () => {
  it("maps each non-practice destination to the matching search type", () => {
    assert.equal(DESTINATION_TO_ENTITY.patient_chart, "client");
    assert.equal(DESTINATION_TO_ENTITY.claim, "claim");
    assert.equal(DESTINATION_TO_ENTITY.encounter, "encounter");
  });

  it("getEntityTypeForDestination returns null for practice-level filing", () => {
    assert.equal(getEntityTypeForDestination("practice_documents"), null);
    assert.equal(destinationRequiresTarget("practice_documents"), false);
  });

  it("getEntityTypeForDestination returns the correct entity type for each chart destination", () => {
    assert.equal(getEntityTypeForDestination("patient_chart"), "client");
    assert.equal(getEntityTypeForDestination("claim"), "claim");
    assert.equal(getEntityTypeForDestination("encounter"), "encounter");
    assert.equal(destinationRequiresTarget("patient_chart"), true);
    assert.equal(destinationRequiresTarget("claim"), true);
    assert.equal(destinationRequiresTarget("encounter"), true);
  });
});

describe("canFileDocument — the rule behind the File button's disabled state", () => {
  it("is FALSE when a target is required but no entity is picked (submit-while-empty guard)", () => {
    for (const destination of ["patient_chart", "claim", "encounter"] as const) {
      assert.equal(
        canFileDocument({ filing: false, itemStatus: "needs_review", destination, selectedEntityId: null }),
        false,
        `${destination} must not be fileable without a picked entity`,
      );
      assert.equal(
        canFileDocument({ filing: false, itemStatus: "needs_review", destination, selectedEntityId: "" }),
        false,
        `${destination} must treat empty-string id as unpicked`,
      );
    }
  });

  it("is TRUE once an entity is picked for a target-required destination", () => {
    assert.equal(
      canFileDocument({
        filing: false,
        itemStatus: "needs_review",
        destination: "claim",
        selectedEntityId: "claim-uuid-1",
      }),
      true,
    );
  });

  it("is TRUE for practice_documents even without any picked entity", () => {
    assert.equal(
      canFileDocument({
        filing: false,
        itemStatus: "needs_review",
        destination: "practice_documents",
        selectedEntityId: null,
      }),
      true,
    );
  });

  it("is FALSE while a submit is already in-flight (prevents double-file)", () => {
    assert.equal(
      canFileDocument({
        filing: true,
        itemStatus: "needs_review",
        destination: "practice_documents",
        selectedEntityId: null,
      }),
      false,
    );
  });

  it("is FALSE once the item is already filed", () => {
    assert.equal(
      canFileDocument({
        filing: false,
        itemStatus: "filed",
        destination: "practice_documents",
        selectedEntityId: null,
      }),
      false,
    );
  });
});

describe("buildFilePayload — the POST body shape", () => {
  it("always posts the resolved UUID (never raw user input) and the structured destination", () => {
    const body = buildFilePayload({
      organizationId: "org-1",
      mailroomItemId: "item-1",
      destination: "claim",
      selectedEntityId: "claim-uuid-1",
      adminComments: "see payer EOB",
    });
    assert.deepEqual(body, {
      organization_id: "org-1",
      mailroom_item_id: "item-1",
      filing_destination: "claim",
      target_id: "claim-uuid-1",
      admin_comments: "see payer EOB",
    });
  });

  it("nulls out target_id when no entity is selected (practice_documents path)", () => {
    const body = buildFilePayload({
      organizationId: "org-1",
      mailroomItemId: "item-1",
      destination: "practice_documents",
      selectedEntityId: null,
      adminComments: "",
    });
    assert.equal(body.target_id, null);
    assert.equal(body.filing_destination, "practice_documents");
  });
});

describe("regression: MailroomItemClient wires the picker to the rules", () => {
  // Source-pin so refactors can't silently drop the destination-change reset,
  // the canFileDocument guard, or the buildFilePayload call. These are the
  // exact behaviors the task acceptance criteria call out.
  const src = readFileSync("app/mailroom/[itemId]/MailroomItemClient.tsx", "utf8");

  it("clears the selected entity whenever the filing destination changes", () => {
    // The useEffect must depend on filingDestination AND call setSelectedEntity(null).
    assert.match(src, /useEffect\([^]*setSelectedEntity\(null\)[^]*\[filingDestination\]/);
  });

  it("the File button's disabled prop is driven by canFileDocument", () => {
    assert.match(src, /canFileDocument\s*\(/);
    assert.match(src, /disabled=\{!canFile\}/);
  });

  it("posts the resolved entity id via buildFilePayload (not a hand-rolled object)", () => {
    assert.match(src, /buildFilePayload\s*\(/);
    assert.match(src, /selectedEntityId:\s*selectedEntity\?\.id\s*\?\?\s*null/);
  });

  it("renders the EntityPicker only for destinations that require a target", () => {
    assert.match(src, /requiresTarget\s*&&\s*entityType\s*\?/);
    assert.match(src, /<EntityPicker[^]*entityType=\{entityType\}/);
  });
});

describe("regression: EntityPicker resets when its entityType prop changes", () => {
  const src = readFileSync("app/mailroom/[itemId]/EntityPicker.tsx", "utf8");

  it("clears query/results/open/active/error on entityType change (no stale results across types)", () => {
    assert.match(src, /useEffect\([^]*setQuery\(""\)[^]*setResults\(\[\]\)[^]*\[entityType\]/);
  });

  it("renders the chip view (not the input) when a value is selected", () => {
    assert.match(src, /if \(value\) \{[^]*entity-picker-chip/);
  });
});
