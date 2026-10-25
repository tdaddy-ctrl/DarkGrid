'use client';

// Main page: runs a FIFO city and a DARK GRID city side by side from the same seed.
// Sim state lives in refs (mutated every frame); React state is a copy refreshed at most
// 4 times per second, so 250 cars never cause 60 re-renders a second.
// Workspace navigation only changes presentation; the same simulation refs keep running.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { Shuffle, TriangleAlert } from 'lucide-react';
import { Ambulance, ArrowRight, CarFront, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Crosshair, Layers3, ListFilter, Map as MapIcon, MapPin, Maximize2, Minimize2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pause, Play, Radio, RotateCcw, Route, ShieldCheck, Sparkles, UsersRound, Zap } from 'lucide-react';
import type { ChartPoint, FrameLite, Job, LatLng, RoadGraph, SimSnapshot } from '@/types/sim';
import {
  answerJob, createSim, getMotion, getSnapshot, injectEvent, makeGridGraph, pickCollisionEdge, setControl, step, type Sim,
} from '@/lib/sim';
import { HISTORY_EVERY_S, MAX_COLLISION_INCIDENTS, SEED, SIM_SPEED } from '@/lib/config';
import { loadRoadGraph } from '@/lib/graph';
import { createHistory, push as pushHistory, frameAt, range as historyRange, type History } from '@/lib/history';
import type { ChaosResult } from '@/app/api/analyze-chaos/route';
import ChaosInjectorPanel from '@/components/ChaosInjectorPanel';
import AskWhyBar from '@/components/AskWhyBar';
import TacticalMap3D from '@/components/TacticalMap3D';
import TimelineScrubber from '@/components/TimelineScrubber';
import MetricsChart from '@/components/MetricsChart';
import ArrivalOverlay from '@/components/ArrivalOverlay';

const STEP_S = 0.5;          // fixed sim timestep
const UI_EVERY_MS = 250;     // React state updates at most 4x per second
const CHART_EVERY_S = 2;     // one ChartPoint every 2 sim-seconds
const MAX_FRAME_S = 0.25;    // a stalled tab doesn't fast-forward minutes at once
const FOLLOW_SPEED = 0.3;    // following the ambulance runs the sim in slow motion (3x instead of 10x) so the camera can keep up

type Mode = SimSnapshot['mode'];
type Surface = 'city' | 'requests' | 'compare' | 'analyze';
type View = {
  fifo: SimSnapshot; darkgrid: SimSnapshot; chart: ChartPoint[];
  historyRange: ReturnType<typeof historyRange>; outageT: number | null; isLive: boolean;
};

// HistoryFrame stores drawing data; retain the remaining snapshot fields separately,
// with the same eviction boundary, so queue/operator/policy displays rewind together.
function historyContext(s: SimSnapshot): Omit<SimSnapshot, keyof FrameLite> {
  return { mode: s.mode, control: s.control, manual: s.manual, darkNodes: s.darkNodes,
    operators: s.operators, policy: s.policy, incidents: s.incidents, corridorStatus: s.corridorStatus,
    outage: s.outage, scenario: s.scenario };
}

function liteFrame(s: SimSnapshot): FrameLite {
  return { t: s.t, vehicles: s.vehicles, ambulance: s.ambulance, corridor: s.corridor,
    lots: s.lots, metrics: s.metrics, jobs: s.jobs.slice(0, 8) };
}
type Environment = 'DOWNTOWN' | 'SF' | 'GRID';
const ENVIRONMENT_LABELS = { DOWNTOWN: 'Downtown SF', SF: 'SoMa / Mission', GRID: 'Test Grid' };
const ROAD_FILES: Record<Exclude<Environment, 'GRID'>, string> = {
  DOWNTOWN: '/data/downtown_roads.json',   // A: FiDi, Union Square, Tenderloin, north SoMa (OSM)
  SF: '/data/soma_roads.json',             // B: SoMa / Mission (osmnx)
};

// Names for wherever the random blackout lands (nearest neighborhood).
const AREAS: [string, number, number][] = [
  ['Financial District', 37.7946, -122.3999], ['Union Square', 37.7880, -122.4075], ['Chinatown', 37.7941, -122.4078],
  ['Tenderloin', 37.7847, -122.4141], ['SoMa', 37.7785, -122.4056], ['Yerba Buena', 37.7850, -122.4020],
  ['Rincon Hill', 37.7860, -122.3925], ['Civic Center', 37.7793, -122.4176], ['Nob Hill', 37.7930, -122.4161],
  ['Embarcadero', 37.7955, -122.3937], ['Mission Bay', 37.7706, -122.3910], ['Mission', 37.7599, -122.4148],
];
function areaName(p: LatLng): string {
  let best = AREAS[0], d = Infinity;
  for (const a of AREAS) { const dd = (a[1] - p.lat) ** 2 + ((a[2] - p.lng) * 0.79) ** 2; if (dd < d) { d = dd; best = a; } }
  return best[0];
}

export default function Home() {
  const [environment, setEnvironment] = useState<Environment>('DOWNTOWN');
  const [generation, setGeneration] = useState(0);
  const [seed, setSeed] = useState(SEED);
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
          const response = await fetch(ROAD_FILES[environment], { signal: controller.signal });
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
        className="environment-select">
        <option value="DOWNTOWN">Downtown SF</option>
        <option value="SF">SoMa / Mission</option>
        <option value="GRID">Test Grid</option>
      </select>
    </>
  );
  return (
    <>
      {current?.graph ? (
        <Simulation key={`${environment}-${generation}-${seed}`} graph={current.graph} seed={seed}
          onNewScenario={() => setSeed(currentSeed => {
            const next = crypto.getRandomValues(new Uint32Array(1))[0];
            return next === currentSeed ? (currentSeed + 1) >>> 0 : next;
          })}
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
function Simulation({ graph, seed, onReset, onNewScenario, envSelect }: { graph: RoadGraph; seed: number; onReset: () => void; onNewScenario: () => void; envSelect: ReactNode }) {
  const simsRef = useRef<{ fifo: Sim; darkgrid: Sim } | null>(null);
  const chartRef = useRef<ChartPoint[]>([]);
  const pausedRef = useRef(false);
  const historyRef = useRef<History | null>(null);
  const historyContextRef = useRef(new Map<number, {
    fifo: ReturnType<typeof historyContext>; darkgrid: ReturnType<typeof historyContext>;
  }>());
  const playbackTRef = useRef<number | null>(null);
  const requestPanelRef = useRef<HTMLElement | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);

  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<Mode>('DARKGRID');
  const [paused, setPaused] = useState(false);
  const [surface, setSurface] = useState<Surface>('city');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const workspaceRef = useRef<{ surface: Surface; follow: boolean }>({ surface: 'city', follow: false });
  const [act, setAct] = useState(0);
  const [follow, setFollow] = useState(false);              // 3D camera chases the ambulance
  const [expanded, setExpanded] = useState(false);          // reversible presentation mode
  const split = surface === 'compare';
  const slowRef = useRef(false);
  const ambDriving = view ? (mode === 'FIFO' ? view.fifo : view.darkgrid).ambulance?.status === 'EN_ROUTE' : false;
  useEffect(() => { slowRef.current = follow && ambDriving; }, [follow, ambDriving]);
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
    simsRef.current = { fifo: createSim(graph, seed, 'FIFO', { randomEvents: true }), darkgrid: createSim(graph, seed, 'DARKGRID', { randomEvents: true }) };
    chartRef.current = [];
    historyRef.current = createHistory();
    historyContextRef.current.clear();
    playbackTRef.current = null;
    recordHistory(); // Keep t=0; subsequent records happen only at sim-time boundaries.
  }, [graph, seed, recordHistory]);

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
    if (m) setMode(m);
    publish();
  }, [publish]);

  // The judge answers in their city. Without a judge, the presenter can still approve the
  // zone-policy card in the city on screen (automatic operators never approve policy).
  const onAnswer = useCallback((jobId: string, city: Mode) => {
    const sims = simsRef.current;
    if (!sims || playbackTRef.current !== null) return;
    const target = city === 'FIFO' ? sims.fifo : sims.darkgrid;
    const job = target.jobs.find(j => j.id === jobId);
    if (target.control !== 'MANUAL' && job?.kind !== 'ZONE_POLICY') return;
    answerJob(target, jobId);
    publish();
  }, [publish]);

  const blackout = useCallback((radiusM?: number) => {
    const sims = simsRef.current;
    if (!sims) return;
    playbackTRef.current = null;
    if (sims.fifo.outageT !== null) return;
    const plan = sims.fifo.plannedOutage;
    const event = { type: 'OUTAGE' as const, center: plan.center, radiusM: radiusM ?? plan.radiusM, restoreAfterS: plan.restoreAfterS };
    injectEvent(sims.fifo, event);
    injectEvent(sims.darkgrid, event);
    publish();
  }, [publish]);

  const collision = useCallback(() => {
    const sims = simsRef.current;
    if (!sims || playbackTRef.current !== null) return;
    const edgeId = pickCollisionEdge(sims.fifo);
    if (edgeId === undefined) return;
    injectEvent(sims.fifo, { type: 'COLLISION', edgeId });
    injectEvent(sims.darkgrid, { type: 'COLLISION', edgeId });
    publish();
  }, [publish]);

  // Claude's analysis becomes the draft on the zone-policy card; a human still approves it.
  const onChaos = useCallback((r: ChaosResult) => {
    if (playbackTRef.current !== null) return;
    if (r.event.type === 'COLLISION') { collision(); return; }
    if (r.event.type !== 'OUTAGE') return;
    setProposal(r);
    blackout(r.event.radius_m);
  }, [blackout, collision]);

  // Demo director (B's bar): one button per act of the 3-minute demo, also on keys 0-5.
  // The 3D map reads car positions straight from the sim every frame (smooth motion without
  // re-rendering React); while replaying history it falls back to the published snapshots.
  const motion = useCallback(() => {
    const sims = simsRef.current;
    if (!sims || playbackTRef.current !== null) return null;
    return getMotion(mode === 'FIFO' ? sims.fifo : sims.darkgrid);
  }, [mode]);

  const enterPresentation = useCallback((next?: Surface) => {
    if (!expanded) workspaceRef.current = { surface, follow };
    setExpanded(true);
    setSurface(next ?? (surface === 'analyze' ? 'city' : surface));
  }, [expanded, surface, follow]);

  const exitPresentation = useCallback(() => {
    setExpanded(false);
    setSurface(workspaceRef.current.surface);
    setFollow(workspaceRef.current.follow);
  }, []);

  const director = useMemo(() => [
    onReset,
    () => { blackout(); setAct(1); setSurface('city'); setFollow(false); },
    () => { takeOver('FIFO'); setAct(2); setSurface('city'); setFollow(false); },
    () => { takeOver('DARKGRID'); setAct(3); setSurface('city'); setFollow(false); },
    () => { setFollow(false); setSurface('compare'); setAct(4); },
    () => { enterPresentation('city'); setMode('DARKGRID'); setFollow(true); setAct(5); },
  ], [onReset, blackout, takeOver, enterPresentation]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || (el instanceof Element && el.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if (e.key === 'Escape' && expanded) exitPresentation();
      else if (e.key.toLowerCase() === 'm') { if (expanded) exitPresentation(); else enterPresentation(); }
      else if (/^[0-5]$/.test(e.key)) { e.preventDefault(); director[Number(e.key)](); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [director, expanded, enterPresentation, exitPresentation]);

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
        acc += realDt * SIM_SPEED * (slowRef.current ? FOLLOW_SPEED : 1);
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
  const rival = mode === 'FIFO' ? view.darkgrid : view.fifo;
  const outage = snap.darkNodes.length > 0;
  const phase = !view.isLive ? 'Replaying history' : outage ? 'Blackout active' : 'City online';
  const hazard = snap.outage ? { center: snap.outage.center, label: `${areaName(snap.outage.center)} · ${snap.outage.status === 'RESTORING' ? 'Power restoring' : 'Power outage'}` } : null;
  const pendingPolicy = snap.jobs.some(j => j.kind === 'ZONE_POLICY');
  const showLeft = !expanded && surface !== 'compare' && surface !== 'analyze' && leftOpen;
  const showRight = !expanded && surface === 'city' && rightOpen;
  const contextualQueue = expanded && !split && !follow && (snap.control === 'MANUAL' || pendingPolicy);
  const demoStep = follow ? 5 : split ? 4 : snap.control === 'MANUAL' ? (mode === 'FIFO' ? 2 : 3) : act;
  const timeline = <TimelineScrubber range={view.historyRange} t={snap.t} isLive={view.isLive}
    outageT={view.outageT} onScrub={onScrub} onGoLive={onGoLive} />;
  const changeSurface = (next: Surface) => {
    setSurface(next);
    if (next === 'requests') setLeftOpen(true);
    // The narrow workspace stacks the map above the feed. Navigation must move
    // to the destination in both directions without changing simulation state.
    if (window.matchMedia('(max-width: 760px)').matches) {
      requestAnimationFrame(() => {
        const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        if (next === 'requests') requestPanelRef.current?.scrollIntoView({ block: 'start', behavior });
        else workspaceBodyRef.current?.scrollTo({ top: 0, behavior });
      });
    }
  };

  return (
    <main className={`dg-workspace ${expanded ? 'is-presenting' : ''}`}><style>{CINEMATIC_STYLES}</style>
      <header className="workspace-header">
        <div className="workspace-brand"><BrandMark /><h1>DARK GRID</h1></div>
        <div className="workspace-environment">{expanded ? 'San Francisco' : envSelect}</div>
        <span className={`city-status ${!view.isLive ? 'is-replay' : outage ? 'is-outage' : ''}`}>
          <span aria-hidden="true" />{phase}
        </span>
        <span className="header-clock" title="Simulation time">T+{formatT(snap.t)}</span>
        <div className="header-actions">
          {!expanded && <>
            <button type="button" className="icon-button" aria-label={showLeft ? 'Hide request panel' : 'Show request panel'}
              aria-expanded={showLeft} aria-controls="request-panel"
              onClick={() => { if (surface === 'compare' || surface === 'analyze') setSurface('city'); setLeftOpen(!showLeft); }}>
              {showLeft ? <PanelLeftClose /> : <PanelLeftOpen />}
            </button>
            <button type="button" className="icon-button" aria-label={showRight ? 'Hide mission panel' : 'Show mission panel'}
              aria-expanded={showRight} aria-controls="mission-panel"
              onClick={() => { if (surface === 'compare' || surface === 'analyze') setSurface('city'); setRightOpen(!showRight); }}>
              {showRight ? <PanelRightClose /> : <PanelRightOpen />}
            </button>
          </>}
          <button type="button" className="present-button" onClick={() => expanded ? exitPresentation() : enterPresentation()}>
            {expanded ? <Minimize2 /> : <Maximize2 />}<span>{expanded ? 'Exit presentation' : 'Present'}</span>
            {expanded && <kbd>Esc</kbd>}
          </button>
          <details className="session-menu">
            <summary className="icon-button" aria-label="Session controls"><MoreHorizontal /></summary>
            <div className="session-menu-content">
              <p>Simulation controls</p>
              <button onClick={onNewScenario}><Shuffle />New random scenario</button>
              <button disabled={!view.isLive || (snap.incidents?.length ?? 0) >= MAX_COLLISION_INCIDENTS} onClick={collision}><TriangleAlert />Inject collision</button>
              <button disabled={view.outageT !== null} onClick={director[1]}><Zap />Trigger blackout <kbd>1</kbd></button>
              <button onClick={director[2]}><UsersRound />Judge takes over FIFO <kbd>2</kbd></button>
              <button onClick={director[3]}><ShieldCheck />Operate DARK GRID <kbd>3</kbd></button>
              <button onClick={() => takeOver(null)}><Radio />Automatic operators</button>
              <button onClick={togglePause}>{paused ? <Play /> : <Pause />}{paused ? 'Resume simulation' : 'Pause simulation'}</button>
              <button onClick={onReset}><RotateCcw />Reset simulation <kbd>0</kbd></button>
            </div>
          </details>
        </div>
      </header>

      <div ref={workspaceBodyRef} className="workspace-body" data-left={showLeft} data-right={showRight} data-surface={surface}
        style={{ '--left': showLeft ? surface === 'requests' ? '430px' : undefined : '0px', '--right': showRight ? undefined : '0px' } as CSSProperties}>
        <aside ref={requestPanelRef} id="request-panel" className="request-panel" hidden={!showLeft} aria-label="Live request panel">
          <RequestFeed snapshot={snap} mode={mode} onModeChange={setMode} onAnswer={onAnswer}
            proposal={outage ? proposal : null} readOnly={!view.isLive} paused={paused}
            onTakeOver={() => takeOver(snap.control === 'MANUAL' ? null : mode)}
            onBlackout={director[1]} onCollapse={() => setLeftOpen(false)} />
        </aside>

        <div className="workspace-stage">
          {/* Keep the imperative map mounted across destinations and presentation transitions. */}
          <section className={`city-stage ${split || surface === 'analyze' ? 'is-concealed' : ''}`} aria-label="Tactical city map" aria-hidden={split || surface === 'analyze'}>
            <TacticalMap3D snapshot={snap} graph={graph} hazardCenter={hazard?.center} hazardLabel={hazard?.label}
              motion={motion} follow={follow} onFollowChange={setFollow} presenting={expanded} active={surface === 'city' || surface === 'requests'}
              fallback={<MapPlaceholder snapshot={snap} graph={graph} rival={rival} />} />
            <PatientClock snapshot={snap} rival={rival} />
            <div key={`${snap.mode}-${snap.ambulance?.status}`} className="arrival-banner">
              <ArrivalOverlay ambulance={snap.ambulance} />
            </div>
          </section>

          {!expanded && surface !== 'analyze' && !split && <div className="map-caption">
            <span>{cityShort(mode)}</span><span>{snap.vehicles.length} robotaxis · {snap.darkNodes.length} dark signals</span>
          </div>}

          {split && <section className="comparison-workspace" aria-label="FIFO and DARK GRID comparison">
            <div className="surface-heading"><div><h2>Same city. Different decisions.</h2><p>Same seed, same blackout. Rewind to see where the two runs diverge.</p></div><span className="quiet-badge">{view.isLive ? 'Live comparison' : 'Recorded comparison'}</span></div>
            <div className="comparison-maps"><MapPlaceholder snapshot={view.fifo} graph={graph} other={view.darkgrid} /><MapPlaceholder snapshot={view.darkgrid} graph={graph} other={view.fifo} /></div>
            <div className="comparison-data"><MetricsChart data={view.chart} /><ComparisonMetrics fifo={view.fifo} darkgrid={view.darkgrid} /></div>
          </section>}

          {/* Keep these forms mounted so switching destinations never loses an analysis or voice session. */}
          <section className="analysis-workspace" hidden={surface !== 'analyze'} aria-label="Incident analysis">
            <div className="surface-heading"><div><h2>Understand the incident.</h2><p>Analyze an event, review the proposed response, and explain a dispatch decision.</p></div><Sparkles /></div>
            <ScenarioControls snapshot={snap} readOnly={!view.isLive} onNew={onNewScenario} onCollision={collision} />
            <div className="analysis-columns"><ChaosInjectorPanel onResult={onChaos} /><AskWhyBar active={surface === 'analyze'} jobs={snap.jobs} contextKey={`${snap.mode}-${view.isLive ? 'live' : snap.t}`} /></div>
            <p className="analysis-note"><ShieldCheck />Blackouts and collisions affect both cities. Zone policy requires human approval. Scenario timing and clearance durations are prototype assumptions.</p>
          </section>

          {contextualQueue && <div className={`presentation-queue ${pendingPolicy ? 'policy-only' : ''}`}>
            {pendingPolicy ? <ZonePolicyCard cinematic job={snap.jobs.find(j => j.kind === 'ZONE_POLICY')!} snapshot={snap}
              proposal={outage ? proposal : null} readOnly={!view.isLive} onAnswer={onAnswer} /> :
              <RequestFeed snapshot={snap} mode={mode} onModeChange={setMode} onAnswer={onAnswer}
                proposal={outage ? proposal : null} readOnly={!view.isLive} paused={paused} compact
                onTakeOver={() => takeOver(snap.control === 'MANUAL' ? null : mode)} onBlackout={director[1]} />}
          </div>}

          {surface !== 'analyze' && <div className={`playback-dock ${expanded ? 'with-director' : ''}`}>
            {expanded && <nav className="demo-act-nav" aria-label="Demo director">
              {['Blackout', 'Judge', 'Dark Grid', 'Compare', 'Follow'].map((label, i) =>
                <button key={label} aria-current={demoStep === i + 1 ? 'step' : undefined} onClick={director[i + 1]}><span>{i + 1}</span>{label}</button>)}
            </nav>}
            <div className="playback-row"><button className="play-toggle" aria-label={paused ? 'Resume simulation' : 'Pause simulation'} onClick={togglePause}>{paused ? <Play /> : <Pause />}</button>
              <span className="playback-state">{!view.isLive ? 'Replay' : paused ? 'Paused' : 'Running'}</span>{timeline}
              {expanded && <button className="dock-reset" onClick={onReset}><RotateCcw />Reset</button>}
            </div>
          </div>}
          {expanded && <span className="presentation-footnote">Deterministic simulation</span>}

        </div>

        <aside id="mission-panel" className="mission-panel" hidden={!showRight} aria-label="Mission overview">
          <MissionOverview snapshot={snap} rival={rival} graph={graph} follow={follow} onFollow={() => setFollow(v => !v)}
            onCollapse={() => setRightOpen(false)} onCompare={() => changeSurface('compare')}
            scenarioControls={<ScenarioControls snapshot={snap} readOnly={!view.isLive} onNew={onNewScenario} onCollision={collision} />} />
        </aside>
      </div>

      {!expanded && <footer className="workspace-footer">
        <span className="simulation-label"><span />Deterministic simulation</span>
        <nav aria-label="Workspace" className="workspace-navigation">
          {([{ id: 'city', label: 'City', icon: MapIcon }, { id: 'requests', label: 'Requests', icon: ListFilter },
            { id: 'compare', label: 'Compare', icon: ChartNoAxesCombined }, { id: 'analyze', label: 'Analyze', icon: Sparkles }] as const).map(item => (
              <button key={item.id} aria-current={surface === item.id ? 'page' : undefined} onClick={() => changeSurface(item.id)}><item.icon /><span>{item.label}</span></button>
            ))}
        </nav>
        <button className="reset-button" onClick={onReset}><RotateCcw /><span>Reset</span></button>
      </footer>}
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
  return `action-button ${tone === 'cyan' ? 'primary' : tone === 'amber' ? 'warning' : tone === 'red' ? 'danger' : 'secondary'}`;
}

function Dot({ tone, pulse = true }: { tone: Tone; pulse?: boolean }) {
  return (
    <span aria-hidden="true"
      className={`inline-block size-1.5 shrink-0 rounded-full bg-current ${TONE_TEXT[tone]} ${pulse && tone !== 'idle' ? '[animation:dg-breathe_2s_ease-in-out_infinite]' : ''}`} />
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
  return <svg aria-hidden="true" viewBox="0 0 30 30" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
    <path d="M6 2v26M14 2v26M22 3v24M2 7h26M2 15h26M3 23h24M10 2h5M22 7v8M6 23v5" />
  </svg>;
}

// ---------- placeholders (delete each one when the real component lands) ----------

// Vehicle colors; C's MapView should use the same ones.
const STATE_COLOR: Record<string, string> = {
  YIELDING: '#facc15', YIELDED: '#2dd4bf',
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
  const W = 1000, H = 600, pad = 45;
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

          {(snapshot.incidents ?? []).filter(i => i.status !== 'CLEARED').map(incident => <g key={incident.id} transform={`translate(${px(incident.pos)} ${py(incident.pos)})`}>
            <circle r={15} fill="#351d2b" stroke="#ff7d8d" strokeWidth={2} />
            <path d="M-6,-6L6,6M6,-6L-6,6" stroke="#ffb4be" strokeWidth={3} />
            <text x={0} y={-23} fill="#ffb4be" textAnchor="middle" fontSize={13}>{incident.status === 'RESPONDING' ? 'Recovery on scene' : 'Collision · road closed'}</text>
          </g>)}

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
  if (!a) return null;
  const arrived = a.status === 'ARRIVED';
  const r = rival?.ambulance;
  const lead = arrived && r && r.status !== 'WAITING' ? r.tripS - a.tripS : 0;
  const label = arrived ? 'Patient delivered' : a.status === 'STUCK' ? 'Ambulance stuck' : a.status === 'WAITING' ? 'Awaiting dispatch' : 'Patient en route';
  return <div role="status" className={`patient-clock ${arrived ? 'is-arrived' : a.status === 'STUCK' ? 'is-stuck' : ''}`}>
    <div>{arrived ? <Check /> : <Ambulance />}<span>{label}</span>{a.status !== 'WAITING' && <strong>{formatT(a.tripS)}</strong>}</div>
    {lead >= 30 && rival && <p>{r!.status === 'ARRIVED' ? '' : 'At least '}{formatT(lead)} ahead of {cityShort(rival.mode)}</p>}
  </div>;
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

// Queue cards use only the existing job, policy and snapshot data. Node IDs are shown
// because the road graph does not provide verified street/intersection names.
function contribution(job: Job, label: string): number {
  return job.breakdown.find(term => term.label === label)?.value ?? 0;
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return <div className="mode-switch" role="group" aria-label="City on screen">
    {(['FIFO', 'DARKGRID'] as const).map(city => <button key={city} aria-pressed={mode === city} onClick={() => onChange(city)}>{cityShort(city)}</button>)}
  </div>;
}

function ZonePolicyCard({ job, snapshot, proposal, readOnly, onAnswer, cinematic = false }: {
  job: Job; snapshot: SimSnapshot; proposal?: ChaosResult | null; readOnly: boolean; cinematic?: boolean;
  onAnswer: (id: string, city: Mode) => void;
}) {
  const locked = snapshot.manual.reviewingJobId !== null;
  return <article className={`request-card policy-card ${cinematic ? 'cinematic-policy' : ''}`}>
    <div className="request-meta"><span className="request-kind policy-kind"><ShieldCheck />{cinematic ? 'Human approval required' : 'Human approval'}</span>
      {proposal && <span className="draft-source">{proposal.source === 'CLAUDE' ? 'Claude draft' : 'Offline draft'}</span>}
    </div>
    <h3>Approve zone policy</h3>
    <p>{cinematic ? 'Treat dark signals as four-way stops.' : 'Treat dark signals as four-way stops across the outage zone.'}</p>
    {!cinematic && <div className="policy-scope"><Zap />{contribution(job, 'dark signals')} dark signals · {contribution(job, 'confirm requests cleared')} confirmations to clear</div>}
    {!cinematic && proposal && <details className="job-explanation"><summary>Review the draft<ChevronRight /></summary><p>{proposal.rationale}</p></details>}
    <div className={cinematic ? 'cinematic-policy-actions' : 'policy-action'}>
      <button className="action-button primary" disabled={readOnly || locked} onClick={() => onAnswer(job.id, snapshot.mode)}>
        {readOnly ? 'Recorded policy' : locked ? 'Review in progress' : 'Approve policy'}{!cinematic && <ArrowRight />}
      </button>
      {cinematic && <details className="cinematic-policy-review"><summary>Review details</summary><div><p>{job.sub}</p>{proposal && <p>{proposal.rationale}</p>}</div></details>}
    </div>

  </article>;
}

function RequestFeed({ snapshot, mode, onModeChange, onAnswer, proposal, readOnly, paused, onTakeOver, onBlackout, onCollapse, compact = false }: {
  snapshot: SimSnapshot; mode: Mode; onModeChange: (mode: Mode) => void;
  onAnswer: (id: string, city: Mode) => void; proposal?: ChaosResult | null;
  readOnly: boolean; paused: boolean; onTakeOver: () => void; onBlackout: () => void; onCollapse?: () => void; compact?: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'corridor' | 'blocking'>('all');
  const manual = snapshot.control === 'MANUAL';
  const locked = snapshot.manual.reviewingJobId !== null;
  const zone = snapshot.jobs.find(job => job.kind === 'ZONE_POLICY');
  const jobs = snapshot.jobs.filter(job => job.kind !== 'ZONE_POLICY');
  const filtered = jobs.filter(job => filter === 'all' || contribution(job, filter === 'corridor' ? 'on corridor' : 'inside box') > 0);
  const shown = filtered.slice(0, compact ? 3 : 40);
  const busy = snapshot.operators.filter(operator => operator.task !== 'idle').length;
  const policyActive = snapshot.policy.darkSignalsAsFourWayStop.length > 0;
  return <section className={`request-feed ${compact ? 'is-compact' : ''}`}>
    <div className="panel-title"><h2>{compact ? `${cityShort(mode)} · ${manual ? 'You are the operator' : 'Policy review'}` : 'Live requests'}</h2>
      {onCollapse && <button className="icon-button" aria-label="Collapse request panel" onClick={onCollapse}><ChevronLeft /></button>}
    </div>
    {!compact && <>
      <ModeSwitch mode={mode} onChange={onModeChange} />
      <div className="queue-summary"><div><strong className={snapshot.metrics.requests ? 'text-dg-amber' : ''}>{snapshot.metrics.requests}</strong><span>Requests waiting</span></div><div><strong>{readOnly ? snapshot.metrics.jobs : snapshot.jobs.length}</strong><span>Dispatch jobs</span></div></div>
      <div className="queue-order"><ListFilter />{mode === 'FIFO' ? 'First come, first served' : 'Sorted by impact / handling time'}</div>
      <div className="queue-filters" role="group" aria-label="Filter requests">
        {(['all', 'corridor', 'blocking'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'corridor' ? 'Corridor' : 'Blocking'}</button>)}
      </div>
    </>}
    {readOnly && <p className="queue-notice"><Clock3 />Recorded queue, up to 8 jobs. Return to LIVE to review.</p>}
    {locked && <p className="queue-notice is-review" role="status"><Clock3 /><span>{paused ? 'Review paused. Resume to finish.' : `Reviewing · ${Math.ceil(snapshot.manual.lockRemainingS * SIM_SPEED)} sim s remaining`}</span></p>}
    {policyActive && <p className="policy-active"><Check />Zone policy active</p>}
    <div className="request-scroll">
      {zone && <ZonePolicyCard job={zone} snapshot={snapshot} proposal={proposal} readOnly={readOnly} onAnswer={onAnswer} />}
      {shown.map(job => {
        const collision = job.kind === 'COLLISION';
        const corridor = contribution(job, 'on corridor') > 0;
        const blocking = contribution(job, 'inside box') > 0;
        const passenger = contribution(job, 'passenger') > 0;
        const batch = job.requestIds.length > 1;
        const stuck = job.kind === 'STUCK' || job.title.startsWith('Stuck');
        const label = collision ? 'Collision' : mode === 'FIFO' ? 'FIFO' : corridor ? 'Corridor' : blocking ? 'Blocking' : batch ? 'Batch' : stuck ? 'Stuck' : 'Confirmation';
        const title = collision ? 'Dispatch road recovery' : blocking ? 'Clear a blocked intersection' : stuck ? 'Vehicle unable to proceed' : batch ? 'Confirm dark signals' : 'Confirm a dark signal';
        const node = job.sub.match(/node\s+(-?\d+)/)?.[1];
        const weight = snapshot.policy.triageWeights.perQueuedBehind;
        const behind = weight > 0 ? contribution(job, 'queued behind') / weight : null;
        return <article className={`request-card ${collision || corridor || blocking || stuck ? 'is-urgent' : ''}`} key={job.id}>
          <div className="request-meta"><span className={`request-kind ${collision || corridor || blocking || stuck ? 'urgent-kind' : ''}`}><span />{label}</span>
            <span className="request-wait" title="Waiting time in simulation seconds"><Clock3 />{formatT(Math.max(0, snapshot.t - job.createdAt))} sim</span>
          </div>
          <h3>{title}</h3>
          <div className="request-location">{collision ? <TriangleAlert /> : <CarFront />}{collision ? 'Two-vehicle incident · road closed' : batch ? `${job.vehicleIds.length} vehicles` : `Vehicle #${job.vehicleIds[0]}`}{node && <> · Node {node}</>}</div>
          <p>{collision ? job.sub : blocking ? `Stopped inside an intersection${corridor ? ' on the ambulance route' : ''}.` : stuck ? 'Waiting in traffic long enough to request operator assistance.' : batch ? 'Answer compatible confirmation requests at this intersection together.' : 'Waiting for an operator to confirm passage through a dark signal.'}</p>
          <div className="request-tags">{corridor && <span><Route />Ambulance route</span>}{blocking && <span>Inside intersection</span>}{passenger && <span>Passenger</span>}{batch && <span><Layers3 />{job.requestIds.length} requests</span>}</div>
          <details className="job-explanation"><summary><span>{behind !== null && behind > 0 ? `${behind} queued behind · ` : ''}{job.p} s handling</span><CircleHelp /></summary>
            <div><p>Priority {job.w.toFixed(1)} / {job.p} s = {(job.w / job.p).toFixed(2)} per second.</p>{job.breakdown.map(term => <span className="breakdown-term" key={term.label}>{term.label}<strong>{term.value.toFixed(1)}</strong></span>)}</div>
          </details>
          <button className="action-button secondary" disabled={readOnly || locked || !manual} onClick={() => onAnswer(job.id, snapshot.mode)}>
            {readOnly ? 'Recorded request' : !manual ? 'Auto operators active' : locked ? 'Review in progress' : batch ? 'Review batch' : 'Review request'}{manual && !locked && <ArrowRight />}
          </button>
        </article>;
      })}
      {filtered.length > shown.length && <p className="queue-tail">{filtered.length - shown.length} more jobs waiting{compact ? ' · exit presentation to see all' : ''}</p>}
      {!zone && !shown.length && <div className="queue-empty"><ShieldCheck /><h3>{locked ? 'Review in progress' : filter === 'all' ? 'The queue is clear.' : 'No matching requests.'}</h3>
        <p>{locked ? 'The current review will finish as simulation time advances.' : snapshot.outage?.status === 'RESTORED' ? 'Power is restored. Start a new scenario for another incident.' : snapshot.darkNodes.length ? 'Requests will appear here when a vehicle needs assistance.' : 'The city is moving. Trigger a blackout to begin the demonstration.'}</p>
        {!snapshot.outage && !readOnly && <button className="action-button warning" onClick={onBlackout}><Zap />Trigger blackout</button>}
      </div>}
    </div>
    <div className="queue-control">
      <div><UsersRound /><span>{manual ? `Judge control · ${snapshot.manual.answered} answered` : `${snapshot.operators.length} operators · ${busy} active`}</span></div>
      <button className="text-button" disabled={readOnly} onClick={onTakeOver}>{manual ? 'Return to auto' : 'Take over'}<ArrowRight /></button>
    </div>
  </section>;
}

function ScenarioControls({ snapshot, readOnly, onNew, onCollision }: {
  snapshot: SimSnapshot; readOnly: boolean; onNew: () => void; onCollision: () => void;
}) {
  const outage = snapshot.outage;
  return <section className="scenario-controls" aria-label="Scenario controls">
    <div className="scenario-heading"><span>Random scenario</span><code>Seed {snapshot.scenario?.seed}</code></div>
    <p>{!outage ? `Blackout scheduled · T+${formatT(snapshot.scenario?.outageAt ?? 0)}` : outage.status === 'RESTORED' ? 'Power restored across the affected area' : `${Math.round(outage.radiusM)} m outage · ${outage.status === 'RESTORING' ? 'restoring power' : 'active'}`}</p>
    <div className="scenario-actions"><button type="button" className="action-button secondary" onClick={onNew}><Shuffle />New scenario</button>
      <button type="button" className="action-button secondary" disabled={readOnly || (snapshot.incidents?.length ?? 0) >= MAX_COLLISION_INCIDENTS} onClick={onCollision}><TriangleAlert />Collision</button></div>
    <small>Reset replays this seed. Both cities receive the same incidents.</small>
  </section>;
}

function CorridorProtocol({ snapshot }: { snapshot: SimSnapshot }) {
  const protocol = snapshot.corridorStatus;
  const incidents = snapshot.incidents ?? [];
  const commands = protocol?.commands ?? [];
  const blocked = commands.filter(c => c.state === 'BLOCKED').length;
  const clear = commands.filter(c => c.state === 'CLEARED').length;
  return <div className="mission-section corridor-protocol">
    <h3><Radio />Road response</h3>
    {protocol?.active ? <>
      <p className="protocol-summary">{protocol.segments.filter(s => s.state === 'CLEAR').length}/{protocol.segments.length} reserved road segments free of modeled obstructions</p>
      <div className="protocol-counts"><span>{commands.length} sent</span><span>{clear} cleared</span><span className={blocked ? 'text-dg-red' : ''}>{blocked} blocked</span></div>
      <details><summary>Vehicle acknowledgements<ChevronRight /></summary><ul>{commands.slice(-12).reverse().map(c => <li key={c.vehicleId}><span>Vehicle #{c.vehicleId}<small>{c.reason}</small></span><strong>{c.state.toLowerCase()}</strong></li>)}</ul></details>
    </> : <p className="protocol-summary">{snapshot.mode === 'FIFO' ? 'Local emergency yielding · no fleet reservation' : snapshot.ambulance?.status === 'ARRIVED' ? 'Corridor released after delivery' : 'Reservation begins before ambulance dispatch'}</p>}
    {incidents.map(incident => <div className={`collision-ledger ${incident.status === 'CLEARED' ? 'is-cleared' : ''}`} key={incident.id}>
      <TriangleAlert /><div><strong>Collision · road {incident.edgeId}</strong><span>{incident.status === 'BLOCKED' ? 'Road blocked · awaiting recovery dispatch' : incident.status === 'RESPONDING' ? `Recovery on scene · ${formatT(Math.max(0, (incident.clearAt ?? snapshot.t) - snapshot.t))} remaining` : 'Road cleared · traffic restored'}</span></div>
    </div>)}
  </div>;
}

function MissionOverview({ snapshot, rival, graph, follow, onFollow, onCollapse, onCompare, scenarioControls }: {
  snapshot: SimSnapshot; rival: SimSnapshot; graph: RoadGraph; follow: boolean;
  onFollow: () => void; onCollapse: () => void; onCompare: () => void;
  scenarioControls: ReactNode;
}) {
  const amb = snapshot.ambulance;
  const downtown = Math.abs(graph.center.lat - 37.788) < 0.01 && Math.abs(graph.center.lng + 122.406) < 0.01;
  const status = !amb ? 'Standing by' : amb.status === 'WAITING' ? 'Awaiting dispatch' : amb.status === 'ARRIVED' ? 'Patient delivered' : amb.status === 'STUCK' ? 'Ambulance stuck' : 'Patient en route';
  const routeLabel = downtown ? 'Station 35 → Chinese Hospital' : 'Fire station → Hospital';
  const policyActive = snapshot.policy.darkSignalsAsFourWayStop.length > 0;
  const dg = snapshot.mode === 'DARKGRID';
  return <section className="mission-overview">
    <div className="panel-title"><h2>Mission overview</h2><button className="icon-button" aria-label="Collapse mission panel" onClick={onCollapse}><ChevronRight /></button></div>
    <div className={`ambulance-summary ${amb?.status === 'ARRIVED' ? 'has-arrived' : ''}`}><div className="ambulance-icon"><Ambulance /></div><div><h3>{status}</h3><p>{routeLabel}</p>{amb && amb.status !== 'WAITING' && <strong className="mission-time">{formatT(amb.tripS)}<span> elapsed</span></strong>}</div></div>
    <button className="action-button secondary follow-button" disabled={!amb} aria-pressed={follow} onClick={onFollow}><Crosshair />{follow ? 'Stop following' : 'Follow ambulance'}</button>
    {scenarioControls}
    <CorridorProtocol snapshot={snapshot} />
    <div className="mission-section"><h3><Route />Dispatch strategy</h3>
      <ul className="strategy-list">
        <li><ListFilter /><span>{dg ? 'WSPT triage' : 'First come, first served'}</span><span className="strategy-state">{dg ? 'Impact first' : 'Oldest first'}</span></li>
        <li><Layers3 /><span>Batch confirmations</span>{dg ? <Check /> : <span className="strategy-state">Off</span>}</li>
        <li><MapPin /><span>Curb & staging</span>{dg && snapshot.darkNodes.length ? <Check /> : <span className="strategy-state">{dg ? 'Standby' : 'Off'}</span>}</li>
        <li><Ambulance /><span>Ambulance corridor</span>{snapshot.corridor.length ? <Check /> : <span className="strategy-state">Standby</span>}</li>
        <li><ShieldCheck /><span>Zone policy</span><span className={`strategy-state ${policyActive ? 'is-active' : ''}`}>{policyActive ? 'Approved' : snapshot.darkNodes.length && dg ? 'Needs approval' : 'Standby'}</span></li>
      </ul>
    </div>
    <div className="mission-section"><h3><ChartNoAxesCombined />Live metrics</h3><dl className="mission-metrics">
      <div><dt>Requests waiting</dt><dd>{snapshot.metrics.requests}</dd></div><div><dt>Operator load ρ</dt><dd className={snapshot.metrics.rho > 1 ? 'text-dg-red' : ''}>{snapshot.metrics.rho.toFixed(2)}</dd></div><div><dt>Stuck vehicles</dt><dd>{snapshot.metrics.stuck}</dd></div>
    </dl><button className="text-button" onClick={onCompare}>Open comparison<ArrowRight /></button></div>
    <div className="mission-footnote"><span className="quiet-badge">Same seed · same outage</span><p>{cityShort(rival.mode)} is running alongside this city. Civilian traffic is visual only.</p></div>
  </section>;
}

function ComparisonMetrics({ fifo, darkgrid }: { fifo: SimSnapshot; darkgrid: SimSnapshot }) {
  const rows = [
    ['Requests waiting', fifo.metrics.requests.toString(), darkgrid.metrics.requests.toString()],
    ['Operator load ρ', fifo.metrics.rho.toFixed(2), darkgrid.metrics.rho.toFixed(2)],
    ['Stuck vehicles', fifo.metrics.stuck.toString(), darkgrid.metrics.stuck.toString()],
    ['Blocking vehicle-min', fifo.metrics.blockingVehMin.toFixed(0), darkgrid.metrics.blockingVehMin.toFixed(0)],
    ['Ambulance trip', fifo.metrics.ambulanceTripS === null ? 'Not arrived' : formatT(fifo.metrics.ambulanceTripS), darkgrid.metrics.ambulanceTripS === null ? 'Not arrived' : formatT(darkgrid.metrics.ambulanceTripS)],
  ];
  return <section className="comparison-metrics"><h3>From this simulation</h3><table><thead><tr><th scope="col">Metric</th><th scope="col">FIFO</th><th scope="col">DARK GRID</th></tr></thead><tbody>{rows.map(([label, f, d]) => <tr key={label}><th scope="row">{label}</th><td>{f}</td><td>{d}</td></tr>)}</tbody></table></section>;
}

// Scene-local CSS: the approved presentation composition, separate from the
// denser operations workspace. All selectors remain under the DARK GRID root.
const CINEMATIC_STYLES = `
.dg-workspace .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.dg-workspace [aria-label="Simulation timeline"] { display: flex; align-items: center; width: 100%; }
.dg-workspace [aria-label="Simulation timeline"] > div { position: relative; flex: 1; min-width: 0; }
.dg-workspace [aria-label="Simulation history time"] { display: block; width: 100%; }
.dg-workspace .scenario-controls { margin: 12px 16px; padding: 12px 0; border-top: 1px solid #34434d; border-bottom: 1px solid #34434d; }
.dg-workspace .scenario-heading { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #e1edf2; }
.dg-workspace .scenario-heading code { font-size: 10px; color: #aebec9; overflow-wrap: anywhere; }
.dg-workspace .scenario-controls p { margin: 9px 0; font-size: 12px; line-height: 1.5; color: #c6d4dd; }
.dg-workspace .scenario-actions { display: flex; gap: 8px; }
.dg-workspace .scenario-actions .action-button { flex: 1; min-width: 0; padding: 8px; min-height: 36px; font-size: 11px; }
.dg-workspace .scenario-actions svg { width: 14px; height: 14px; }
.dg-workspace .scenario-controls > small { display: block; margin-top: 9px; font-size: 10px; line-height: 1.6; color: #aebec9; }
.dg-workspace .protocol-summary { font-size: 12px; line-height: 1.6; color: #c6d4dd; }
.dg-workspace .protocol-counts { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; font-size: 11px; color: #c6d4dd; }
.dg-workspace .corridor-protocol details > summary { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; font-size: 11px; color: #9ce0df; cursor: pointer; }
.dg-workspace .corridor-protocol summary svg { width: 13px; height: 13px; }
.dg-workspace .corridor-protocol details ul { padding: 0; list-style: none; }
.dg-workspace .corridor-protocol details li { display: flex; justify-content: space-between; align-items: start; gap: 8px; padding: 8px 0; border-top: 1px solid #34434d; font-size: 11px; color: #e1edf2; }
.dg-workspace .corridor-protocol li small { display: block; margin-top: 5px; color: #aebec9; line-height: 1.5; }
.dg-workspace .corridor-protocol li strong { font-weight: 500; color: #f1ce77; }
.dg-workspace .collision-ledger { display: flex; gap: 9px; margin-top: 12px; font-size: 11px; color: #ffb4be; }
.dg-workspace .collision-ledger > svg { width: 16px; height: 16px; flex: none; }
.dg-workspace .collision-ledger strong { font-weight: 500; }
.dg-workspace .collision-ledger span { display: block; margin-top: 5px; color: #c6d4dd; line-height: 1.5; }
.dg-workspace .collision-ledger.is-cleared { color: #7ce1bf; }
.dg-workspace .workspace-brand > svg { color: #d9e4e9; }
.dg-workspace .policy-action > button { width: 100%; }
.dg-workspace.is-presenting .workspace-header { height: 60px; flex-basis: 60px; padding: 0 30px; background: #101c26; }
.dg-workspace.is-presenting .workspace-brand h1 { font-size: 18px; letter-spacing: .17em; }
.dg-workspace.is-presenting .workspace-environment { display: block; color: #e0e6eb; font-size: 14px; }
.dg-workspace.is-presenting .city-status { position: absolute; left: 50%; transform: translateX(-50%); margin: 0; font-size: 14px; font-weight: 500; }
.dg-workspace.is-presenting .header-actions { margin-left: auto; }
.dg-workspace.is-presenting .header-clock, .dg-workspace.is-presenting .session-menu, .dg-workspace.is-presenting .present-button > svg { display: none; }
.dg-workspace.is-presenting .present-button { min-height: 36px; font-size: 13px; padding: 0 14px; gap: 12px; }
.dg-workspace.is-presenting .city-status > span { box-shadow: 0 0 9px #f5b24a88; }
.dg-workspace.is-presenting .city-stage > .patient-clock { display: none; }
.dg-workspace.is-presenting .tactical-city .city-model-toggle,
.dg-workspace.is-presenting .tactical-city .map-camera-controls,
.dg-workspace.is-presenting .tactical-city .map-legend,
.dg-workspace.is-presenting .tactical-city .map-follow-button { display: none; }
.dg-workspace.is-presenting .presentation-queue { left: 30px; bottom: 155px; width: 405px; max-height: calc(100% - 185px); background: #131d26ed; border-color: #657179; border-radius: 12px; backdrop-filter: blur(12px); box-shadow: 0 10px 28px #0004; }
.dg-workspace.is-presenting .presentation-queue.policy-only { overflow: visible; }
.dg-workspace .cinematic-policy { position: relative; margin: 0; padding: 22px; background: transparent; border: 0; border-radius: 12px; }
.dg-workspace .cinematic-policy .request-meta { margin-bottom: 14px; }
.dg-workspace .cinematic-policy .request-kind { padding: 0; background: transparent; font-size: 12px; font-weight: 400; color: #ffd16e; }
.dg-workspace .cinematic-policy .request-kind > svg { width: 13px; height: 13px; }
.dg-workspace .cinematic-policy h3 { margin-bottom: 12px; font-size: 25px; font-weight: 500; letter-spacing: -.03em; }
.dg-workspace .cinematic-policy > p { margin-bottom: 21px; font-size: 15px; line-height: 1.5; }
.dg-workspace .cinematic-policy .draft-source { padding: 5px 7px; font-size: 10px; background: #30363b; }
.dg-workspace .cinematic-policy-actions { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; align-items: stretch; }
.dg-workspace .cinematic-policy-actions > button, .dg-workspace .cinematic-policy-review > summary { min-height: 43px; border-radius: 7px; font-size: 13px; }
.dg-workspace .cinematic-policy-actions > button { background: #009da6; color: #f4feff; }
.dg-workspace .cinematic-policy-review > summary { display: flex; align-items: center; justify-content: center; list-style: none; border: 1px solid #67717b; color: #e4ecf1; }
.dg-workspace .cinematic-policy-review > summary::-webkit-details-marker { display: none; }
.dg-workspace .cinematic-policy-review > div { position: absolute; bottom: calc(100% + 10px); left: 0; width: 100%; padding: 17px 20px; border: 1px solid #68747b; border-radius: 10px; background: #14222ff5; font-size: 13px; line-height: 1.6; color: #d6e2e9; }
.dg-workspace.is-presenting .playback-dock { bottom: 28px; max-width: 780px; width: calc(100% - 64px); border-radius: 12px; padding: 12px 18px 9px; background: #111c25ed; backdrop-filter: blur(12px); border-color: #718088; }
.dg-workspace .demo-act-nav { display: flex; justify-content: space-between; gap: 8px; padding: 0 0 14px; margin-bottom: 7px; border-bottom: 1px solid #495762; }
.dg-workspace .demo-act-nav > button { display: flex; align-items: center; gap: 10px; padding: 0 5px; min-height: 34px; font-size: 12px; color: #e1e8ed; background: transparent; border: 0; border-radius: 5px; }
.dg-workspace .demo-act-nav > button > span { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid #b6c3cb; border-radius: 50%; color: #e1e8ed; font-size: 12px; }
.dg-workspace .demo-act-nav > button[aria-current="step"] { color: #ffd065; }
.dg-workspace .demo-act-nav > button[aria-current="step"] > span { border-color: #ffbf38; background: #ffbf38; color: #1b211e; }
.dg-workspace .with-director .playback-row { gap: 12px; min-height: 37px; }
.dg-workspace .with-director .playback-state { display: inline; font-size: 12px; }
.dg-workspace .with-director [aria-label="Current simulation time"] { display: none; }
.dg-workspace .with-director [aria-label="Simulation timeline"] input { accent-color: #ffbf38; }
.dg-workspace .with-director input::-webkit-slider-thumb { background: #ffbf38 !important; }
.dg-workspace .with-director input::-moz-range-thumb { background: #ffbf38 !important; }
.dg-workspace .dock-reset { display: flex; align-items: center; gap: 9px; padding: 7px 4px 7px 18px; margin-left: 5px; border: 0; border-left: 1px solid #50616c; color: #e3edf3; background: transparent; font-size: 12px; }
.dg-workspace .dock-reset svg { width: 17px; height: 17px; }
.dg-workspace .presentation-footnote { position: absolute; left: 16px; bottom: 8px; color: #c2cbd1; font-size: 9px; text-shadow: 0 1px 3px #000; pointer-events: none; z-index: 30; }
.dg-workspace .mission-map-pin { position: absolute; left: 0; top: 0; display: flex; gap: 9px; align-items: center; padding: 9px 12px; color: #f0f3f6; background: #15212bf0; border: 1px solid #8c9499; border-radius: 9px; pointer-events: none; white-space: nowrap; }
.dg-workspace .mission-map-pin > svg { width: 21px; height: 21px; color: #fff2de; }
.dg-workspace .mission-map-pin strong { font-size: 13px; font-weight: 500; }
.dg-workspace .mission-map-pin > div { display: flex; flex-direction: column; gap: 4px; }
.dg-workspace .mission-map-pin span { font-size: 12px; color: #f1ce77; }
.dg-workspace .hospital-pin { padding: 7px 10px; border: 0; background: #101b25f0; border-radius: 5px; }
.dg-workspace .hospital-pin > svg { width: 16px; height: 16px; color: #ff7d8d; fill: #b53144; }
@media (max-width: 760px) {
  .dg-workspace.is-presenting .workspace-header { height: 54px; flex-basis: 54px; padding: 0 12px; }
  .dg-workspace.is-presenting .workspace-brand h1 { font-size: 13px; }
  .dg-workspace.is-presenting .workspace-environment, .dg-workspace.is-presenting .city-status { display: none; }
  .dg-workspace.is-presenting .presentation-queue { left: 12px; width: min(350px, calc(100% - 24px)); bottom: 150px; }
  .dg-workspace .cinematic-policy { padding: 17px; }
  .dg-workspace .cinematic-policy h3 { font-size: 21px; }
  .dg-workspace .cinematic-policy > p { font-size: 13px; margin-bottom: 15px; }
  .dg-workspace.is-presenting .playback-dock { width: calc(100% - 24px); bottom: 25px; padding: 9px 9px 6px; }
  .dg-workspace .demo-act-nav { gap: 0; }
  .dg-workspace .demo-act-nav > button { flex-direction: column; gap: 5px; font-size: 9px; padding: 0 3px; }
  .dg-workspace .demo-act-nav > button > span { width: 22px; height: 22px; font-size: 10px; }
  .dg-workspace .with-director .playback-row { gap: 3px; }
  .dg-workspace .with-director .playback-state { display: none; }
  .dg-workspace .dock-reset { font-size: 0; padding-left: 7px; }
  .dg-workspace .mission-map-pin strong { font-size: 11px; }
  .dg-workspace .mission-map-pin span { font-size: 10px; }
}
`;
