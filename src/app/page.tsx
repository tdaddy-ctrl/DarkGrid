'use client';

// Main page: runs a FIFO city and a DARK GRID city side by side from the same seed.
// Sim state lives in refs (mutated every frame); React state is a copy refreshed at most
// 4 times per second, so 250 cars never cause 60 re-renders a second.
// The *Placeholder components below stand in for C's and D's real components.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartPoint, LatLng, RoadGraph, SimSnapshot } from '@/types/sim';
import {
  answerJob, createSim, getSnapshot, injectEvent, makeGridGraph, setControl, step, type Sim,
} from '@/lib/sim';
import { SEED, SIM_SPEED } from '@/lib/config';
import RequestQueuePanel from '@/components/RequestQueuePanel';

const STEP_S = 0.5;          // fixed sim timestep
const UI_EVERY_MS = 250;     // React state updates at most 4x per second
const CHART_EVERY_S = 2;     // one ChartPoint every 2 sim-seconds
const MAX_FRAME_S = 0.25;    // a stalled tab doesn't fast-forward minutes at once

type Mode = SimSnapshot['mode'];
type View = { fifo: SimSnapshot; darkgrid: SimSnapshot; chart: ChartPoint[] };

export default function Home() {
  const [graph] = useState<RoadGraph>(() => makeGridGraph());   // B's real graph replaces makeGridGraph()
  const simsRef = useRef<{ fifo: Sim; darkgrid: Sim } | null>(null);
  const chartRef = useRef<ChartPoint[]>([]);
  const pausedRef = useRef(false);

  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<Mode>('DARKGRID');
  const [paused, setPaused] = useState(false);
  const [judge, setJudge] = useState<Mode | null>(null);   // which city the judge is operating

  const publish = useCallback(() => {
    const sims = simsRef.current;
    if (!sims) return;
    setView({ fifo: getSnapshot(sims.fifo), darkgrid: getSnapshot(sims.darkgrid), chart: [...chartRef.current] });
  }, []);

  const freshSims = useCallback(() => {
    simsRef.current = { fifo: createSim(graph, SEED, 'FIFO'), darkgrid: createSim(graph, SEED, 'DARKGRID') };
    chartRef.current = [];
  }, [graph]);

  const reset = useCallback(() => {
    freshSims();
    setJudge(null);
    publish();
  }, [freshSims, publish]);

  // The judge becomes the only operator of one city; the other city stays automatic.
  const takeOver = useCallback((m: Mode | null) => {
    const sims = simsRef.current;
    if (!sims) return;
    setControl(sims.fifo, m === 'FIFO' ? 'MANUAL' : 'AUTO');
    setControl(sims.darkgrid, m === 'DARKGRID' ? 'MANUAL' : 'AUTO');
    setJudge(m);
    if (m) setMode(m);
    publish();
  }, [publish]);

  const onAnswer = useCallback((jobId: string) => {
    const sims = simsRef.current;
    if (!sims || !judge) return;
    answerJob(judge === 'FIFO' ? sims.fifo : sims.darkgrid, jobId);
    publish();
  }, [judge, publish]);

  const blackout = useCallback(() => {
    const sims = simsRef.current;
    if (!sims) return;
    injectEvent(sims.fifo, { type: 'OUTAGE' });
    injectEvent(sims.darkgrid, { type: 'OUTAGE' });
    publish();
  }, [publish]);

  useEffect(() => {
    freshSims();             // first publish happens in the loop below
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    let acc = 0;
    const loop = (now: number) => {
      const sims = simsRef.current;
      const realDt = Math.min(MAX_FRAME_S, (now - last) / 1000);
      last = now;
      if (sims && !pausedRef.current) {
        acc += realDt * SIM_SPEED;
        while (acc >= STEP_S) {
          const before = sims.fifo.t;
          step(sims.fifo, STEP_S);
          step(sims.darkgrid, STEP_S);
          acc -= STEP_S;
          if (Math.floor(sims.fifo.t / CHART_EVERY_S) > Math.floor(before / CHART_EVERY_S)) {
            chartRef.current.push({
              t: sims.fifo.t,
              fifo: sims.fifo.metrics.requests,
              darkgrid: sims.darkgrid.metrics.requests,
            });
          }
        }
      }
      if (now - lastUi >= UI_EVERY_MS) { publish(); lastUi = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [freshSims, publish]);

  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };

  if (!view) {
    return <main className="flex flex-1 items-center justify-center text-zinc-500">Starting simulation…</main>;
  }
  const snap = mode === 'FIFO' ? view.fifo : view.darkgrid;

  return (
    <main className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold tracking-wide">DARK GRID</h1>
        <span className="font-mono text-sm text-zinc-400">t = {formatT(snap.t)}</span>
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          {(['FIFO', 'DARKGRID'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1.5 text-sm ${mode === m ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-300 hover:bg-zinc-800'}`}>
              {m === 'FIFO' ? 'FIFO' : 'DARK GRID'}
            </button>
          ))}
        </div>
        <button onClick={blackout} disabled={view.fifo.metrics.darkCount > 0}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:opacity-40">
          Blackout
        </button>
        {judge === null && (
          <button onClick={() => takeOver('FIFO')} className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-zinc-950">
            Judge takes over
          </button>
        )}
        {judge === 'FIFO' && (
          <button onClick={() => takeOver('DARKGRID')} className="rounded-md bg-emerald-400 px-3 py-1.5 text-sm font-medium text-zinc-950">
            Dark Grid on
          </button>
        )}
        {judge !== null && (
          <button onClick={() => takeOver(null)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
            Auto operators
          </button>
        )}
        <button onClick={togglePause} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={reset} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">
          Reset
        </button>
      </header>

      <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_340px]">
        <MapPlaceholder snapshot={snap} graph={graph} />
        <RequestQueuePanel snapshot={snap} onAnswer={onAnswer} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.4fr]">
        <MetricsPlaceholder snapshot={view.fifo} />
        <MetricsPlaceholder snapshot={view.darkgrid} />
        <ChartPlaceholder data={view.chart} />
      </div>
    </main>
  );
}

function formatT(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- placeholders (delete each one when the real component lands) ----------

const STATE_COLOR: Record<string, string> = {
  DRIVING: '#a1a1aa', REQUESTING_HELP: '#f43f5e', QUEUED_BEHIND: '#f59e0b', STAGED: '#38bdf8', ARRIVED: '#22c55e',
};

// Stand-in for MapView: a flat SVG of the road graph.
function MapPlaceholder({ snapshot, graph }: { snapshot: SimSnapshot; graph: RoadGraph }) {
  const lats = graph.nodes.map((n) => n.lat), lngs = graph.nodes.map((n) => n.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const W = 1000, H = 1000, pad = 40;
  const px = (p: LatLng) => pad + ((p.lng - minLng) / (maxLng - minLng || 1)) * (W - 2 * pad);
  const py = (p: LatLng) => H - pad - ((p.lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * pad);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const amb = snapshot.ambulance;

  return (
    <section className="relative min-h-[360px] rounded-lg border border-zinc-800 bg-zinc-900/60">
      <span className="absolute left-3 top-2 text-xs uppercase tracking-wider text-zinc-500">MapView placeholder · {snapshot.mode}</span>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full max-h-[70vh] w-full" role="img" aria-label="Simulated city">
        {graph.edges.map((e) => {
          const a = byId.get(e.from)!, b = byId.get(e.to)!;
          return <line key={e.id} x1={px(a)} y1={py(a)} x2={px(b)} y2={py(b)} stroke="#3f3f46" strokeWidth={6} />;
        })}
        {snapshot.corridor.length > 1 && (
          <polyline points={snapshot.corridor.map((p) => `${px(p)},${py(p)}`).join(' ')}
            fill="none" stroke="#22c55e" strokeOpacity={0.5} strokeWidth={14} />
        )}
        {snapshot.darkNodes.map((p, i) => (
          <circle key={i} cx={px(p)} cy={py(p)} r={14} fill="none" stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={2} />
        ))}
        {snapshot.lots.map((l, i) => (
          <g key={i}>
            <rect x={px(l.pos) - 22} y={py(l.pos) - 22} width={44} height={44} fill="none" stroke="#38bdf8" strokeWidth={2} />
            <text x={px(l.pos)} y={py(l.pos) - 28} fill="#38bdf8" fontSize={18} textAnchor="middle">{l.used}/{l.cap}</text>
          </g>
        ))}
        {snapshot.vehicles.map((v) => (
          <circle key={v.id} cx={px(v.pos)} cy={py(v.pos)} r={5} fill={STATE_COLOR[v.state]} />
        ))}
        {amb && (
          <g transform={`translate(${px(amb.pos)} ${py(amb.pos)}) rotate(${amb.headingDeg})`}>
            <path d="M0,-16 L11,12 L0,6 L-11,12 Z" fill="#ffffff" stroke="#ef4444" strokeWidth={3} />
          </g>
        )}
      </svg>
    </section>
  );
}

// Stand-in for RequestQueuePanel: top of the job queue. In MANUAL the cards are clickable.
function QueuePlaceholder({ snapshot, onAnswer }: { snapshot: SimSnapshot; onAnswer: (jobId: string) => void }) {
  const manual = snapshot.control === 'MANUAL';
  const locked = snapshot.manual.lockRemainingS > 0;
  return (
    <section className="flex min-h-[360px] flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <h2 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">
        RequestQueuePanel placeholder · {snapshot.jobs.length} jobs
      </h2>
      {manual && (
        <p className="mb-2 rounded bg-rose-500/15 px-2 py-1.5 text-sm text-rose-200">
          {locked ? `Reviewing… ${snapshot.manual.lockRemainingS.toFixed(1)} s` : 'You are the operator. Click a card.'}
          <span className="float-right font-mono">answered {snapshot.manual.answered}</span>
        </p>
      )}
      <ul className="mb-3 space-y-1 text-xs text-zinc-400">
        {snapshot.operators.map((op) => (
          <li key={op.id} className="flex justify-between gap-2">
            <span className="font-mono">{op.id}</span><span className="truncate">{op.task}</span>
          </li>
        ))}
      </ul>
      <ol className="flex-1 space-y-1.5 overflow-y-auto">
        {snapshot.jobs.slice(0, 12).map((j) => (
          <li key={j.id}>
            <button disabled={!manual || locked} onClick={() => onAnswer(j.id)}
              className="w-full rounded border border-zinc-800 px-2 py-1.5 text-left enabled:hover:border-zinc-500 enabled:hover:bg-zinc-800 disabled:cursor-default">
              <div className="flex justify-between text-sm"><span>{j.title}</span><span className="font-mono text-zinc-500">{j.kind}</span></div>
              <div className="text-xs text-zinc-500">{j.sub}</div>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Stand-in for the metrics panel.
function MetricsPlaceholder({ snapshot }: { snapshot: SimSnapshot }) {
  const m = snapshot.metrics;
  const amb = snapshot.ambulance;
  const rows: [string, string][] = [
    ['open requests', String(m.requests)],
    ['λ / min', String(m.lambdaPerMin)],
    ['ρ', m.rho.toFixed(2)],
    ['stuck', String(m.stuck)],
    ['blocking veh·min', m.blockingVehMin.toFixed(0)],
    ['dark nodes', String(m.darkCount)],
    ['ambulance', amb ? `${amb.status} · ${amb.tripS.toFixed(0)} s` : '—'],
  ];
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <h2 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">{snapshot.mode === 'FIFO' ? 'FIFO' : 'DARK GRID'}</h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500">{k}</dt><dd className="text-right font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Stand-in for MetricsChart: open requests over time, both cities.
function ChartPlaceholder({ data }: { data: ChartPoint[] }) {
  const W = 600, H = 200;
  const maxT = Math.max(60, ...data.map((d) => d.t));
  const maxY = Math.max(10, ...data.map((d) => Math.max(d.fifo, d.darkgrid)));
  const line = (key: 'fifo' | 'darkgrid') =>
    data.map((d) => `${(d.t / maxT) * W},${H - (d[key] / maxY) * H}`).join(' ');
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <h2 className="mb-2 flex gap-4 text-xs uppercase tracking-wider text-zinc-500">
        <span>MetricsChart placeholder · open requests</span>
        <span className="text-rose-400">FIFO</span><span className="text-emerald-400">DARK GRID</span>
      </h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Open requests over time">
        <polyline points={line('fifo')} fill="none" stroke="#fb7185" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <polyline points={line('darkgrid')} fill="none" stroke="#34d399" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}
