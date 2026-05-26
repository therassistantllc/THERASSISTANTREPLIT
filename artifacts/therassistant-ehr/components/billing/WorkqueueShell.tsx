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
  onClick?: () => void;
}

export type FilterKind = "text" | "select" | "date" | "number" | "combobox";

export interface FilterDef {
  id: string;
  label: string;
  kind: FilterKind;
  placeholder?: string;
  /**
   * For `select` and `combobox` kinds.
   *   - `select` renders a dropdown limited to these options.
   *   - `combobox` renders a text input backed by a <datalist>; the user can
   *     pick a suggestion or free-type. Selecting a suggestion fills the
   *     input with the canonical `value` so downstream filtering is exact.
   */
  options?: Array<{ value: string; label: string }>;
  width?: number;
  /**
   * Escape hatch: when set, the rail renders this in place of the
   * kind-based input. The page owns its own picker UI and can wire up
   * extra state (e.g. a stable identifier alongside the visible name).
   * The provided `value` is still the shell's stored filter value; calling
   * `setValue(next)` updates it through the usual `onFilterChange` path.
   */
  render?: (
    value: string,
    setValue: (next: string) => void,
  ) => ReactNode;
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
  label: ReactNode | ((row: TRow) => ReactNode);
  onClick: (row: TRow) => void;
  variant?: "default" | "primary" | "danger" | "success";
  disabled?: (row: TRow) => boolean;
}

export interface PrimaryAction {
  id: string;
  label: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "success";
  disabled?: boolean;
  render?: () => ReactNode;
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
  /** When set, this row briefly pulses (highlight that fades) to draw the
   *  eye, e.g. after a deep-link navigation. The caller is responsible
   *  for clearing this back to null after the animation ends. */
  pulseRowId?: string | null;
  /** When provided, enables multi-select with a checkbox column. */
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  rowActions?: RowAction<TRow>[];
  /**
   * Optional file-drop handler. When set, dragging files over a row shows a
   * drop-target highlight and dropping invokes the callback with the row and
   * the dropped files. Callers wire this up to upload to the row's claim.
   */
  onRowDrop?: (row: TRow, files: File[]) => void;
  /** Right-side detail panel */
  detailTabs?: DetailTab[];
  /**
   * Optional controlled detail-tab id. When set, the shell renders this
   * tab instead of its internal default; pair with `onDetailTabChange`
   * to keep both ends in sync. Pages use this to focus a specific tab
   * in response to an external event (e.g. "Fix claim" jumping to the
   * 837P field checklist).
   */
  activeDetailTabId?: string;
  onDetailTabChange?: (tabId: string) => void;
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
  /** Optional toolbar slot rendered between the filter rail and the table.
   *  Pages use this for bulk-action bars when rows are multi-selected. */
  toolbar?: ReactNode;
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
    pulseRowId,
    selectedRowIds,
    onSelectionChange,
    rowActions,
    onRowDrop,
    detailTabs,
    activeDetailTabId,
    onDetailTabChange,
    detailActions,
    renderDetail,
    hideDetailPane,
    detailPaneWidth,
    tablePaneWidth,
    message,
    toolbar,
    overlay,
  } = props;

  useUrlFilterSync(filterUrlNamespace, filterValues, onFilterChange);

  const [internalActiveTabId, setInternalActiveTabId] = useState<string | null>(
    detailTabs && detailTabs.length > 0 ? detailTabs[0].id : null,
  );

  // Controlled when the page supplies activeDetailTabId; otherwise the
  // shell falls back to its own internal selection. This lets pages
  // programmatically jump the user to a specific tab (e.g. "Fix claim"
  // focusing the 837P field checklist) without losing the default UX
  // for queues that don't need that control.
  const activeTabId = activeDetailTabId ?? internalActiveTabId;
  const setActiveTabId = useCallback(
    (id: string) => {
      setInternalActiveTabId(id);
      onDetailTabChange?.(id);
    },
    [onDetailTabChange],
  );

  useEffect(() => {
    if (!detailTabs || detailTabs.length === 0) {
      setInternalActiveTabId(null);
      return;
    }
    if (!activeTabId || !detailTabs.some((t) => t.id === activeTabId)) {
      setInternalActiveTabId(detailTabs[0].id);
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

  const [dragRowId, setDragRowId] = useState<string | null>(null);

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
          {summary.map((s) => {
            const valueEl = (
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
            );
            if (s.onClick) {
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={s.onClick}
                  className={styles.summaryCard}
                  style={{
                    cursor: "pointer",
                    border: 0,
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  {valueEl}
                  <span className={styles.summaryLabel}>{s.label}</span>
                </button>
              );
            }
            return (
              <div key={s.id} className={styles.summaryCard}>
                {valueEl}
                <span className={styles.summaryLabel}>{s.label}</span>
              </div>
            );
          })}
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
                {f.render ? (
                  f.render(value, (next) => setFilter(f.id, next))
                ) : f.kind === "select" ? (
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
                ) : f.kind === "combobox" ? (
                  <>
                    <input
                      {...common}
                      className={styles.filterInput}
                      type="text"
                      list={`wqshell-combobox-${f.id}`}
                      placeholder={f.placeholder}
                      value={value}
                      onChange={(e) => setFilter(f.id, e.target.value)}
                      autoComplete="off"
                    />
                    <datalist id={`wqshell-combobox-${f.id}`}>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </datalist>
                  </>
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

      {toolbar ? <div>{toolbar}</div> : null}

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
                  const pulsing = pulseRowId === id;
                  const dragOver = dragRowId === id;
                  const rowClass = [
                    selected ? styles.rowSelected : "",
                    pulsing ? styles.rowPulse : "",
                    dragOver ? styles.rowDragOver : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const dragProps = onRowDrop
                    ? {
                        onDragEnter: (e: React.DragEvent) => {
                          if (
                            !Array.from(e.dataTransfer?.types || []).includes(
                              "Files",
                            )
                          )
                            return;
                          e.preventDefault();
                          setDragRowId(id);
                        },
                        onDragOver: (e: React.DragEvent) => {
                          if (
                            !Array.from(e.dataTransfer?.types || []).includes(
                              "Files",
                            )
                          )
                            return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "copy";
                          if (dragRowId !== id) setDragRowId(id);
                        },
                        onDragLeave: (e: React.DragEvent) => {
                          // Only clear when leaving the row entirely
                          const related = e.relatedTarget as Node | null;
                          if (
                            related &&
                            (e.currentTarget as Node).contains(related)
                          )
                            return;
                          if (dragRowId === id) setDragRowId(null);
                        },
                        onDrop: (e: React.DragEvent) => {
                          e.preventDefault();
                          setDragRowId(null);
                          const files = Array.from(
                            e.dataTransfer?.files ?? [],
                          );
                          if (files.length > 0) onRowDrop(row, files);
                        },
                      }
                    : {};
                  return (
                    <tr
                      key={id}
                      id={`wqrow-${id}`}
                      className={rowClass}
                      onClick={() => onSelectRow?.(id)}
                      {...dragProps}
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
                                {typeof a.label === "function" ? a.label(row) : a.label}
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
                {detailActions.map((a) =>
                  a.render ? (
                    <div key={a.id}>{a.render()}</div>
                  ) : (
                    <button
                      key={a.id}
                      type="button"
                      className={buttonClass(a.variant)}
                      onClick={a.onClick}
                      disabled={a.disabled}
                    >
                      {a.label}
                    </button>
                  )
                )}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {overlay}
    </div>
  );
}
