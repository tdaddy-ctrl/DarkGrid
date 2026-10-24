'use client';

import { useId } from 'react';
import type { ChartPoint } from '@/types/sim';

// "DARK GRID TRIAGE" chart — dark grid, cyan glow, area gradient, data dots.
// Hand-rolled SVG to match the current page's visual style and avoid recharts.

export default function MetricsChart({ data }: { data: ChartPoint[] }) {
  const uid = useId().replace(/:/g, '');
  const W = 600, H = 240, L = 38, R = 10, T = 12, B = 24;

  const maxT = Math.max(60, ...data.map((d) => d.t));
  const rawMax = Math.max(10, ...data.map((d) => Math.max(d.fifo, d.darkgrid)));
  const step = rawMax > 200 ? 100 : rawMax > 80 ? 50 : rawMax > 40 ? 20 : 10;
  const maxY = Math.ceil(rawMax / step) * step;

  const x = (t: number) => L + (t / maxT) * (W - L - R);
  const y = (v: number) => H - B - (v / maxY) * (H - T - B);

  const pts = (key: 'fifo' | 'darkgrid') =>
    data.map((d) => `${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');

  const area = (key: 'fifo' | 'darkgrid') =>
    data.length > 1
      ? `M${x(data[0].t).toFixed(1)},${y(0)} L${pts(key).replace(/ /g, ' L')} L${x(data[data.length - 1].t).toFixed(1)},${y(0)} Z`
      : '';

  const yTicks = Array.from({ length: maxY / step + 1 }, (_, i) => i * step);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxT);
  const last = data[data.length - 1];
  const formatT = (t: number) => {
    const s = Math.floor(t);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <section className="dg-panel flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-dg-line px-4 py-3">
        <h2 className="dg-label flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-dg-cyan shadow-[0_0_8px_#38BDF8]" />
          DARK GRID TRIAGE
        </h2>
        <div className="flex items-center gap-3 font-mono text-[10px] tracking-[0.12em]">
          <span className="flex items-center gap-1.5 text-slate-400">
            <span aria-hidden="true" className="w-3 border-t border-dashed border-slate-400" />FIFO
          </span>
          <span className="flex items-center gap-1.5 text-dg-cyan">
            <span aria-hidden="true" className="h-0.5 w-3 rounded bg-dg-cyan shadow-[0_0_6px_#38BDF8]" />DARK GRID
          </span>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 p-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-full w-full"
          role="img"
          aria-label={
            last
              ? `Requests waiting at ${formatT(last.t)}: FIFO ${last.fifo}, DARK GRID ${last.darkgrid}`
              : 'No data yet'
          }
        >
          <defs>
            <linearGradient id={`${uid}dg`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${uid}fifo`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
            </linearGradient>
            <filter id={`${uid}glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {yTicks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)}
                stroke="rgb(148 163 184 / 0.12)" strokeDasharray="3 5" />
              <text x={L - 8} y={y(v) + 4} fill="#a9b6cc" fontSize={10}
                textAnchor="end" fontFamily="var(--font-jetbrains)">{v}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 6} fill="#a9b6cc" fontSize={10}
              textAnchor="middle" fontFamily="var(--font-jetbrains)">{formatT(t)}</text>
          ))}

          {data.length > 1 && (
            <>
              <path d={area('fifo')} fill={`url(#${uid}fifo)`} />
              <polyline points={pts('fifo')} fill="none"
                stroke="#94a3b8" strokeWidth={1.75} strokeDasharray="5 4"
                strokeLinejoin="round" />

              <path d={area('darkgrid')} fill={`url(#${uid}dg)`} />
              <polyline points={pts('darkgrid')} fill="none"
                stroke="#38BDF8" strokeOpacity={0.3} strokeWidth={7}
                strokeLinejoin="round" strokeLinecap="round"
                filter={`url(#${uid}glow)`} />
              <polyline points={pts('darkgrid')} fill="none"
                stroke="#38BDF8" strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />

              {data.map((d) => (
                <circle key={d.t} cx={x(d.t)} cy={y(d.darkgrid)} r={2.5}
                  fill="#0b1220" stroke="#38BDF8" strokeWidth={1.5} />
              ))}

              <circle cx={x(last.t)} cy={y(last.fifo)} r={3} fill="#94a3b8" />
              <circle cx={x(last.t)} cy={y(last.darkgrid)} r={4} fill="#38BDF8"
                filter={`url(#${uid}glow)`} />
            </>
          )}
        </svg>
        {data.length <= 1 && (
          <p className="dg-label pointer-events-none absolute inset-0 flex items-center justify-center">
            Awaiting telemetry
          </p>
        )}
      </div>
    </section>
  );
}