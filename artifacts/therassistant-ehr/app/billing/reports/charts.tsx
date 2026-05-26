"use client";

/**
 * Lightweight inline-SVG chart primitives used by the billing reports
 * page (Task #772). Built in-house instead of pulling in a charting
 * dependency so the page stays fast to ship and the bundle stays small.
 * Each chart renders an empty-state when given no data.
 */

import { useId } from "react";

const PALETTE = ["#10243f", "#5e8a6a", "#7a5000", "#b02020", "#1e5e40", "#1a3d68", "#c6d8cc"];

function money(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

interface EmptyProps {
  label?: string;
  height?: number;
}

function Empty({ label = "No data for this period", height = 120 }: EmptyProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height,
        color: "var(--muted)",
        fontSize: 12,
        fontStyle: "italic",
      }}
    >
      {label}
    </div>
  );
}

/* ── Sparkline ───────────────────────────────────────────────────────────── */

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = "#5e8a6a",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!values || values.length === 0 || values.every((v) => v === 0)) {
    return (
      <div style={{ width, height, opacity: 0.35 }} aria-hidden>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="#cbd5e1" strokeDasharray="2 3" />
        </svg>
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const fillD = `${d} L${width.toFixed(1)},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={fillD} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Multi-series line chart (used for charges vs payments, denial trend) ── */

export interface LineSeries {
  name: string;
  color: string;
  values: number[];
}

export function LineChart({
  series,
  labels,
  height = 200,
  format = compactNumber,
}: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  format?: (n: number) => string;
}) {
  const titleId = useId();
  const allValues = series.flatMap((s) => s.values);
  if (allValues.length === 0 || allValues.every((v) => v === 0)) {
    return <Empty height={height} />;
  }
  const width = 560;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const min = 0;
  const max = Math.max(...allValues, 1);
  const stepX = innerW / Math.max(1, labels.length - 1);

  const ticks = 4;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => (max * i) / ticks);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} style={{ width: "100%", height: "auto" }}>
      <title id={titleId}>Line chart</title>
      {tickValues.map((tv, i) => {
        const y = padT + innerH - ((tv - min) / (max - min || 1)) * innerH;
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#eef2f7" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#5c6e82">
              {format(tv)}
            </text>
          </g>
        );
      })}
      {labels.map((label, i) => {
        const x = padL + i * stepX;
        return (
          <text key={label + i} x={x} y={height - 8} textAnchor="middle" fontSize={10} fill="#5c6e82">
            {label}
          </text>
        );
      })}
      {series.map((s) => {
        const d = s.values
          .map((v, i) => {
            const x = padL + i * stepX;
            const y = padT + innerH - ((v - min) / (max - min || 1)) * innerH;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, i) => {
              const x = padL + i * stepX;
              const y = padT + innerH - ((v - min) / (max - min || 1)) * innerH;
              return <circle key={i} cx={x} cy={y} r={3} fill={s.color} />;
            })}
          </g>
        );
      })}
      <g transform={`translate(${padL},${padT - 2})`}>
        {series.map((s, i) => (
          <g key={s.name} transform={`translate(${i * 130}, 0)`}>
            <rect width={10} height={2} y={6} fill={s.color} />
            <text x={16} y={9} fontSize={11} fill="#1a2332">
              {s.name}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/* ── Horizontal bar chart ─────────────────────────────────────────────── */

export function HBarChart({
  items,
  height = 200,
  format = compactNumber,
}: {
  items: Array<{ label: string; value: number; color?: string }>;
  height?: number;
  format?: (n: number) => string;
}) {
  if (!items || items.length === 0 || items.every((i) => i.value === 0)) {
    return <Empty height={height} />;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  const rowH = Math.max(18, Math.min(34, height / items.length));
  const labelW = 140;
  const valW = 60;
  const width = 560;
  const barW = width - labelW - valW - 12;

  return (
    <svg viewBox={`0 0 ${width} ${rowH * items.length + 8}`} role="img" style={{ width: "100%", height: "auto" }}>
      {items.map((it, i) => {
        const y = i * rowH + 2;
        const w = (it.value / max) * barW;
        return (
          <g key={it.label + i}>
            <text x={labelW - 6} y={y + rowH / 2 + 3} textAnchor="end" fontSize={11} fill="#1a2332">
              {it.label.length > 26 ? `${it.label.slice(0, 25)}…` : it.label}
            </text>
            <rect x={labelW} y={y + 4} width={w} height={rowH - 8} fill={it.color ?? PALETTE[i % PALETTE.length]} rx={2} />
            <text x={labelW + w + 6} y={y + rowH / 2 + 3} fontSize={11} fill="#5c6e82">
              {format(it.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Stacked horizontal bar (aging buckets) ────────────────────────────── */

export function StackedBar({
  segments,
  height = 14,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  height?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <Empty height={height + 40} />;
  const width = 560;
  let cursor = 0;
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height }}>
        {segments.map((seg) => {
          const w = (seg.value / total) * width;
          const x = cursor;
          cursor += w;
          return <rect key={seg.label} x={x} y={0} width={w} height={height} fill={seg.color} />;
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
        {segments.map((seg) => (
          <span key={seg.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, background: seg.color, borderRadius: 2, display: "inline-block" }} />
            {seg.label}: {money(seg.value)} ({total > 0 ? Math.round((seg.value / total) * 100) : 0}%)
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Donut (payer mix) ────────────────────────────────────────────────── */

export function Donut({
  slices,
  size = 180,
}: {
  slices: Array<{ label: string; value: number; color?: string }>;
  size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <Empty height={size} />;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const innerR = r * 0.6;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const slice = (s.value / total) * Math.PI * 2;
    const start = angle;
    const end = angle + slice;
    angle = end;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const xi1 = cx + innerR * Math.cos(end);
    const yi1 = cy + innerR * Math.sin(end);
    const xi2 = cx + innerR * Math.cos(start);
    const yi2 = cy + innerR * Math.sin(start);
    const large = slice > Math.PI ? 1 : 0;
    const d = [
      `M${x1},${y1}`,
      `A${r},${r} 0 ${large} 1 ${x2},${y2}`,
      `L${xi1},${yi1}`,
      `A${innerR},${innerR} 0 ${large} 0 ${xi2},${yi2}`,
      "Z",
    ].join(" ");
    return { d, color: s.color ?? PALETTE[i % PALETTE.length], label: s.label, value: s.value };
  });

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.color} />
        ))}
      </svg>
      <div style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text)" }}>
        {arcs.map((a) => (
          <span key={a.label} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, background: a.color, borderRadius: 2 }} />
            <span style={{ minWidth: 140 }}>{a.label}</span>
            <span style={{ color: "var(--muted)" }}>
              {compactNumber(a.value)} ({Math.round((a.value / total) * 100)}%)
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
