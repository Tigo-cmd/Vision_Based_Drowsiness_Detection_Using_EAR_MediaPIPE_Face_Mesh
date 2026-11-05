import { useEffect, useMemo, useRef, useState } from 'react';
import { Sample } from '../types';

interface Props {
  history: Sample[];
  threshold: number;
  /** Called once when the user lets go of the threshold line. */
  onThresholdChange: (value: number) => void;
}

const WINDOW_MS = 60_000;
const Y_MAX = 0.45;
const PAD = { l: 40, r: 56, t: 12, b: 24 };
const MIN_T = 0.1;
const MAX_T = 0.35;

/**
 * Live EAR over the last minute. The dashed line is the threshold:
 * drag it up or down to change the setting.
 */
export function EarChart({ history, threshold, onThresholdChange }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const h = 220;
  const [now, setNow] = useState(Date.now());
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; s: Sample } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the time axis sliding smoothly even between samples.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const iw = w - PAD.l - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + iw * (1 - (now - t) / WINDOW_MS);
  const y = (v: number) => PAD.t + ih * (1 - Math.min(v, Y_MAX) / Y_MAX);
  const yToV = (py: number) => Y_MAX * (1 - (py - PAD.t) / ih);

  const shown = dragValue ?? threshold;

  const { path, closedBands } = useMemo(() => {
    const pts = history.filter((s) => now - s.t <= WINDOW_MS + 1000);
    let d = '';
    let pen = false;
    for (const s of pts) {
      if (s.ear == null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.ear).toFixed(1)}`;
      pen = true;
    }
    // Shade stretches where the server said warning/critical.
    const bands: { x0: number; x1: number; crit: boolean }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const s = pts[i];
      if (s.level === 'normal') continue;
      const next = pts[i + 1];
      bands.push({ x0: x(s.t), x1: next ? x(next.t) : x(now), crit: s.level === 'critical' });
    }
    return { path: d, closedBands: bands };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, now, w]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragValue(threshold);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (dragValue !== null) {
      const v = Math.round(Math.min(MAX_T, Math.max(MIN_T, yToV(py))) * 200) / 200;
      setDragValue(v);
      return;
    }
    // Hover readout: nearest sample in time
    const t = now - (1 - (px - PAD.l) / iw) * WINDOW_MS;
    let best: Sample | null = null;
    for (const s of history) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    setHover(best && px > PAD.l && px < PAD.l + iw ? { x: x(best.t), s: best } : null);
  };
  const onPointerUp = () => {
    if (dragValue !== null && Math.abs(dragValue - threshold) > 0.001) onThresholdChange(dragValue);
    setDragValue(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.02 : 0.005;
    if (e.key === 'ArrowUp') onThresholdChange(Math.min(MAX_T, +(threshold + step).toFixed(3)));
    if (e.key === 'ArrowDown') onThresholdChange(Math.max(MIN_T, +(threshold - step).toFixed(3)));
  };

  const ticks = [0, 0.1, 0.2, 0.3, 0.4];
  const ty = y(shown);

  return (
    <section className="panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <div>
          <h2 className="font-semibold">Eye aspect ratio</h2>
          <p className="text-sm text-ink-soft">Last 60 seconds. Below the dashed line counts as eyes closed.</p>
        </div>
        <p className="text-xs text-ink-faint">
          Drag the line to change the threshold, or focus it and use <span className="kbd">↑</span>{' '}
          <span className="kbd">↓</span>
        </p>
      </header>
      <div ref={wrap} className="min-w-0 overflow-hidden px-2 pb-2">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width="100%"
          height={h}
          preserveAspectRatio="none"
          className="block touch-none select-none"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`EAR chart, threshold ${shown.toFixed(2)}`}
        >
          {/* Region below threshold */}
          <rect x={PAD.l} y={ty} width={iw} height={PAD.t + ih - ty} className="fill-crit/[0.05]" />
          {closedBands.map((b, i) => (
            <rect
              key={i}
              x={Math.max(PAD.l, b.x0)}
              y={PAD.t}
              width={Math.max(0, Math.min(PAD.l + iw, b.x1) - Math.max(PAD.l, b.x0))}
              height={ih}
              className={b.crit ? 'fill-crit/[0.12]' : 'fill-warn/[0.12]'}
            />
          ))}

          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + iw} y1={y(v)} y2={y(v)} className="stroke-line" />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="fill-ink-faint font-mono text-[10px]">
                {v.toFixed(1)}
              </text>
            </g>
          ))}
          {[60, 45, 30, 15, 0].map((s) => (
            <text
              key={s}
              x={PAD.l + iw * (1 - s / 60)}
              y={h - 6}
              textAnchor="middle"
              className="fill-ink-faint font-mono text-[10px]"
            >
              {s === 0 ? 'now' : `-${s}s`}
            </text>
          ))}

          <path d={path} fill="none" strokeWidth="1.75" strokeLinejoin="round" className="stroke-ink" />
          {history.length > 0 && history[history.length - 1].ear != null && (
            <circle
              cx={x(history[history.length - 1].t)}
              cy={y(history[history.length - 1].ear!)}
              r="3.5"
              className="fill-ink"
            />
          )}

          {hover && dragValue === null && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={PAD.t} y2={PAD.t + ih} className="stroke-ink-faint" strokeDasharray="2 3" />
              <text x={hover.x + 6} y={PAD.t + 12} className="fill-ink font-mono text-[11px]">
                {hover.s.ear == null ? 'no face' : hover.s.ear.toFixed(3)}
              </text>
            </g>
          )}

          {/* Threshold: wide invisible hit area + visible dashed line + handle */}
          <g
            tabIndex={0}
            role="slider"
            aria-label="EAR threshold"
            aria-valuemin={MIN_T}
            aria-valuemax={MAX_T}
            aria-valuenow={shown}
            onKeyDown={onKey}
            onPointerDown={onPointerDown}
            className="cursor-ns-resize outline-none"
          >
            <line x1={PAD.l} x2={PAD.l + iw} y1={ty} y2={ty} stroke="transparent" strokeWidth="16" />
            <line x1={PAD.l} x2={PAD.l + iw} y1={ty} y2={ty} className="stroke-crit" strokeWidth="1.5" strokeDasharray="6 4" />
            <rect x={PAD.l + iw + 4} y={ty - 11} width={48} height={22} rx="4" className="fill-crit" />
            <text x={PAD.l + iw + 28} y={ty + 4} textAnchor="middle" className="fill-white font-mono text-[11px]">
              {shown.toFixed(3)}
            </text>
          </g>
        </svg>
      </div>
    </section>
  );
}
