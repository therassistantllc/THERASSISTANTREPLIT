/**
 * Coverage for the universal WorkqueueShell that powers all 37 billing
 * pages. The shell ships five behaviors that every queue silently
 * depends on, so a regression here would silently break every page at
 * once:
 *
 *   1. Filter values <-> URL round-trip under `filterUrlNamespace`
 *      (preserves unrelated query params, strips empties).
 *   2. `selectedRowId` actually drives what the right-side detail
 *      pane renders (no selection -> empty hint; with selection ->
 *      the active tab's content).
 *   3. The `renderDetail` escape hatch wins over `detailTabs` when
 *      both are provided (used by queues that own their own editor).
 *   4. Summary metric `tone` ("amber"/"red"/"green") maps to the
 *      right CSS class so urgent counts stay visually loud.
 *   5. `hideDetailPane` actually collapses the right column for
 *      queues that don't need a detail pane (Charge Capture etc.).
 *
 * Behaviors 2–5 are pinned via `react-dom/server`'s `renderToString`
 * (effects don't run, but the markup the shell emits on first render
 * is exactly what these props control). Behavior 1 is pinned against
 * the pure URL helpers the hook delegates to — testing the hook
 * itself would require a real DOM + Next router, which the EHR test
 * suite doesn't have.
 *
 * If anyone changes the URL serialization, the detail-pane priority,
 * the summary tone class, or makes hideDetailPane stop hiding, this
 * test catches it before billers see a broken queue.
 */
import { strict as assert } from "node:assert";
import { before, test, mock } from "node:test";
import { createElement } from "react";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

// CSS-module imports can't be loaded by Node. The experimental test
// module mocks layer doesn't fall through to `Module._extensions`, and
// Proxy traps don't survive being passed through `defaultExport` — so
// we stub the CSS module with an explicit identity object covering
// every class the shell reads. Each value equals its key so we can
// assert against well-known class names like `summaryRed`. Keep this
// list in sync with the shell's `styles.*` references.
const STYLE_KEYS = [
  "shell", "header", "headerText", "headerTitle", "headerDesc",
  "headerActions", "primaryBtn", "secondaryBtn", "dangerBtn",
  "successBtn", "message", "messageSuccess", "messageError",
  "summaryStrip", "summaryCard", "summaryValue", "summaryLabel",
  "summaryAmber", "summaryRed", "summaryGreen", "filterRail",
  "filterGroup", "filterLabel", "filterSelect", "filterInput",
  "filterClear", "body", "tablePane", "table", "tableLoading",
  "tableEmpty", "rowSelected", "detailPane", "detailTabs",
  "detailTab", "detailTabActive", "detailBody", "detailEmpty",
  "detailActions",
] as const;
const styleStub: Record<string, string> = Object.fromEntries(
  STYLE_KEYS.map((k) => [k, k]),
);
const cssAbs = resolvePath(__dirname, "../WorkqueueShell.module.css");
mock.module(pathToFileURL(cssAbs).href, {
  defaultExport: styleStub,
  namedExports: { default: styleStub },
  cache: true,
});

// next/navigation isn't available outside the Next runtime; provide
// the three hooks the shell touches. The shell only calls them from
// `useUrlFilterSync`, whose effects don't run under SSR, so these
// stubs just need to be defined.
mock.module("next/navigation", {
  namedExports: {
    useRouter: () => ({ replace: () => {}, push: () => {} }),
    usePathname: () => "/billing/test",
    useSearchParams: () => new URLSearchParams(""),
  },
});

let renderToString: (el: unknown) => string;
let Shell: typeof import("../WorkqueueShell").default;
let helpers: typeof import("../WorkqueueShell");

before(async () => {
  const rdom = await import("react-dom/server");
  renderToString = rdom.renderToString as (el: unknown) => string;
  const mod = await import("../WorkqueueShell");
  Shell = mod.default;
  helpers = mod;
});

// ─── 1. Filter <-> URL round-trip ─────────────────────────────────────────

test("readFiltersFromUrl pulls only this namespace's keys and strips the prefix", () => {
  const search = new URLSearchParams("cb_status=open&cb_payer=BCBS&other=keep");
  const got = helpers.readFiltersFromUrl("cb", search);
  assert.deepEqual(got, { status: "open", payer: "BCBS" });
});

test("writeFiltersToParams preserves unrelated keys and drops empty values", () => {
  const current = new URLSearchParams("cb_status=stale&unrelated=keep");
  const next = helpers.writeFiltersToParams(
    "cb",
    { status: "open", payer: "BCBS", note: "" },
    current,
  );
  // Unrelated key survives.
  assert.equal(next.get("unrelated"), "keep");
  // Old namespaced value replaced.
  assert.equal(next.get("cb_status"), "open");
  assert.equal(next.get("cb_payer"), "BCBS");
  // Empty value dropped.
  assert.equal(next.get("cb_note"), null);
});

test("filter values round-trip through the URL helpers", () => {
  const values = { status: "open", payer: "BCBS" };
  const written = helpers.writeFiltersToParams("cb", values, new URLSearchParams(""));
  const readBack = helpers.readFiltersFromUrl("cb", written);
  assert.deepEqual(readBack, values);
});

test("urlMatchesFilters is true only when our slice already matches exactly", () => {
  const search = new URLSearchParams("cb_status=open&cb_payer=BCBS&other=x");
  assert.equal(
    helpers.urlMatchesFilters("cb", { status: "open", payer: "BCBS" }, search),
    true,
  );
  assert.equal(
    helpers.urlMatchesFilters("cb", { status: "stale", payer: "BCBS" }, search),
    false,
  );
  // Extra key in URL that's missing from values -> not a match.
  assert.equal(
    helpers.urlMatchesFilters("cb", { status: "open" }, search),
    false,
  );
});

// ─── Render-based tests ───────────────────────────────────────────────────

type Row = { id: string; name: string };
const ROWS: Row[] = [
  { id: "r1", name: "Alice" },
  { id: "r2", name: "Bob" },
];

type ShellProps = Parameters<typeof Shell<Row>>[0];

function renderShell(overrides: Partial<ShellProps>): string {
  const base: ShellProps = {
    title: "Test Queue",
    rows: ROWS,
    columns: [{ id: "name", header: "Name", cell: (r: Row) => r.name }],
    rowId: (r: Row) => r.id,
  };
  const props = { ...base, ...overrides };
  // Shell is a generic FC; `createElement` widens TRow. Cast props.
  return renderToString(
    createElement(Shell as unknown as React.FC<Record<string, unknown>>, props as unknown as Record<string, unknown>),
  );
}

// ─── 2. Row selection drives the detail pane ────────────────────────────

test("with no selectedRowId, detail pane shows the empty hint", () => {
  const html = renderShell({
    detailTabs: [
      { id: "summary", label: "Summary", render: () => createElement("div", null, "SUMMARY_BODY") },
    ],
  });
  assert.match(html, /Select a row to see details\./);
  assert.equal(html.includes("SUMMARY_BODY"), false);
});

test("with selectedRowId, the active detail tab's content renders", () => {
  const html = renderShell({
    selectedRowId: "r1",
    detailTabs: [
      { id: "summary", label: "Summary", render: () => createElement("div", null, "SUMMARY_BODY") },
      { id: "history", label: "History", render: () => createElement("div", null, "HISTORY_BODY") },
    ],
  });
  // First tab is active by default; only its body renders.
  assert.match(html, /SUMMARY_BODY/);
  assert.equal(html.includes("HISTORY_BODY"), false);
  assert.equal(html.includes("Select a row to see details"), false);
});

// ─── 3. renderDetail escape hatch wins over detailTabs ──────────────────

test("renderDetail wins over detailTabs when both are provided", () => {
  let renderDetailCalls = 0;
  let tabRendered = false;
  const html = renderShell({
    selectedRowId: "r2",
    detailTabs: [
      {
        id: "summary",
        label: "Summary",
        render: () => {
          tabRendered = true;
          return createElement("div", null, "TAB_BODY");
        },
      },
    ],
    renderDetail: (rowId) => {
      renderDetailCalls += 1;
      return createElement("div", null, `ESCAPE_HATCH_${rowId}`);
    },
  });
  assert.equal(renderDetailCalls, 1);
  assert.equal(tabRendered, false);
  assert.match(html, /ESCAPE_HATCH_r2/);
  assert.equal(html.includes("TAB_BODY"), false);
});

// ─── 4. Summary tones map to the right class ─────────────────────────────

test("summary metric tones render with their tone-specific class", () => {
  const html = renderShell({
    summary: [
      { id: "count", label: "Count", value: 3 },
      { id: "urgent", label: "Urgent", value: 1, tone: "red" },
      { id: "due", label: "Due", value: 2, tone: "amber" },
      { id: "ok", label: "OK", value: 5, tone: "green" },
    ],
  });
  // styleProxy returns the key as the class name, so we can assert on
  // the well-known suffixes the shell uses (`summaryRed` / `summaryAmber`
  // / `summaryGreen`). Default tone gets none of those.
  assert.match(html, /summaryRed/);
  assert.match(html, /summaryAmber/);
  assert.match(html, /summaryGreen/);
  // Each label still shows up.
  assert.match(html, /Urgent/);
  assert.match(html, /Due/);
});

// ─── 5. hideDetailPane collapses the right column ───────────────────────

test("hideDetailPane omits the detail aside entirely", () => {
  const withPane = renderShell({
    selectedRowId: "r1",
    detailTabs: [{ id: "x", label: "X", render: () => createElement("div", null, "BODY") }],
  });
  // Sanity: the pane (an <aside>) is present by default.
  assert.match(withPane, /<aside\b/);

  const hidden = renderShell({
    selectedRowId: "r1",
    hideDetailPane: true,
    detailTabs: [{ id: "x", label: "X", render: () => createElement("div", null, "BODY") }],
  });
  assert.equal(hidden.includes("<aside"), false);
  // And the detail tab body must not be rendered when the pane is hidden.
  assert.equal(hidden.includes(">BODY<"), false);
});
