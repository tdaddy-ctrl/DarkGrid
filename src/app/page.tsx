'use client';

// Main page: runs a FIFO city and a DARK GRID city side by side from the same seed.
// Sim state lives in refs (mutated every frame); React state is a copy refreshed at most
// 4 times per second, so 250 cars never cause 60 re-renders a second.
// The *Placeholder components below stand in for C's and D's real components.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ChartPoint, FrameLite, Job, LatLng, RoadGraph, SimSnapshot } from '@/types/sim';
import {
  answerJob, createSim, getSnapshot, injectEvent, makeGridGraph, setControl, step, type Sim,
} from '@/lib/sim';
import { HISTORY_EVERY_S, REVIEW_LOCK_REAL_S, SEED, SIM_SPEED } from '@/lib/config';
import { loadRoadGraph } from '@/lib/graph';
import { createHistory, push as pushHistory, frameAt, range as historyRange, type History } from '@/lib/history';
import type { ChaosResult } from '@/app/api/analyze-chaos/route';
import ChaosInjectorPanel from '@/components/ChaosInjectorPanel';
import AskWhyBar from '@/components/AskWhyBar';
import TacticalMap3D from '@/components/TacticalMap3D';
import TimelineScrubber from '@/components/TimelineScrubber';

const STEP_S = 0.5;          // fixed sim timestep
const UI_EVERY_MS = 250;     // React state updates at most 4x per second
const CHART_EVERY_S = 2;     // one ChartPoint every 2 sim-seconds
const MAX_FRAME_S = 0.25;    // a stalled tab doesn't fast-forward minutes at once

type Mode = SimSnapshot['mode'];
type View = {
  fifo: SimSnapshot; darkgrid: SimSnapshot; chart: ChartPoint[];
  historyRange: ReturnType<typeof historyRange>; outageT: number | null; isLive: boolean;
};

// HistoryFrame stores drawing data; retain the remaining snapshot fields separately,
// with the same eviction boundary, so queue/operator/policy displays rewind together.
function historyContext(s: SimSnapshot): Omit<SimSnapshot, keyof FrameLite> {
  return { mode: s.mode, control: s.control, manual: s.manual, darkNodes: s.darkNodes,
    operators: s.operators, policy: s.policy };
}

function liteFrame(s: SimSnapshot): FrameLite {
  return { t: s.t, vehicles: s.vehicles, ambulance: s.ambulance, corridor: s.corridor,
    lots: s.lots, metrics: s.metrics, jobs: s.jobs.slice(0, 8) };
}
type Environment = 'SF' | 'GRID';
const ENVIRONMENT_LABELS = { SF: 'San Francisco', GRID: 'Test Grid' };

export default function Home() {
  const [environment, setEnvironment] = useState<Environment>('SF');
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<{
    environment: Environment; generation: number; graph?: RoadGraph; error?: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        let graph: RoadGraph;
        if (environment === 'GRID') {
          graph = makeGridGraph();
        } else {
          const response = await fetch('/data/soma_roads.json', { signal: controller.signal });
          if (!response.ok) throw new Error(`Road data request failed (HTTP ${response.status})`);
          graph = loadRoadGraph(await response.json());
          if (!graph.nodes.length || !graph.edges.length) throw new Error('Road data is empty');
        }
        if (!controller.signal.aborted) setLoaded({ environment, generation, graph });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded({ environment, generation,
          error: error instanceof Error ? error.message : 'Unable to load road data' });
      }
    }
    void load();
    return () => controller.abort();
  }, [environment, generation]);

  // A changed selection immediately unmounts the old run, before the next load completes.
  const current = loaded?.environment === environment && loaded.generation === generation ? loaded : null;
  const envSelect = (
    <>
      <label htmlFor="simulation-environment" className="sr-only">Environment</label>
      <select id="simulation-environment" value={environment}
        onChange={event => { setEnvironment(event.target.value as Environment); setGeneration(n => n + 1); }}
        className="min-h-9 rounded-md border border-dg-line bg-[#0c111a] px-2 font-mono text-xs uppercase tracking-[0.12em] text-slate-200">
        <option value="SF">San Francisco</option>
        <option value="GRID">Test Grid</option>
      </select>
    </>
  );
  return (
    <>
      {current?.graph ? (
        <Simulation key={`${environment}-${generation}`} graph={current.graph}
          onReset={() => setGeneration(n => n + 1)} envSelect={envSelect} />
      ) : (
        <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 p-6">
          <div className="flex items-center gap-2">{envSelect}</div>
          {current?.error ? (
            <>
              <p role="alert" className="text-dg-red">Unable to load {ENVIRONMENT_LABELS[environment]}: {current.error}</p>
              <button className={btn('ghost')} onClick={() => setGeneration(n => n + 1)}>Retry</button>
              {environment === 'SF' && <button className={btn('cyan')}
                onClick={() => { setEnvironment('GRID'); setGeneration(n => n + 1); }}>Use Test Grid</button>}
            </>
          ) : <p role="status" className="dg-label">Loading {ENVIRONMENT_LABELS[environment]}…</p>}
        </main>
      )}
    </>
  );
}

// Each environment/run gets its own component instance: refs, clocks and controls reset together.
function Simulation({ graph, onReset, envSelect }: { graph: RoadGraph; onReset: () => void; envSelect: ReactNode }) {
  const simsRef = useRef<{ fifo: Sim; darkgrid: Sim } | null>(null);
  const chartRef = useRef<ChartPoint[]>([]);
  const pausedRef = useRef(false);
  const historyRef = useRef<History | null>(null);
  const historyContextRef = useRef(new Map<number, {
    fifo: ReturnType<typeof historyContext>; darkgrid: ReturnType<typeof historyContext>;
  }>());
  const playbackTRef = useRef<number | null>(null);

  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<Mode>('DARKGRID');
  const [paused, setPaused] = useState(false);
  const [judge, setJudge] = useState<Mode | null>(null);   // which city the judge is operating
  const [split, setSplit] = useState(false);                // both cities side by side
  const [proposal, setProposal] = useState<ChaosResult | null>(null);   // Claude's draft for the zone card

  const publish = useCallback(() => {
    const sims = simsRef.current;
    if (!sims) return;
    const history = historyRef.current;
    const bounds = history ? historyRange(history) : null;
    const recorded = history && bounds && playbackTRef.current !== null
      ? frameAt(history, Math.max(bounds.start, Math.min(bounds.end, playbackTRef.current))) : null;
    const context = recorded ? historyContextRef.current.get(recorded.t) : null;
    const isLive = !recorded || !context;
    const fifo: SimSnapshot = recorded && context ? { ...context.fifo, ...recorded.fifo } : getSnapshot(sims.fifo);
    const darkgrid: SimSnapshot = recorded && context ? { ...context.darkgrid, ...recorded.darkgrid } : getSnapshot(sims.darkgrid);
    playbackTRef.current = isLive ? null : fifo.t;
    setView({ fifo, darkgrid,
      chart: isLive ? [...chartRef.current] : chartRef.current.filter(point => point.t <= fifo.t),
      historyRange: bounds, outageT: sims.fifo.outageT, isLive });
  }, []);

  const recordHistory = useCallback(() => {
    const sims = simsRef.current, history = historyRef.current;
    if (!sims || !history) return;
    const fifo = getSnapshot(sims.fifo), darkgrid = getSnapshot(sims.darkgrid);
    pushHistory(history, { t: fifo.t, fifo: liteFrame(fifo), darkgrid: liteFrame(darkgrid) });
    historyContextRef.current.set(fifo.t, structuredClone({ fifo: historyContext(fifo), darkgrid: historyContext(darkgrid) }));
    const bounds = historyRange(history);
    if (bounds) for (const t of historyContextRef.current.keys()) {
      if (t < bounds.start) historyContextRef.current.delete(t);
    }
  }, []);

  const freshSims = useCallback(() => {
    simsRef.current = { fifo: createSim(graph, SEED, 'FIFO'), darkgrid: createSim(graph, SEED, 'DARKGRID') };
    chartRef.current = [];
    historyRef.current = createHistory();
    historyContextRef.current.clear();
    playbackTRef.current = null;
    recordHistory(); // Keep t=0; subsequent records happen only at sim-time boundaries.
  }, [graph, recordHistory]);

  const onScrub = useCallback((t: number) => {
    const history = historyRef.current;
    const bounds = history ? historyRange(history) : null;
    if (!history || !bounds || !Number.isFinite(t)) return;
    const recorded = frameAt(history, Math.max(bounds.start, Math.min(bounds.end, t)));
    if (!recorded) return;
    playbackTRef.current = recorded.t;
    publish();
  }, [publish]);

  const onGoLive = useCallback(() => {
    playbackTRef.current = null;
    publish();
  }, [publish]);

  // The judge becomes the only operator of one city; the other city stays automatic.
  const takeOver = useCallback((m: Mode | null) => {
    const sims = simsRef.current;
    if (!sims) return;
    playbackTRef.current = null;
    setControl(sims.fifo, m === 'FIFO' ? 'MANUAL' : 'AUTO');
    setControl(sims.darkgrid, m === 'DARKGRID' ? 'MANUAL' : 'AUTO');
    setJudge(m);
    if (m) setMode(m);
    publish();
  }, [publish]);

  // The judge answers in their city. Without a judge, the presenter can still approve the
  // zone-policy card in the city on screen (automatic operators never approve policy).
  const onAnswer = useCallback((jobId: string) => {
    const sims = simsRef.current;
    if (!sims || playbackTRef.current !== null) return;
    answerJob((judge ?? mode) === 'FIFO' ? sims.fifo : sims.darkgrid, jobId);
    publish();
  }, [judge, mode, publish]);

  const blackout = useCallback(() => {
    const sims = simsRef.current;
    if (!sims) return;
    playbackTRef.current = null;
    injectEvent(sims.fifo, { type: 'OUTAGE' });
    injectEvent(sims.darkgrid, { type: 'OUTAGE' });
    publish();
  }, [publish]);

  // Only OUTAGE drives the sim today; the other event types are shown but change nothing.
  // Claude's analysis becomes the draft on the zone-policy card; a human still approves it.
  const onChaos = useCallback((r: ChaosResult) => {
    if (r.event.type !== 'OUTAGE') return;
    setProposal(r);
    blackout();
  }, [blackout]);

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
          if (Math.floor(sims.fifo.t / HISTORY_EVERY_S) > Math.floor(before / HISTORY_EVERY_S)) {
            recordHistory();
          }
        }
      }
      if (now - lastUi >= UI_EVERY_MS) { publish(); lastUi = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [freshSims, publish, recordHistory]);

  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };

  if (!view) {
    return (
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3">
        <span aria-hidden="true" className="size-2 rounded-full bg-current text-dg-cyan [animation:dg-breathe_1.6s_ease-in-out_infinite]" />
        <p className="dg-label">Booting simulation</p>
      </main>
    );
  }
  const snap = mode === 'FIFO' ? view.fifo : view.darkgrid;
  const outage = view.fifo.darkNodes.length > 0;
  const phase: { label: string; tone: Tone } = !view.isLive
    ? { label: 'Replay', tone: 'cyan' } : judge
    ? { label: `Judge · ${cityShort(judge)}`, tone: 'red' }
    : outage ? { label: 'Blackout', tone: 'amber' } : { label: 'Nominal', tone: 'cyan' };
  const timeline = <TimelineScrubber range={view.historyRange} t={snap.t} isLive={view.isLive}
    outageT={view.outageT} onScrub={onScrub} onGoLive={onGoLive} />;

  return (
    <main className="relative z-10 mx-auto flex w-full max-w-[1920px] flex-1 flex-col gap-3 p-3 lg:h-screen lg:max-h-screen lg:flex-none lg:overflow-hidden lg:p-4">
      <header className="dg-panel flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 px-4 py-2.5 xl:flex-nowrap">
        <div className="mr-auto flex items-center gap-3">
          <BrandMark />
          <div>
            <h1 className="font-display text-xl font-semibold tracking-[0.22em] text-slate-50">DARK GRID</h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-dg-label">Remote ops · SoMa / Mission</p>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <StatusPill tone={phase.tone} label={phase.label} />
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-dg-label">Sim clock</p>
            <p className="font-mono text-lg leading-tight tabular-nums text-slate-50">T+{formatT(snap.t)}</p>
          </div>
        </div>
        <nav aria-label="Demo controls" className="flex flex-wrap items-center gap-2 xl:flex-nowrap">
          {envSelect}
          <div className="flex rounded-lg border border-dg-line bg-black/30 p-0.5" role="group" aria-label="City on screen">
            {(['FIFO', 'DARKGRID'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
                className={`min-h-9 whitespace-nowrap rounded-md px-3 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
                  mode === m
                    ? m === 'FIFO' ? 'bg-slate-200 text-slate-950' : 'bg-dg-cyan text-slate-950 shadow-[0_0_18px_-4px_rgba(56,189,248,.8)]'
                    : 'text-slate-300 hover:text-slate-50'}`}>
                {cityShort(m)}
              </button>
            ))}
          </div>
          <button onClick={blackout} disabled={view.outageT !== null} className={btn('amber')}>Blackout</button>
          {judge === null && <button onClick={() => takeOver('FIFO')} className={btn('red')}>Judge takes over</button>}
          {judge === 'FIFO' && <button onClick={() => takeOver('DARKGRID')} className={btn('cyan')}>Dark Grid on</button>}
          {judge !== null && <button onClick={() => takeOver(null)} className={btn('ghost')}>Auto operators</button>}
          <button onClick={() => setSplit((v) => !v)} aria-pressed={split} className={btn(split ? 'cyan' : 'ghost')}>
            {split ? 'Single view' : 'Split view'}
          </button>
          <button onClick={togglePause} className={btn('ghost')}>{paused ? 'Resume' : 'Pause'}</button>
          <button onClick={onReset} className={btn('ghost')}>Reset</button>
        </nav>
      </header>

      <div className="grid min-h-0 gap-3 lg:flex-[62] lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        {split ? (
          /* Same seed, same blackout: the only difference between the two maps is the dispatch policy. */
          <div className="flex min-h-0 flex-col gap-3">
            <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
              <MapPlaceholder snapshot={view.fifo} graph={graph} other={view.darkgrid} />
              <MapPlaceholder snapshot={view.darkgrid} graph={graph} other={view.fifo} />
            </div>
            {timeline}
          </div>
        ) : (
          <section className="dg-panel flex min-h-[440px] flex-col overflow-hidden lg:min-h-0">
            <PanelHeader title={`Tactical map · ${cityShort(snap.mode)}`} tone={outage ? 'amber' : 'cyan'}>
              <Badge>{snap.vehicles.length} units</Badge>
              {outage && <Badge tone="amber">{snap.darkNodes.length} dark</Badge>}
            </PanelHeader>
            <div className="relative min-h-0 flex-1">
              <TacticalMap3D snapshot={snap} graph={graph}
                fallback={<MapPlaceholder snapshot={snap} graph={graph} rival={mode === 'FIFO' ? view.darkgrid : view.fifo} />} />
              <PatientClock snapshot={snap} rival={mode === 'FIFO' ? view.darkgrid : view.fifo} />
            </div>
            {timeline}
          </section>
        )}
        <QueuePlaceholder snapshot={snap} onAnswer={onAnswer}
          proposal={outage ? proposal : null} readOnly={!view.isLive} />
      </div>

      <div className="grid min-h-0 gap-3 md:grid-cols-2 lg:flex-[28] xl:grid-cols-4">
        <KpiPanel snapshot={mode === 'FIFO' ? view.darkgrid : view.fifo} other={snap} />
        <ChartPlaceholder data={view.chart} />
        <ChaosInjectorPanel onResult={onChaos} />
        <AskWhyBar key={view.isLive ? 'live' : snap.t} jobs={snap.jobs} />
      </div>
    </main>
  );
}

function formatT(t: number): string {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const cityShort = (m: Mode) => (m === 'FIFO' ? 'FIFO' : 'DARK GRID');

// ---------- shared HUD pieces ----------

type Tone = 'cyan' | 'amber' | 'red' | 'green' | 'idle';

const TONE_TEXT: Record<Tone, string> = {
  cyan: 'text-dg-cyan', amber: 'text-dg-amber', red: 'text-dg-red', green: 'text-dg-green', idle: 'text-slate-500',
};

function btn(tone: 'amber' | 'red' | 'cyan' | 'ghost'): string {
  const base = 'min-h-9 whitespace-nowrap rounded-lg px-3 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-all duration-200 enabled:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-40';
  const tones = {
    amber: 'bg-linear-to-b from-[#ffd46b] to-dg-amber text-slate-950 shadow-[0_0_20px_-6px_rgba(255,184,0,.7)] enabled:hover:shadow-[0_0_28px_-4px_rgba(255,184,0,.9)]',
    red: 'bg-linear-to-b from-[#ff8ba0] to-dg-red text-slate-950 shadow-[0_0_20px_-6px_rgba(255,42,84,.7)] enabled:hover:shadow-[0_0_28px_-4px_rgba(255,42,84,.9)]',
    cyan: 'bg-linear-to-b from-[#7dd3fc] to-dg-cyan text-slate-950 shadow-[0_0_20px_-6px_rgba(56,189,248,.8)] enabled:hover:shadow-[0_0_28px_-4px_rgba(56,189,248,1)]',
    ghost: 'border border-dg-line bg-white/[0.03] text-slate-200 enabled:hover:border-white/20 enabled:hover:bg-white/[0.07]',
  };
  return `${base} ${tones[tone]}`;
}

function Dot({ tone, pulse = true }: { tone: Tone; pulse?: boolean }) {
  return (
    <span aria-hidden="true"
      className={`inline-block size-1.5 shrink-0 rounded-full bg-current ${TONE_TEXT[tone]} ${pulse && tone !== 'idle' ? '[animation:dg-breathe_2s_ease-in-out_infinite]' : ''}`} />
  );
}

function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-current/30 bg-current/[0.06] px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] ${TONE_TEXT[tone]}`}>
      <Dot tone={tone} />{label}
    </span>
  );
}

function Badge({ children, tone = 'idle' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`rounded-md border border-dg-line bg-black/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.12em] tabular-nums ${tone === 'idle' ? 'text-slate-300' : TONE_TEXT[tone]}`}>
      {children}
    </span>
  );
}

function PanelHeader({ title, tone, titleClass = '', children }: { title: string; tone: Tone; titleClass?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dg-line px-4 py-3">
      <h2 className={`dg-label flex items-center gap-2 ${titleClass}`}><Dot tone={tone} />{title}</h2>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28" className="size-8">
      <rect x="0.5" y="0.5" width="27" height="27" rx="6" fill="none" stroke="rgb(56 189 248 / 0.45)" />
      {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (
        <rect key={`${r}${c}`} x={6 + c * 6} y={6 + r * 6} width="4" height="4" rx="1"
          fill={r === 1 && c === 1 ? '#38bdf8' : 'rgb(148 163 184 / 0.35)'} />
      )))}
    </svg>
  );
}

// ---------- placeholders (delete each one when the real component lands) ----------

// Vehicle colors; C's MapView should use the same ones.
const STATE_COLOR: Record<string, string> = {
  DRIVING: '#34d399', REQUESTING_HELP: '#ff2a54', QUEUED_BEHIND: '#fb923c', STAGED: '#38bdf8', ARRIVED: '#94a3b8',
};
const LEGEND: [string, string][] = [
  ['Driving', STATE_COLOR.DRIVING], ['Needs help', STATE_COLOR.REQUESTING_HELP],
  ['Queued', STATE_COLOR.QUEUED_BEHIND], ['Staged', STATE_COLOR.STAGED],
];

// Stand-in for MapView: an SVG of the road graph. With `other`, it is one half of the split
// view: the header names the policy and a strip under the map compares the two cities.
function MapPlaceholder({ snapshot, graph, other, rival = other }: {
  snapshot: SimSnapshot; graph: RoadGraph; other?: SimSnapshot; rival?: SimSnapshot;
}) {
  const uid = useId().replace(/:/g, '');
  const lats = graph.nodes.map((n) => n.lat), lngs = graph.nodes.map((n) => n.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const W = 1000, H = 1000, pad = 60;
  const px = (p: LatLng) => pad + ((p.lng - minLng) / (maxLng - minLng || 1)) * (W - 2 * pad);
  const py = (p: LatLng) => H - pad - ((p.lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * pad);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const roads = graph.edges.map((e) => {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    return { id: e.id, x1: px(a), y1: py(a), x2: px(b), y2: py(b) };
  });
  const amb = snapshot.ambulance;
  const outage = snapshot.darkNodes.length > 0;
  const corridor = snapshot.corridor.map((p) => `${px(p)},${py(p)}`).join(' ');

  return (
    <section className="dg-panel flex min-h-[440px] flex-col overflow-hidden lg:min-h-0">
      <PanelHeader
        title={other ? (snapshot.mode === 'FIFO' ? 'First come, first served' : 'DARK GRID') : `Tactical map · ${cityShort(snapshot.mode)}`}
        tone={other ? (snapshot.mode === 'FIFO' ? 'red' : 'cyan') : outage ? 'amber' : 'cyan'}
        titleClass={other ? `font-display text-[13px]! font-semibold ${snapshot.mode === 'FIFO' ? 'text-dg-red!' : 'text-dg-cyan!'}` : ''}>
        <Badge>{snapshot.vehicles.length} units</Badge>
        {outage && <Badge tone="amber">{snapshot.darkNodes.length} dark</Badge>}
      </PanelHeader>
      <div className="relative flex-1">
        <Brackets />
        <PatientClock snapshot={snapshot} rival={rival} />
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" role="img"
          aria-label={`${cityShort(snapshot.mode)} city: ${snapshot.vehicles.length} vehicles, ${snapshot.darkNodes.length} dark intersections`}>
          <defs>
            <pattern id={`${uid}grid`} width="25" height="25" patternUnits="userSpaceOnUse">
              <path d="M25 0H0V25" fill="none" stroke="rgb(148 163 184 / 0.07)" strokeWidth="1" />
            </pattern>
            <filter id={`${uid}glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <rect width={W} height={H} fill={`url(#${uid}grid)`} />

          <g stroke="rgb(56 189 248 / 0.07)" strokeWidth={14} strokeLinecap="round">
            {roads.map(({ id, ...r }) => <line key={id} {...r} />)}
          </g>
          <g stroke="#2a3a55" strokeWidth={3} strokeLinecap="round">
            {roads.map(({ id, ...r }) => <line key={id} {...r} />)}
          </g>

          {snapshot.corridor.length > 1 && (
            <g>
              <polyline points={corridor} fill="none" stroke="#ffb800" strokeOpacity={0.18} strokeWidth={22} strokeLinejoin="round" />
              <polyline points={corridor} fill="none" stroke="#ffb800" strokeWidth={4} strokeLinejoin="round" filter={`url(#${uid}glow)`} />
              <polyline points={corridor} fill="none" stroke="#fff7d6" strokeWidth={2} strokeDasharray="10 22" strokeLinejoin="round">
                <animate attributeName="stroke-dashoffset" from="64" to="0" dur="1.4s" repeatCount="indefinite" />
              </polyline>
            </g>
          )}

          {snapshot.darkNodes.map((p, i) => (
            <g key={i} transform={`translate(${px(p)} ${py(p)})`}>
              <circle r={8} fill="none" stroke="#ff2a54" strokeWidth={1.5}>
                <animate attributeName="r" values="8;26" dur="2.4s" begin={`${(i % 6) * 0.4}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0" dur="2.4s" begin={`${(i % 6) * 0.4}s`} repeatCount="indefinite" />
              </circle>
              <circle r={5} fill="#ff2a54" opacity={0.85} />
            </g>
          ))}

          {snapshot.lots.map((l, i) => {
            const x = px(l.pos), y = py(l.pos), s = 26, k = 9;
            return (
              <g key={i} stroke="#38bdf8" fill="none" strokeWidth={2}>
                <path d={`M${x - s},${y - s + k}V${y - s}H${x - s + k} M${x + s - k},${y - s}H${x + s}V${y - s + k} M${x + s},${y + s - k}V${y + s}H${x + s - k} M${x - s + k},${y + s}H${x - s}V${y + s - k}`} />
                <rect x={x - s} y={y + s + 6} width={2 * s} height={4} fill="rgb(56 189 248 / 0.15)" stroke="none" />
                <rect x={x - s} y={y + s + 6} width={(2 * s * l.used) / l.cap} height={4} fill="#38bdf8" stroke="none" />
                <text x={x} y={y - s - 8} fill="#38bdf8" stroke="none" fontSize={18} textAnchor="middle"
                  fontFamily="var(--font-jetbrains)">{l.used}/{l.cap}</text>
              </g>
            );
          })}

          {snapshot.vehicles.map((v) => {
            const help = v.state === 'REQUESTING_HELP';
            return (
              <g key={v.id} transform={`translate(${px(v.pos)} ${py(v.pos)})`}>
                {help && <circle r={11} fill={STATE_COLOR[v.state]} opacity={0.22} />}
                <circle r={help ? 6 : 4.5} fill={STATE_COLOR[v.state]} />
              </g>
            );
          })}

          {amb && (
            <g transform={`translate(${px(amb.pos)} ${py(amb.pos)})`}>
              <circle r={24} fill="#ffb800" opacity={0.18}>
                <animate attributeName="r" values="18;30;18" dur="1.6s" repeatCount="indefinite" />
              </circle>
              <path transform={`rotate(${amb.headingDeg})`} d="M0,-16 L11,12 L0,6 L-11,12 Z" fill="#ffffff" stroke="#ffb800" strokeWidth={3} />
            </g>
          )}
        </svg>

        <ul className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-dg-line bg-black/50 px-2.5 py-1.5 backdrop-blur">
          {LEGEND.map(([label, color]) => (
            <li key={label} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-dg-label">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
              {label}
            </li>
          ))}
          <li className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-dg-label">
            <span aria-hidden="true" className="h-0.5 w-3 rounded bg-dg-amber" />Corridor
          </li>
        </ul>
      </div>
      {other && <SplitStrip snapshot={snapshot} other={other} />}
    </section>
  );
}

// Three numbers under each split-view map: requests waiting, load, ambulance.
function SplitStrip({ snapshot, other }: { snapshot: SimSnapshot; other: SimSnapshot }) {
  const m = snapshot.metrics, o = other.metrics, a = snapshot.ambulance;
  const dg = snapshot.mode === 'DARKGRID';
  const accent = dg ? 'text-dg-cyan' : 'text-dg-red';
  const ambTone: Tone = !a ? 'idle' : a.status === 'ARRIVED' ? 'green' : a.status === 'STUCK' ? 'red' : a.status === 'EN_ROUTE' ? 'cyan' : 'idle';
  const cell = 'min-w-0 px-4 py-3';
  return (
    <div className="grid grid-cols-3 divide-x divide-dg-line border-t border-dg-line">
      <div className={cell}>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dg-label">Requests waiting</p>
        <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent}`}>{m.requests}</p>
        <div className="mt-2 h-1 rounded-full bg-white/[0.06]">
          <div className={`h-full rounded-full bg-current transition-[width] duration-500 ${accent}`}
            style={{ width: `${(m.requests / Math.max(m.requests, o.requests, 1)) * 100}%` }} />
        </div>
      </div>
      <div className={cell}>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dg-label">Load ρ</p>
        <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${m.rho > 1 ? 'text-dg-red' : m.rho > 0.7 ? 'text-dg-amber' : 'text-dg-cyan'}`}>{m.rho.toFixed(2)}</p>
        <p className="mt-1 font-mono text-[10px] text-slate-500">{m.rho > 1 ? 'over capacity' : 'within capacity'}</p>
      </div>
      <div className={cell}>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dg-label">Ambulance</p>
        <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${a ? 'text-slate-50' : 'text-slate-600'}`}>{a ? formatT(a.tripS) : '--:--'}</p>
        <span className={`mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.14em] ${TONE_TEXT[ambTone]}`}>
          <Dot tone={ambTone} pulse={a?.status === 'STUCK'} />{a ? a.status.replace('_', ' ') : 'STANDBY'}
        </span>
      </div>
    </div>
  );
}

// Over each map: a patient clock that runs while the ambulance is on its way and stops on
// arrival, plus how much sooner this city delivered the patient than the other one.
function PatientClock({ snapshot, rival }: { snapshot: SimSnapshot; rival?: SimSnapshot }) {
  const a = snapshot.ambulance;
  if (!a || a.status === 'WAITING') return null;
  const arrived = a.status === 'ARRIVED';
  const r = rival?.ambulance;
  const lead = arrived && r && r.status !== 'WAITING' ? r.tripS - a.tripS : 0;
  return (
    <div role="status" className="pointer-events-none absolute left-1/2 top-4 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className={`flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] backdrop-blur ${
        arrived ? 'border-dg-green/50 bg-dg-green/10 text-dg-green' : 'border-dg-red/60 bg-dg-red/15 text-dg-red shadow-[0_0_24px_-6px_rgba(255,42,84,.8)]'}`}>
        {arrived ? (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3 3 7-7" /></svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 40 16" className="h-3.5 w-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <polyline points="0,8 10,8 13,3 17,13 20,8 26,8 28,5 30,8 40,8" pathLength="100" className="[stroke-dasharray:100] [animation:dg-ecg_1.2s_linear_infinite]" />
          </svg>
        )}
        <span>{arrived ? 'Patient delivered' : a.status === 'STUCK' ? 'Ambulance stuck' : 'Patient waiting'}</span>
        <span className={`text-sm tabular-nums ${arrived ? '' : 'inline-block [animation:dg-heartbeat_1s_ease-in-out_infinite]'}`}>{formatT(a.tripS)}</span>
      </div>
      {lead >= 30 && rival && (
        <div className="whitespace-nowrap rounded-full border border-dg-cyan/50 bg-dg-cyan/10 px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.14em] text-dg-cyan backdrop-blur">
          {r!.status === 'ARRIVED' ? '' : '≥ '}{formatT(lead)} faster than {cityShort(rival.mode)}
        </div>
      )}
    </div>
  );
}

function Brackets() {
  const c = 'pointer-events-none absolute size-4 border-dg-cyan/50';
  return (
    <>
      <span aria-hidden="true" className={`${c} left-3 top-3 border-l border-t`} />
      <span aria-hidden="true" className={`${c} right-3 top-3 border-r border-t`} />
      <span aria-hidden="true" className={`${c} bottom-3 right-3 border-b border-r`} />
      <span aria-hidden="true" className={`${c} bottom-3 left-3 border-b border-l`} />
    </>
  );
}

const KIND_PILL: Record<Job['kind'], string> = {
  ZONE_POLICY: 'bg-dg-cyan text-slate-950',
  BATCH: 'border border-dg-cyan/50 text-dg-cyan',
  CORRIDOR: 'border border-dg-amber/50 text-dg-amber',
  STUCK: 'border border-dg-orange/50 text-dg-orange',
  SINGLE: 'border border-white/15 text-slate-300',
  FIFO: 'border border-white/15 text-slate-300',
};

// Stand-in for RequestQueuePanel. In MANUAL the cards are clickable; the zone-policy card
// is clickable for whoever is presenting, judge or not.
function QueuePlaceholder({ snapshot, onAnswer, proposal, readOnly = false }: {
  snapshot: SimSnapshot; onAnswer: (jobId: string) => void; proposal?: ChaosResult | null; readOnly?: boolean;
}) {
  const manual = snapshot.control === 'MANUAL';
  const locked = snapshot.manual.lockRemainingS > 0;
  const m = snapshot.metrics;
  const util = Math.min(m.rho / 6.5, 1);
  const rhoTone: Tone = m.rho > 1 ? 'red' : m.rho > 0.7 ? 'amber' : 'cyan';
  const shown = snapshot.jobs.slice(0, 12);

  return (
    <section className="dg-panel flex min-h-[440px] flex-col overflow-hidden lg:min-h-0">
      <PanelHeader title="Request queue" tone={snapshot.jobs.length ? (manual ? 'red' : 'cyan') : 'idle'}>
        <Badge>REQ {m.requests}</Badge>
        <Badge>JOBS {readOnly ? m.jobs : snapshot.jobs.length}</Badge>
      </PanelHeader>

      {readOnly && <p className="border-b border-dg-line px-4 py-2 text-xs text-dg-label">
        Recorded queue (up to 8 jobs). Go LIVE to answer requests.
      </p>}

      <div className="space-y-3 border-b border-dg-line px-4 py-3">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="dg-label">Operator load ρ</span>
            <span className={`font-mono text-2xl font-semibold tabular-nums ${TONE_TEXT[rhoTone]}`}>{m.rho.toFixed(2)}</span>
          </div>
          <div className="relative mt-1.5 h-1.5 rounded-full bg-white/[0.06]">
            <div className={`h-full rounded-full bg-current transition-[width] duration-500 ${TONE_TEXT[rhoTone]}`} style={{ width: `${util * 100}%` }} />
            <span aria-hidden="true" className="absolute -top-1 h-3.5 w-px bg-white/80" style={{ left: `${100 / 6.5}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-dg-label">ρ above 1 means requests arrive faster than operators can answer.</p>
        </div>

        <ul className="space-y-1">
          {snapshot.operators.map((op) => {
            const busy = op.task !== 'idle';
            const reviewing = manual && locked;
            return (
              <li key={op.id} className="flex items-center gap-2 rounded-lg border border-dg-line bg-white/[0.02] px-2 py-1.5">
                <span className="w-12 shrink-0 font-mono text-[11px] uppercase text-slate-400">{op.id}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.14em] ${
                  busy ? 'bg-dg-cyan/15 text-dg-cyan shadow-[0_0_10px_-2px_rgba(56,189,248,.6)]' : 'bg-white/[0.05] text-slate-500'}`}>
                  {busy ? 'ACTIVE' : 'IDLE'}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{busy ? op.task : 'Standing by'}</span>
                {reviewing && (
                  <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-white/10">
                    <span className="block h-full bg-dg-red" style={{ width: `${(1 - snapshot.manual.lockRemainingS / REVIEW_LOCK_REAL_S) * 100}%` }} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {manual && !readOnly && (
        <p className="flex items-center justify-between gap-2 border-b border-dg-red/30 bg-dg-red/10 px-4 py-2 text-sm text-[#ffc2cd]">
          <span>{locked ? `Reviewing… ${snapshot.manual.lockRemainingS.toFixed(1)} s` : 'You are the operator. Click a card.'}</span>
          <span className="font-mono text-xs tabular-nums">YOU {snapshot.manual.answered} · WAITING {snapshot.jobs.length}</span>
        </p>
      )}

      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <svg aria-hidden="true" viewBox="0 0 80 80" className="size-20">
            {[34, 24, 14].map((r) => <circle key={r} cx="40" cy="40" r={r} fill="none" stroke="rgb(56 189 248 / 0.25)" strokeDasharray="3 5" />)}
            <circle cx="40" cy="40" r="3" fill="#38bdf8" />
          </svg>
          <p className="dg-label">Queue clear</p>
          <p className="text-xs text-dg-label">No robotaxi is waiting for an operator.</p>
        </div>
      ) : (
        <ol className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {shown.map((j, i) => {
            const zone = j.kind === 'ZONE_POLICY';
            return (
              <li key={j.id} className="[animation:dg-rise_.25s_ease-out]">
                <button disabled={readOnly || locked || !(manual || zone)} onClick={() => onAnswer(j.id)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 enabled:hover:-translate-y-px disabled:cursor-default ${
                    zone
                      ? 'border-dg-cyan/60 bg-dg-cyan/[0.07] shadow-[0_0_24px_-10px_rgba(56,189,248,.9)] enabled:hover:bg-dg-cyan/[0.12]'
                      : 'border-dg-line bg-white/[0.02] enabled:hover:border-white/20 enabled:hover:bg-white/[0.05]'}`}>
                  <span className="pt-0.5 font-mono text-[11px] tabular-nums text-slate-500">#{String(i + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-100">{j.title}</span>
                    <span className="block truncate text-xs text-dg-label">{j.sub}</span>
                    {zone && proposal && (
                      <span className="mt-2 block rounded-lg border border-dg-cyan/25 bg-black/30 px-2.5 py-2">
                        <span className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold tracking-[0.16em] text-dg-cyan">
                          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3" fill="currentColor"><path d="M8 0l1.6 5.2L15 7l-5.4 1.8L8 14l-1.6-5.2L1 7l5.4-1.8z" /></svg>
                          {proposal.source === 'CLAUDE' ? 'DRAFTED BY CLAUDE' : 'DRAFTED BY OFFLINE RULES'}
                        </span>
                        <span className="line-clamp-4 block text-xs leading-relaxed text-slate-200">{proposal.rationale}</span>
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.14em] ${KIND_PILL[j.kind]}`}>
                      {zone ? 'ZONE POLICY' : j.kind}
                    </span>
                    {!zone && <span className="font-mono text-[10px] tabular-nums text-slate-500">w/p {(j.w / j.p).toFixed(2)}</span>}
                    {zone && <span className="font-mono text-[10px] text-dg-cyan">Human approval</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {snapshot.jobs.length > shown.length && (
            <li className="pt-1 text-center font-mono text-[11px] text-slate-500">+{snapshot.jobs.length - shown.length} more waiting</li>
          )}
        </ol>
      )}
    </section>
  );
}

// Stand-in for the metrics panel: each number compared with the other city.
function KpiPanel({ snapshot, other }: { snapshot: SimSnapshot; other: SimSnapshot }) {
  const m = snapshot.metrics, o = other.metrics;
  const dg = snapshot.mode === 'DARKGRID';
  const otherName = cityShort(other.mode);
  const kpis: { label: string; v: number; o: number; digits?: number }[] = [
    { label: 'Open requests', v: m.requests, o: o.requests },
    { label: 'Arrivals / min', v: m.lambdaPerMin, o: o.lambdaPerMin },
    { label: 'Load ρ', v: m.rho, o: o.rho, digits: 2 },
    { label: 'Stuck vehicles', v: m.stuck, o: o.stuck },
    { label: 'Blocking veh·min', v: m.blockingVehMin, o: o.blockingVehMin },
  ];
  const amb = snapshot.ambulance;
  const ambTone: Tone = !amb ? 'idle' : amb.status === 'ARRIVED' ? 'green' : amb.status === 'STUCK' ? 'red' : amb.status === 'EN_ROUTE' ? 'cyan' : 'idle';

  return (
    <section className="dg-panel flex min-h-0 flex-col overflow-hidden">
      <PanelHeader title={dg ? 'DARK GRID · triage' : 'FIFO · first come, first served'} tone={dg ? 'cyan' : m.rho > 1 ? 'red' : 'idle'} />
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-1.5 overflow-y-auto p-2 sm:grid-cols-3">
        {kpis.map((k) => {
          const max = Math.max(k.v, k.o, 1e-9);
          const pct = k.o === 0 ? null : ((k.v - k.o) / k.o) * 100;
          const better = k.v < k.o, worse = k.v > k.o;
          return (
            <div key={k.label} className="rounded-lg border border-dg-line bg-white/[0.02] px-2.5 py-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dg-label">{k.label}</p>
              <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-50">{k.v.toFixed(k.digits ?? 0)}</p>
              <div className="mt-1.5 h-1 rounded-full bg-white/[0.06]">
                <div className={`h-full rounded-full transition-[width] duration-500 ${dg ? 'bg-dg-cyan' : 'bg-slate-400'}`} style={{ width: `${(k.v / max) * 100}%` }} />
              </div>
              <p className={`mt-1 font-mono text-[10px] tabular-nums ${better ? 'text-dg-green' : worse ? 'text-dg-red' : 'text-slate-500'}`}>
                {pct === null || (!better && !worse) ? `= ${otherName}` : `${better ? '▼' : '▲'} ${Math.abs(pct).toFixed(0)}% vs ${otherName}`}
              </p>
            </div>
          );
        })}
        <div className="rounded-lg border border-dg-line bg-white/[0.02] px-2.5 py-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dg-label">Ambulance</p>
          <p className={`mt-1 font-mono text-xl font-semibold tabular-nums ${amb ? 'text-slate-50' : 'text-slate-600'}`}>
            {amb ? formatT(amb.tripS) : '--:--'}
          </p>
          <span className={`mt-1.5 inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.14em] ${TONE_TEXT[ambTone]}`}>
            <Dot tone={ambTone} pulse={amb?.status === 'STUCK'} />{amb ? amb.status.replace('_', ' ') : 'STANDBY'}
          </span>
        </div>
      </div>
    </section>
  );
}

// Stand-in for MetricsChart: open requests over time, both cities.
function ChartPlaceholder({ data }: { data: ChartPoint[] }) {
  const uid = useId().replace(/:/g, '');
  const W = 600, H = 240, L = 38, R = 10, T = 12, B = 24;
  const maxT = Math.max(60, ...data.map((d) => d.t));
  const rawMax = Math.max(10, ...data.map((d) => Math.max(d.fifo, d.darkgrid)));
  const step = rawMax > 200 ? 100 : rawMax > 80 ? 50 : rawMax > 40 ? 20 : 10;
  const maxY = Math.ceil(rawMax / step) * step;
  const x = (t: number) => L + (t / maxT) * (W - L - R);
  const y = (v: number) => H - B - (v / maxY) * (H - T - B);
  const pts = (key: 'fifo' | 'darkgrid') => data.map((d) => `${x(d.t).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = (key: 'fifo' | 'darkgrid') =>
    data.length > 1 ? `M${x(data[0].t)},${y(0)} L${pts(key).replace(/ /g, ' L')} L${x(data[data.length - 1].t)},${y(0)} Z` : '';
  const yTicks = Array.from({ length: maxY / step + 1 }, (_, i) => i * step);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxT);
  const last = data[data.length - 1];

  return (
    <section className="dg-panel flex min-h-0 flex-col overflow-hidden">
      <PanelHeader title="Requests waiting" tone={data.length > 1 ? 'cyan' : 'idle'}>
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-slate-400">
          <span aria-hidden="true" className="w-3 border-t border-dashed border-slate-400" />FIFO
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-dg-cyan">
          <span aria-hidden="true" className="h-0.5 w-3 rounded bg-dg-cyan shadow-[0_0_6px_#38bdf8]" />DARK GRID
        </span>
      </PanelHeader>
      <div className="relative min-h-0 flex-1 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img"
          aria-label={last ? `Requests waiting at ${formatT(last.t)}: FIFO ${last.fifo}, DARK GRID ${last.darkgrid}` : 'No data yet'}>
          <defs>
            <linearGradient id={`${uid}dg`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`${uid}fifo`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgb(148 163 184 / 0.12)" strokeDasharray="3 5" />
              <text x={L - 8} y={y(v) + 4} fill="#a9b6cc" fontSize={10} textAnchor="end" fontFamily="var(--font-jetbrains)">{v}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 6} fill="#a9b6cc" fontSize={10} textAnchor="middle" fontFamily="var(--font-jetbrains)">{formatT(t)}</text>
          ))}
          {data.length > 1 && (
            <>
              <path d={area('fifo')} fill={`url(#${uid}fifo)`} />
              <polyline points={pts('fifo')} fill="none" stroke="#94a3b8" strokeWidth={1.75} strokeDasharray="5 4" strokeLinejoin="round" />
              <path d={area('darkgrid')} fill={`url(#${uid}dg)`} />
              <polyline points={pts('darkgrid')} fill="none" stroke="#38bdf8" strokeOpacity={0.3} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={pts('darkgrid')} fill="none" stroke="#38bdf8" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(last.t)} cy={y(last.fifo)} r={3} fill="#94a3b8" />
              <circle cx={x(last.t)} cy={y(last.darkgrid)} r={3.5} fill="#38bdf8" />
            </>
          )}
        </svg>
        {data.length <= 1 && (
          <p className="dg-label pointer-events-none absolute inset-0 flex items-center justify-center">Awaiting telemetry</p>
        )}
      </div>
    </section>
  );
}
