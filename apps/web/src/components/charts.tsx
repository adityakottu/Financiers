'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './ui';

/**
 * Single-series column chart (dataviz method: one hue, validated against the surface; bars at most
 * 24px with a 4px rounded data end on a single baseline; hairline recessive grid; per-bar tooltip
 * on hover and keyboard focus; a table view so no value is reachable only by hovering).
 */
export interface Bar {
  key: string;
  label: string;
  /** Long label for the tooltip / table. */
  title?: string;
  value: number;
  /** Extra line in the tooltip (e.g. "12 loans"). */
  detail?: string;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useIsoLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** 1, 2, 2.5, 5 × 10^n steps so the axis reads in round numbers. */
function niceMax(v: number, ticks = 4) {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / ticks;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  return { max: step * ticks, step };
}

/** Rounded top corners only: the data end is rounded, the baseline stays square. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function BarChart({
  data,
  format,
  axisFormat,
  height = 180,
  label,
  labelEvery,
  className,
}: {
  data: Bar[];
  /** Value text in tooltip and table. */
  format: (v: number) => string;
  /** Short value text on the y-axis. */
  axisFormat?: (v: number) => string;
  height?: number;
  /** Accessible name for the chart. */
  label: string;
  /** Show every nth x label (dense daily series). */
  labelEvery?: number;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pad = { l: 52, r: 8, t: 10, b: 24 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const { max, step } = niceMax(Math.max(...data.map((d) => d.value), 0));
  const band = data.length ? iw / data.length : 0;
  const bw = Math.max(2, Math.min(24, band - 2)); // 2px surface gap between touching bars
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const every = labelEvery ?? Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 56))));
  const af = axisFormat ?? format;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const h = hover !== null ? data[hover] : null;

  return (
    <div className={cx('relative', className)}>
      <div className="mb-1 flex justify-end">
        <button type="button" onClick={() => setTable((t) => !t)} className="text-[12px] text-muted underline-offset-2 hover:underline" aria-pressed={table}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-[260px] overflow-auto rounded-md border border-line">
          <table className="w-full text-[13px]">
            <caption className="sr-only">{label}</caption>
            <tbody>
              {data.map((d) => (
                <tr key={d.key} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted">
                    {d.title ?? d.label}
                  </th>
                  <td className="num px-3 py-1.5 text-right text-ink-950">{format(d.value)}</td>
                  {data.some((x) => x.detail) && <td className="px-3 py-1.5 text-right text-[12px] text-subtle">{d.detail}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative w-full" style={{ height }} onPointerLeave={() => setHover(null)}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-[var(--color-subtle)] text-[11px]">
                    {af(t)}
                  </text>
                </g>
              ))}
              {data.map((d, i) => {
                const cx0 = pad.l + band * i + band / 2;
                const top = y(d.value);
                return (
                  <g
                    key={d.key}
                    tabIndex={0}
                    role="img"
                    aria-label={`${d.title ?? d.label}: ${format(d.value)}${d.detail ? `, ${d.detail}` : ''}`}
                    onPointerEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="outline-none"
                  >
                    {/* Hit target: the whole band, taller than the bar. */}
                    <rect x={pad.l + band * i} y={pad.t} width={band} height={ih} fill="transparent" />
                    <path d={barPath(cx0 - bw / 2, top, bw, pad.t + ih - top, 4)} fill="var(--viz-series-1)" opacity={hover === null || hover === i ? 1 : 0.45} />
                    {i % every === 0 && (
                      <text x={cx0} y={height - 6} textAnchor="middle" className="fill-[var(--color-subtle)] text-[11px]">
                        {d.label}
                      </text>
                    )}
                  </g>
                );
              })}
              <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--viz-axis)" strokeWidth={1} shapeRendering="crispEdges" />
            </svg>
          )}
          {h && hover !== null && width > 0 && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] shadow-md"
              style={{ left: Math.min(Math.max(pad.l + band * hover + band / 2, 70), width - 70), top: Math.max(y(h.value) - 6, h.detail ? 66 : 50) }}
            >
              <p className="num font-semibold text-ink-950">{format(h.value)}</p>
              <p className="text-muted">{h.title ?? h.label}</p>
              {h.detail && <p className="text-subtle">{h.detail}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A headline number with its context (dataviz: when the form is a number, not a chart). */
export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'bad' | 'warn' | 'ok' }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">{label}</p>
      <p className={cx('num mt-0.5 text-xl font-semibold', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink-950')}>{value}</p>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 2 | 3 | 4 | 6 }) {
  return <div className={cx('grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line', cols === 3 ? 'sm:grid-cols-3' : cols === 6 ? 'sm:grid-cols-3 xl:grid-cols-6' : cols === 2 ? '' : 'sm:grid-cols-4')}>{children}</div>;
}
