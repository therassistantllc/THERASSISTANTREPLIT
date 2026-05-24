"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import styles from "./WorkqueueShell.module.css";

// ─── Public types ───────────────────────────────────────────────────────────

export interface SummaryMetric {
  id: string;
  label: string;
  value: ReactNode;
  tone?: "default" | "amber" | "red" | "green";
}

export type FilterKind = "text" | "select" | "date" | "number";

export interface FilterDef {
  id: string;
  label: string;
  kind: FilterKind;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  width?: number;
}

export interface ColumnDef<TRow> {
  id: string;
  header: ReactNode;
  cell: (row: TRow) => ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
}

export interface RowAction<TRow> {
  id: string;
  label: string;
  onClick: (row: TRow) => void;
  variant?: "default" | "primary" | "danger" | "success";
  disabled?: (row: TRow) => boolean;
}

export interface PrimaryAction {
  id: string;
  label: string;
  onClick: () => void;
  variant?: "default" | "primary" | "danger" | "success";
  disabled?: boolean;
}

export interface DetailTab {
  id: string;
  label: string;
  render: () => ReactNode;
}

export interface PrimaryTab {
  id: string;
  label: string;
  count?: number;
}

export interface WorkqueueShellProps<TRow> {
  title: string;
  description?: string;
  /** Primary header-level actions (Refresh, Release, etc.) */
  headerActions?: PrimaryAction[];
  /** Summary strip metrics (count, total $, oldest age, urgent count, …) */
  summary?: SummaryMetric[];
  /** Primary tabs rendered between the summary strip and filter rail. */
  primaryTabs?: PrimaryTab[];
  activePrimaryTabId?: string;
  onPrimaryTabChange?: (tabId: string) => void;
  /** Top filter rail */
  filters?: FilterDef[];
  filterValues?: Record<string, string>;
  onFilterChange?: (values: Record<string, string>) => void;
  /** Optional URL namespace — when set, filter values persist as ?<ns>_<id>= */
  filterUrlNamespace?: string;
  /** Rows + columns */
  rows: TRow[];
  columns: ColumnDef<TRow>[];
  rowId: (row: TRow) => string;
  loading?: boolean;
  emptyMessage?: string;
  selectedRowId?: string | null;
  onSelectRow?: (rowId: string | null) => void;
  /** When provided, enables multi-select with a checkbox column. */
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  rowActions?: RowAction<TRow>[];
  /** Right-side detail panel */
  detailTabs?: DetailTab[];
  detailActions?: PrimaryAction[];
  /** Escape hatch: render the entire detail body instead of using tabs. */
  renderDetail?: (selectedRowId: string) => ReactNode;
  /** Hide the right-side panel entirely. */
  hideDetailPane?: boolean;
  /** CSS width for the right-side panel. Default 480px. */
  detailPaneWidth?: string;
  /** Width for the left table pane (useful when the detail panel is the
   *  primary editor). Default flex:1. */
  tablePaneWidth?: string;
  /** Top-of-page message banner */
  message?: { tone: "success" | "error"; text: string } | null;
  /** Slot for page-owned modals/portals */
  overlay?: ReactNode;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buttonClass(variant?: PrimaryAction["variant"]): string {
  switch (variant) {
    case "primary": return styles.primaryBtn;
    case "danger": return styles.dangerBtn;
    case "success": return styles.successBtn;
    default: return styles.secondaryBtn;
  }
}

function rowActionClass(variant?: RowAction<unknown>["variant"]): string {
  switch (variant) {
    case "primary": return styles.primaryBtn;
    case "danger": return styles.dangerBtn;
    case "success": return styles.successBtn;
    default: return styles.secondaryBtn;
  }
}

/**
 * Read this shell's slice of namespaced filter values out of a URL
 * search params object. Keys are stripped of the `${namespace}_` prefix.
 * Pure (no React) so it's easy to unit-test.
 */
export function readFiltersFromUrl(
  namespace: string,
  search: URLSearchParams | null | undefined,
): Record<string, string> {
  const prefix = `${namespace}_`;
  const out: Record<string, string> = {};
  for (const [k, v] of (search?.entries() ?? [])) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/**
 * Produce the next URLSearchParams reflecting `values` under the given
 * namespace, preserving any keys outside the namespace. Empty/missing
 * values are dropped from the URL. Pure (no React).
 */
export function writeFiltersToParams(
  namespace: string,
  values: Record<string, string> | undefined,
  current: URLSearchParams | null | undefined,
): URLSearchParams {
  const next = new URLSearchParams(current?.toString() ?? "");
  const prefix = `${namespace}_`;
  for (const key of Array.from(next.keys())) {
    if (key.startsWith(prefix)) next.delete(key);
  }
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v && v.length > 0) next.set(`${prefix}${k}`, v);
  }
  return next;
}

/** True when our slice of the URL already matches `values`. */
export function urlMatchesFilters(
  namespace: string,
  values: Record<string, string> | undefined,
  search: URLSearchParams | null | undefined,
): boolean {
  const fromUrl = readFiltersFromUrl(namespace, search);
  const v = values ?? {};
  const keys = Object.keys(v);
  if (Object.keys(fromUrl).length !== keys.length) return false;
  return keys.every((k) => fromUrl[k] === v[k]);
}

/**
 * Sync a record of filter values to URL query params under an optional
 * namespace. Re-reads on back/forward navigation. Skips empty strings.
 */
function useUrlFilterSync(
  namespace: string | undefined,
  values: Record<string, string> | undefined,
  onChange: ((v: Record<string, string>) => void) | undefined,
) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  // Push current values to URL (debounced via microtask coalescing).
  useEffect(() => {
    if (!namespace || !values) return;
    if (urlMatchesFilters(namespace, values, search)) return;
    const next = writeFiltersToParams(namespace, values, search);
    const nextStr = next.toString();
    router.replace(`${pathname}${nextStr ? `?${nextStr}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, JSON.stringify(values ?? {})]);

  // Pull URL values back when the URL changes externally (initial load,
  // back/forward). Only fires when our slice differs from `values`.
  useEffect(() => {
    if (!namespace || !onChange) return;
    if (urlMatchesFilters(namespace, values, search)) return;
    onChange(readFiltersFromUrl(namespace, search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, search?.toString()]);
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function WorkqueueShell<TRow>(props: WorkqueueShellProps<TRow>) {
  const {
    title,
    description,
    headerActions,
    summary,
    primaryTabs,
    activePrimaryTabId,
    onPrimaryTabChange,
    filters,
    filterValues,
    onFilterChange,
    filterUrlNamespace,
    rows,
    columns,
    rowId,
    loading,
    emptyMessage,
    selectedRowId,
    onSelectRow,
    selectedRowIds,
    onSelectionChange,
    rowActions,
    detailTabs,
    detailActions,
    renderDetail,
    hideDetailPane,
    detailPaneWidth,
    tablePaneWidth,
    message,
    overlay,
  } = props;

  useUrlFilterSync(filterUrlNamespace, filterValues, onFilterChange);

  const [activeTabId, setActiveTabId] = useState<string | null>(
    detailTabs && detailTabs.length > 0 ? detailTabs[0].id : null,
  );

  useEffect(() => {
    if (!detailTabs || detailTabs.length === 0) {
      setActiveTabId(null);
      return;
    }
    if (!activeTabId || !detailTabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(detailTabs[0].id);
    }
  }, [detailTabs, activeTabId]);

  const activeTab = useMemo(
    () => detailTabs?.find((t) => t.id === activeTabId) ?? null,
    [detailTabs, activeTabId],
  );

  const selectionEnabled = !!onSelectionChange;
  const selectedSet = useMemo(
    () => new Set(selectedRowIds ?? []),
    [selectedRowIds],
  );
  const visibleIds = useMemo(() => rows.map((r) => rowId(r)), [rows, rowId]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selectedSet.has(id));

  const toggleRow = useCallback(
    (id: string) => {
      if (!onSelectionChange) return;
      const next = new Set(selectedSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange([...next]);
    },
    [onSelectionChange, selectedSet],
  );

  const toggleAllVisible = useCallback(() => {
    if (!onSelectionChange) return;
    if (allVisibleSelected) {
      const next = new Set(selectedSet);
      for (const id of visibleIds) next.delete(id);
      onSelectionChange([...next]);
    } else {
      const next = new Set(selectedSet);
      for (const id of visibleIds) next.add(id);
      onSelectionChange([...next]);
    }
  }, [onSelectionChange, allVisibleSelected, selectedSet, visibleIds]);

  const colSpan =
    columns.length +
    (rowActions && rowActions.length > 0 ? 1 : 0) +
    (selectionEnabled ? 1 : 0);

  const setFilter = useCallback(
    (id: string, value: string) => {
      if (!onFilterChange) return;
      const next = { ...(filterValues ?? {}) };
      if (value) next[id] = value;
      else delete next[id];
      onFilterChange(next);
    },
    [filterValues, onFilterChange],
  );

  const clearFilters = useCallback(() => {
    onFilterChange?.({});
  }, [onFilterChange]);

  const showDetailPane = !hideDetailPane;
  const hasFilterValues =
    filterValues && Object.values(filterValues).some((v) => v && v.length > 0);

  return (
    <div className={styles.shell}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.headerTitle}>{title}</h1>
          {description ? <p className={styles.headerDesc}>{description}</p> : null}
        </div>
        {headerActions && headerActions.length > 0 ? (
          <div className={styles.headerActions}>
            {headerActions.map((a) => (
              <button
                key={a.id}
                type="button"
                className={buttonClass(a.variant)}
                onClick={a.onClick}
                disabled={a.disabled}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {message ? (
        <div
          role="status"
          className={`${styles.message} ${message.tone === "success" ? styles.messageSuccess : styles.messageError}`}
        >
          {message.text}
        </div>
      ) : null}

      {/* Summary */}
      {summary && summary.length > 0 ? (
        <div className={styles.summaryStrip}>
          {summary.map((s) => (
            <div key={s.id} className={styles.summaryCard}>
              <span
                className={`${styles.summaryValue} ${
                  s.tone === "amber"
                    ? styles.summaryAmber
                    : s.tone === "red"
                    ? styles.summaryRed
                    : s.tone === "green"
                    ? styles.summaryGreen
                    : ""
                }`}
              >
                {s.value}
              </span>
              <span className={styles.summaryLabel}>{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Primary tabs */}
      {primaryTabs && primaryTabs.length > 0 ? (
        <div
          className={styles.filterRail}
          role="tablist"
          aria-label="Workqueue tabs"
          style={{ gap: 4 }}
        >
          {primaryTabs.map((t) => {
            const isActive = t.id === activePrimaryTabId;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onPrimaryTabChange?.(t.id)}
                className={isActive ? styles.primaryBtn : styles.secondaryBtn}
                style={{ height: 32, padding: "0 12px", fontSize: 13 }}
              >
                {t.label}
                {typeof t.count === "number" ? (
                  <span
                    style={{
                      marginLeft: 6,
                      background: isActive ? "rgba(255,255,255,0.25)" : "#f1f5f9",
                      color: isActive ? "white" : "#475569",
                      padding: "1px 7px",
                      borderRadius: 999,
                      fontSize: 11,
                    }}
                  >
                    {t.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Filter rail */}
      {filters && filters.length > 0 ? (
        <div className={styles.filterRail} role="search" aria-label="Workqueue filters">
          {filters.map((f) => {
            const value = (filterValues ?? {})[f.id] ?? "";
            const common = {
              "aria-label": f.label,
              style: f.width ? { minWidth: f.width } : undefined,
            };
            return (
              <div key={f.id} className={styles.filterGroup}>
                <span className={styles.filterLabel}>{f.label}</span>
                {f.kind === "select" ? (
                  <select
                    {...common}
                    className={styles.filterSelect}
                    value={value}
                    onChange={(e) => setFilter(f.id, e.target.value)}
                  >
                    <option value="">{f.placeholder ?? "All"}</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    {...common}
                    className={styles.filterInput}
                    type={f.kind === "date" ? "date" : f.kind === "number" ? "number" : "text"}
                    placeholder={f.placeholder}
                    value={value}
                    onChange={(e) => setFilter(f.id, e.target.value)}
                  />
                )}
              </div>
            );
          })}
          {hasFilterValues ? (
            <button type="button" className={styles.filterClear} onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Body */}
      <div className={styles.body}>
        <div
          className={styles.tablePane}
          style={tablePaneWidth ? { flex: "0 0 auto", width: tablePaneWidth } : undefined}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                {selectionEnabled ? (
                  <th style={{ width: 32, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                    />
                  </th>
                ) : null}
                {columns.map((c) => (
                  <th
                    key={c.id}
                    style={{
                      textAlign: c.align ?? "left",
                      width: c.width,
                    }}
                  >
                    {c.header}
                  </th>
                ))}
                {rowActions && rowActions.length > 0 ? <th style={{ textAlign: "right" }}>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colSpan} className={styles.tableLoading}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className={styles.tableEmpty}>
                    {emptyMessage ?? "Nothing to show."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const id = rowId(row);
                  const selected = selectedRowId === id;
                  const checked = selectedSet.has(id);
                  return (
                    <tr
                      key={id}
                      className={selected ? styles.rowSelected : ""}
                      onClick={() => onSelectRow?.(id)}
                    >
                      {selectionEnabled ? (
                        <td
                          style={{ width: 32, textAlign: "center" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Select row ${id}`}
                            checked={checked}
                            onChange={() => toggleRow(id)}
                          />
                        </td>
                      ) : null}
                      {columns.map((c) => (
                        <td
                          key={c.id}
                          style={{ textAlign: c.align ?? "left", width: c.width }}
                        >
                          {c.cell(row)}
                        </td>
                      ))}
                      {rowActions && rowActions.length > 0 ? (
                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            {rowActions.map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                className={rowActionClass(a.variant)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  a.onClick(row);
                                }}
                                disabled={a.disabled?.(row)}
                                style={{ height: 28, padding: "0 10px", fontSize: 12 }}
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {showDetailPane ? (
          <aside
            className={styles.detailPane}
            aria-label="Selected claim detail"
            style={detailPaneWidth ? { width: detailPaneWidth } : undefined}
          >
            {detailTabs && detailTabs.length > 0 ? (
              <div className={styles.detailTabs} role="tablist">
                {detailTabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === activeTabId}
                    className={`${styles.detailTab} ${t.id === activeTabId ? styles.detailTabActive : ""}`}
                    onClick={() => setActiveTabId(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className={styles.detailBody}>
              {selectedRowId && renderDetail ? (
                renderDetail(selectedRowId)
              ) : selectedRowId && activeTab ? (
                activeTab.render()
              ) : (
                <div className={styles.detailEmpty}>
                  Select a row to see details.
                </div>
              )}
            </div>
            {detailActions && detailActions.length > 0 && selectedRowId ? (
              <div className={styles.detailActions}>
                {detailActions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={buttonClass(a.variant)}
                    onClick={a.onClick}
                    disabled={a.disabled}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {overlay}
    </div>
  );
}
