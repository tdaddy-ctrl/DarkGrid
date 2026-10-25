// Simulator core. Pure TypeScript, no React. Same seed + same calls = exactly the same run.
// Times are sim seconds. Public API: createSim, step, injectEvent, getSnapshot,
// setControl, answerJob (plus makeGridGraph, the "Test Grid" environment).
// Routing, dispatch and lot staging come from B: graph.ts, dispatch.ts, hungarian.ts.

import type {
  Ambulance, ControlMode, HelpRequest, Job, LatLng, Metrics, Policy, RoadEdge, RoadGraph,
  RoadNode, SimSnapshot, Vehicle, CollisionIncident, YieldCommand, OutageState, CorridorStatus,
} from '@/types/sim';
import * as C from './config';
import { orderJobs } from './dispatch';
import { shortestPath } from './graph';
import { hungarian } from './hungarian';

export type SimMode = 'FIFO' | 'DARKGRID';
// center defaults to graph.center (the substation point).
export type SimEvent =
  | { type: 'OUTAGE'; center?: LatLng; radiusM?: number; restoreAfterS?: number }
  | { type: 'COLLISION'; edgeId?: number; clearanceS?: number };

type Place = 'ROAD' | 'BOX' | 'CURB' | 'LOT' | 'OFF';

type Lane = {
  id: number; edgeId: number; from: number; to: number; len: number; headingDeg: number;
  obstacleS: number;
  cars: Agent[];                    // front (closest to `to`) first
};

type Agent = {
  id: number; type: 'PASSENGER' | 'EMPTY' | 'AMBULANCE';
  place: Place; lane: number; s: number; speed: number;
  route: Lane[];                    // lanes still to drive after the current one
  dest: number;
  boxNode: number;                  // node id while in BOX or CURB
  decided: boolean;                 // already rolled the help dice for the node ahead
  held: boolean;                    // stopped at the stop line, waiting for an operator
  override: boolean;                // operator said "go": skip the dark-node headway once
  stoppedS: number;
  requestId: string | null;
  lot: number;                      // index into sim.lots, -1 = none
  yieldStartT: number | null;
};

type NodeState = {
  node: RoadNode; out: Lane[]; in: Lane[];
  dark: boolean; nextPassT: number;
  box: Agent[];                     // stopped inside the intersection: nobody passes
  curb: Agent[];                    // pulled over, not blocking
};

type Lot = { pos: LatLng; node: number; cap: number; used: number; reserved: number };
type Req = HelpRequest & { assigned: boolean };
type Operator = { id: string; job: Job | null; doneT: number };

export type Sim = {
  graph: RoadGraph; mode: SimMode; rng: () => number; t: number;
  control: ControlMode; policy: Policy;
  lanes: Lane[]; laneByStep: Map<string, Lane>; nodes: Map<number, NodeState>; nodeIds: number[];
  agents: Agent[]; amb: Agent; ambRoute: Lane[];
  dispatchT: number | null; arriveT: number | null;
  outageT: number | null; outageXY: { x: number; y: number } | null; zonePolicy: boolean; zoneJobTaken: boolean;
  corridorActive: boolean; corridorEdges: Set<number>; corridorNodes: Set<number>;
  lots: Lot[];
  requests: Map<string, Req>; reqSeq: number; arrivals: number[];
  operators: Operator[]; review: { job: Job; endT: number } | null; answered: number;
  jobs: Job[]; seenJobs: Map<string, Job>; metrics: Metrics; blockingVehMin: number;
  seed: number; eventRng: () => number; randomEvents: boolean;
  plannedOutage: { at: number; center: LatLng; radiusM: number; restoreAfterS: number };
  plannedCollisions: { delayS: number; edgeId: number; clearanceS: number; fired: boolean }[];
  outage: OutageState | null; restoreTimes: Map<number, number>;
  incidents: (CollisionIncident & { assigned: boolean })[];
  yieldCommands: Map<number, YieldCommand>;
  routeCache: Map<string, Lane[] | null>;
};

const SUBSTEP_S = 0.5;

// ---------- seeded random ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- geometry ----------

function bearingDeg(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function toXY(center: LatLng, p: LatLng): { x: number; y: number } {
  return {
    x: (p.lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180),
    y: (p.lat - center.lat) * 110540,
  };
}

function nearestNode(graph: RoadGraph, p: LatLng): number {
  const q = toXY(graph.center, p);
  let best = graph.nodes[0].id;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const d = (n.x - q.x) ** 2 + (n.y - q.y) ** 2;
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

function lerp(a: RoadNode, b: RoadNode, f: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

// ---------- maps, routing and lot staging ----------

// The "Test Grid" environment: an n x n grid of two-way streets around SoMa.
// 9x9 at 250 m = 2 km across, so the 700 m outage covers the middle 21 of 81 nodes.
export function makeGridGraph(n = 9, spacingM = 250): RoadGraph {
  const center = { lat: 37.7785, lng: -122.4056 };
  const mPerLng = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const half = (n - 1) / 2;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c - half) * spacingM;
      const y = (r - half) * spacingM;
      nodes.push({ id: r * n + c, x, y, lat: center.lat + y / 110540, lng: center.lng + x / mPerLng });
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = r * n + c;
      if (c < n - 1) edges.push({ id: edges.length, from: id, to: id + 1, lengthM: spacingM, oneway: false });
      if (r < n - 1) edges.push({ id: edges.length, from: id, to: id + n, lengthM: spacingM, oneway: false });
    }
  }
  const at = (r: number, c: number): LatLng => ({ lat: nodes[r * n + c].lat, lng: nodes[r * n + c].lng });
  return {
    center, nodes, edges,
    pois: { fireStation: at(0, 0), hospital: at(n - 1, n - 1), lots: [at(0, n - 1), at(n - 1, 0), at(0, half | 0)] },
  };
}

function edgeBlocked(sim: Sim, edgeId: number): boolean {
  return sim.incidents.some(i => i.edgeId === edgeId && i.status !== 'CLEARED');
}

// B's shortestPath returns node ids; the sim drives lanes, so map each step to its lane.
function route(sim: Sim, from: number, to: number, avoidCorridor: boolean): Lane[] | null {
  if (from === to) return [];
  const key = `${from}:${to}:${avoidCorridor}`;
  if (sim.routeCache.has(key)) return sim.routeCache.get(key)?.slice() ?? null;
  const cost = (e: RoadEdge) => edgeBlocked(sim, e.id) || (avoidCorridor && sim.corridorEdges.has(e.id)) ? Infinity : e.lengthM;
  const path = shortestPath(sim.graph, from, to, cost);
  if (!path) { sim.routeCache.set(key, null); return null; }
  const lanes: Lane[] = [];
  for (let i = 1; i < path.length; i++) {
    const lane = sim.laneByStep.get(`${path[i - 1]}>${path[i]}`);
    if (!lane) return null;
    lanes.push(lane);
  }
  if (sim.routeCache.size > 2000) sim.routeCache.clear();
  sim.routeCache.set(key, lanes);
  return lanes.slice();
}

function nodeDist(sim: Sim, a: number, b: number): number {
  const p = sim.nodes.get(a)!.node, q = sim.nodes.get(b)!.node;
  return Math.hypot(p.x - q.x, p.y - q.y);
}

// At the outage, DARK GRID sends every empty car on the road to a lot in one minimum-distance
// assignment (B's hungarian). Each car only considers its 3 nearest lots with room, which keeps
// the matrix small even on a map with hundreds of lots.
function stageEmptyCars(sim: Sim) {
  const cars = sim.agents.filter((a) => a.place === 'ROAD' && a.type === 'EMPTY' && a.lot < 0);
  if (!cars.length || !sim.lots.length) return;
  const from = cars.map((a) => sim.lanes[a.lane].to);
  const wanted = new Map<number, number>();   // lot index -> how many cars have it in their top 3
  for (const n of from) {
    sim.lots
      .map((lot, i) => ({ i, d: nodeDist(sim, n, lot.node), room: lot.cap - lot.reserved }))
      .filter((l) => l.room > 0 && !lotInBlackout(sim, sim.lots[l.i]))
      .sort((p, q) => p.d - q.d || p.i - q.i)
      .slice(0, 3)
      .forEach(({ i }) => wanted.set(i, (wanted.get(i) ?? 0) + 1));
  }
  const cols: number[] = [];   // one column per parking slot
  for (const [i, n] of [...wanted].sort((p, q) => p[0] - q[0])) {
    const room = sim.lots[i].cap - sim.lots[i].reserved;
    for (let k = 0; k < Math.min(room, n); k++) cols.push(i);
  }
  const rows = cars.slice(0, cols.length);   // any car left over gets a lot on its next trip
  const pick = hungarian(rows.map((_, r) => cols.map((lot) => nodeDist(sim, from[r], sim.lots[lot].node))));
  rows.forEach((a, r) => {
    const lot = cols[pick[r]];
    const path = route(sim, from[r], sim.lots[lot].node, true);
    if (!path) return;
    a.lot = lot; sim.lots[lot].reserved++;
    a.dest = sim.lots[lot].node; a.route = path;
  });
}

// Staging lots: up to STAGING_LOTS of the map's lots, outside the blackout (so empty cars leave
// the dark zone) and spread out (each pick is the lot farthest from the ones already picked).
function stagingLots(graph: RoadGraph): LatLng[] {
  const all = graph.pois.lots.map((pos) => ({ pos, ...toXY(graph.center, pos) }));
  const outside = all.filter((l) => Math.hypot(l.x, l.y) > C.STAGING_MIN_DIST_M);
  const pool = (outside.length ? outside : all)
    .sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y) || a.pos.lat - b.pos.lat || a.pos.lng - b.pos.lng);
  const picked = pool.slice(0, 1);
  while (picked.length < Math.min(C.STAGING_LOTS, pool.length)) {
    let best = pool[0], bestD = -1;
    for (const l of pool) {
      const d = Math.min(...picked.map((q) => Math.hypot(l.x - q.x, l.y - q.y)));
      if (d > bestD) { best = l; bestD = d; }
    }
    picked.push(best);
  }
  return picked.map((l) => l.pos);
}

// One empty car at a time, for cars that were busy (in a box, at the curb) during staging.
// Empty cars never stage inside the blackout (it moves around, so lots can fall inside it).
function lotInBlackout(sim: Sim, lot: Lot): boolean {
  if (!sim.outageXY) return false;
  const n = sim.nodes.get(lot.node)!.node;
  return Math.hypot(n.x - sim.outageXY.x, n.y - sim.outageXY.y) <= (sim.outage?.radiusM ?? C.OUTAGE_RADIUS_M);
}

function assignLot(sim: Sim, from: number): number {
  let best = -1;
  let bestD = Infinity;
  sim.lots.forEach((lot, i) => {
    if (lot.reserved >= lot.cap || lotInBlackout(sim, lot)) return;
    const d = nodeDist(sim, from, lot.node);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// ---------- create ----------

function policyFor(mode: SimMode): Policy {
  return mode === 'FIFO'
    ? { dispatch: 'FIFO', batchMax: 1, darkSignalsAsFourWayStop: [], triageWeights: { ...C.DEFAULT_WEIGHTS } }
    : { dispatch: 'WSPT_TRIAGE', batchMax: 40, darkSignalsAsFourWayStop: [], triageWeights: { ...C.DEFAULT_WEIGHTS } };
}

export function createSim(graph: RoadGraph, seed: number, mode: SimMode, options: { randomEvents?: boolean } = {}): Sim {
  const nodes = new Map<number, NodeState>();
  for (const node of graph.nodes) nodes.set(node.id, { node, out: [], in: [], dark: false, nextPassT: 0, box: [], curb: [] });

  const lanes: Lane[] = [];
  const laneByStep = new Map<string, Lane>();
  const addLane = (edgeId: number, from: number, to: number, len: number, fraction = 0.55) => {
    const a = nodes.get(from)!.node, b = nodes.get(to)!.node;
    const lane: Lane = { id: lanes.length, edgeId, from, to, len: Math.max(1, len), obstacleS: Math.max(1, len) * fraction, headingDeg: bearingDeg(b.x - a.x, b.y - a.y), cars: [] };
    lanes.push(lane);
    const key = `${from}>${to}`;
    const prev = laneByStep.get(key);
    if (!prev || prev.len > lane.len) laneByStep.set(key, lane);   // parallel edges: keep the shorter
    nodes.get(from)!.out.push(lane);
    nodes.get(to)!.in.push(lane);
  };
  for (const e of graph.edges) {
    addLane(e.id, e.from, e.to, e.lengthM);
    if (!e.oneway) addLane(e.id, e.to, e.from, e.lengthM, 0.45);
  }

  const blankAgent = (id: number, type: Agent['type']): Agent => ({
    id, type, place: 'OFF', lane: -1, s: 0, speed: 0, route: [], dest: -1, boxNode: -1,
    decided: false, held: false, override: false, stoppedS: 0, requestId: null, lot: -1, yieldStartT: null,
  });

  const sim: Sim = {
    graph, mode, rng: mulberry32(seed), t: 0, control: 'AUTO', policy: policyFor(mode),
    lanes, laneByStep, nodes, nodeIds: graph.nodes.map((n) => n.id),
    agents: [], amb: blankAgent(C.VEHICLES, 'AMBULANCE'), ambRoute: [],
    dispatchT: null, arriveT: null, outageT: null, outageXY: null, zonePolicy: false, zoneJobTaken: false,
    corridorActive: false, corridorEdges: new Set(), corridorNodes: new Set(),
    lots: stagingLots(graph).map((pos) => ({ pos, node: nearestNode(graph, pos), cap: C.LOT_CAPACITY, used: 0, reserved: 0 })),
    requests: new Map(), reqSeq: 0, arrivals: [],
    operators: Array.from({ length: C.OPERATORS }, (_, i) => ({ id: `op${i + 1}`, job: null, doneT: 0 })),
    review: null, answered: 0, jobs: [], seenJobs: new Map(),
    metrics: { requests: 0, jobs: 0, lambdaPerMin: 0, rho: 0, blockingVehMin: 0, stuck: 0, darkCount: 0, ambulanceTripS: null },
    blockingVehMin: 0,
    seed: seed >>> 0, eventRng: mulberry32(seed ^ 0x5a17c0de), randomEvents: options.randomEvents ?? false,
    plannedOutage: { at: Infinity, center: graph.center, radiusM: C.OUTAGE_RADIUS_M, restoreAfterS: 300 },
    plannedCollisions: [], outage: null, restoreTimes: new Map(), incidents: [], yieldCommands: new Map(), routeCache: new Map(),
  };

  // Ambulance route: fire station -> hospital. Same in both modes.
  const fire = nearestNode(graph, graph.pois.fireStation);
  const hosp = nearestNode(graph, graph.pois.hospital);
  sim.ambRoute = route(sim, fire, hosp, false) ?? [];
  sim.amb.dest = hosp;

  // A separate event RNG means traffic/policy decisions cannot change the world's incident schedule.
  const between = (range: readonly [number, number]) => Math.round(range[0] + sim.eventRng() * (range[1] - range[0]));
  sim.plannedOutage = {
    at: between(C.RANDOM_OUTAGE_START_S),
    center: graph.nodes[Math.floor(sim.eventRng() * graph.nodes.length)],
    radiusM: between(C.RANDOM_OUTAGE_RADIUS_M), restoreAfterS: between(C.RANDOM_RESTORATION_DELAY_S),
  };
  if (sim.randomEvents) {
    const primary = sim.ambRoute.length ? sim.ambRoute[Math.floor(sim.ambRoute.length * (0.3 + sim.eventRng() * 0.4))].edgeId : graph.edges[0]?.id;
    const others = graph.edges.filter(e => e.id !== primary);
    const secondary = others[Math.floor(sim.eventRng() * others.length)]?.id;
    for (const [index, edgeId] of [primary, secondary].entries()) if (edgeId !== undefined) {
      sim.plannedCollisions.push({ delayS: index ? 90 + Math.floor(sim.eventRng() * 45) : 15 + Math.floor(sim.eventRng() * 20),
        edgeId, clearanceS: between(C.COLLISION_CLEARANCE_S), fired: false });
    }
  }

  // Place vehicles on random lanes with room.
  for (let i = 0; i < C.VEHICLES; i++) {
    const a = blankAgent(i, sim.rng() < C.PASSENGER_SHARE ? 'PASSENGER' : 'EMPTY');
    for (let tries = 0; tries < 20; tries++) {
      const lane = lanes[Math.floor(sim.rng() * lanes.length)];
      const s = sim.rng() * lane.len;
      if (lane.cars.some((c) => Math.abs(c.s - s) < C.GAP_M)) continue;
      a.place = 'ROAD'; a.lane = lane.id; a.s = s;
      lane.cars.push(a);
      lane.cars.sort((x, y) => y.s - x.s);
      break;
    }
    sim.agents.push(a);
  }
  for (const a of sim.agents) if (a.place === 'ROAD') newTrip(sim, a, lanes[a.lane].to);

  refreshJobs(sim);
  return sim;
}

// ---------- trips ----------

function newTrip(sim: Sim, a: Agent, from: number) {
  if (sim.mode === 'DARKGRID' && sim.outageT !== null && a.type === 'EMPTY' && a.lot < 0) {
    const lot = assignLot(sim, from);
    if (lot >= 0) {
      const path = route(sim, from, sim.lots[lot].node, sim.corridorActive);
      if (path) {
        a.lot = lot; sim.lots[lot].reserved++;
        a.dest = sim.lots[lot].node; a.route = path;
        return;
      }
    }
  }
  for (let tries = 0; tries < 5; tries++) {
    const dest = sim.nodeIds[Math.floor(sim.rng() * sim.nodeIds.length)];
    if (dest === from) continue;
    const path = route(sim, from, dest, sim.corridorActive);
    if (path) { a.dest = dest; a.route = path; return; }
  }
  a.dest = from; a.route = [];
}

// ---------- requests and jobs ----------

function createRequest(sim: Sim, a: Agent, nodeId: number, reason: HelpRequest['reason'], insideBox: boolean) {
  const id = `r${++sim.reqSeq}`;
  sim.requests.set(id, {
    id, vehicleId: a.id, nodeId, reason, createdAt: sim.t,
    onCorridor: sim.corridorActive && sim.corridorNodes.has(nodeId),
    insideBox, queuedBehind: 0, passenger: a.type === 'PASSENGER', assigned: false,
  });
  a.requestId = id;
  sim.arrivals.push(sim.t);
}

function resolveRequest(sim: Sim, id: string) {
  const r = sim.requests.get(id);
  if (!r) return;                   // cancelled meanwhile (the car got moving)
  sim.requests.delete(id);
  const a = sim.agents[r.vehicleId];
  a.requestId = null; a.held = false; a.override = true; a.stoppedS = 0;
}

function resolveJob(sim: Sim, job: Job) {
  if (job.kind === 'ZONE_POLICY') approveZonePolicy(sim);
  if (job.kind === 'COLLISION') {
    const incident = sim.incidents.find(i => i.id === job.incidentId);
    if (incident?.status === 'BLOCKED') {
      incident.status = 'RESPONDING'; incident.clearAt = sim.t + incident.clearanceS;
    }
  }
  for (const id of job.requestIds) resolveRequest(sim, id);
}

// ---------- zone policy ----------

const ZONE_JOB_ID = 'job-zone-policy';

function darkNodeIds(sim: Sim): number[] {
  const ids: number[] = [];
  for (const ns of sim.nodes.values()) if (ns.dark) ids.push(ns.node.id);
  return ids;
}

// DARK GRID's first card after an outage. One approval covers every dark signal.
function zoneJob(sim: Sim): Job | null {
  if (sim.mode !== 'DARKGRID' || sim.outageT === null || sim.zonePolicy || sim.zoneJobTaken) return null;
  const dark = darkNodeIds(sim).length;
  if (!dark) return null;
  let waiting = 0;
  for (const r of sim.requests.values()) if (r.reason === 'DARK_SIGNAL_CONFIRM') waiting++;
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  return {
    id: ZONE_JOB_ID, kind: 'ZONE_POLICY', requestIds: [], vehicleIds: [],
    w: 1000, p: C.SERVICE_SINGLE_S, createdAt: sim.outageT,
    title: `Approve zone policy · ${dark} dark signals`,
    sub: `Treat dark signals as 4-way stops · clears ${waiting} confirm requests · new asks ${pct(C.P_CONFIRM_DARK)} → ${pct(C.P_CONFIRM_DARK_ZONE_POLICY)}`,
    breakdown: [
      { label: 'dark signals', value: dark },
      { label: 'confirm requests cleared', value: waiting },
    ],
  };
}

function approveZonePolicy(sim: Sim) {
  sim.zonePolicy = true;
  sim.zoneJobTaken = false;
  sim.policy = { ...sim.policy, darkSignalsAsFourWayStop: darkNodeIds(sim) };
  // Cars waiting for a dark-signal confirmation now have their answer: proceed as a 4-way stop.
  for (const r of [...sim.requests.values()]) if (r.reason === 'DARK_SIGNAL_CONFIRM') resolveRequest(sim, r.id);
}

function queuedBehind(sim: Sim, a: Agent): number {
  if (a.place === 'BOX') return sim.nodes.get(a.boxNode)!.in.reduce((n, l) => n + l.cars.length, 0);
  if (a.place !== 'ROAD') return 0;
  const cars = sim.lanes[a.lane].cars;
  return cars.length - 1 - cars.indexOf(a);
}

function currentJobs(sim: Sim): Job[] {
  const open: HelpRequest[] = [];
  for (const r of sim.requests.values()) {
    if (r.assigned) continue;
    r.queuedBehind = queuedBehind(sim, sim.agents[r.vehicleId]);
    r.onCorridor = sim.corridorActive && sim.corridorNodes.has(r.nodeId);
    open.push({
      id: r.id, vehicleId: r.vehicleId, nodeId: r.nodeId, reason: r.reason, createdAt: r.createdAt,
      onCorridor: r.onCorridor, insideBox: r.insideBox, queuedBehind: r.queuedBehind, passenger: r.passenger,
    });
  }
  const jobs = orderJobs(open, sim.policy);
  for (const incident of sim.incidents) {
    if (incident.status !== 'BLOCKED' || incident.assigned) continue;
    const corridor = sim.corridorEdges.has(incident.edgeId);
    const queued = sim.lanes.filter(l => l.edgeId === incident.edgeId).reduce((sum, l) => sum + l.cars.length, 0);
    jobs.push({ id: `job-${incident.id}`, incidentId: incident.id, kind: 'COLLISION', requestIds: [], vehicleIds: [],
      w: (corridor ? C.DEFAULT_WEIGHTS.onCorridor : 0) + C.DEFAULT_WEIGHTS.insideBox + queued,
      p: C.SERVICE_SINGLE_S, createdAt: incident.createdAt, title: 'Dispatch collision recovery',
      sub: `Road ${incident.edgeId} closed · dispatch recovery, then ${incident.clearanceS} sim s on scene`,
      breakdown: [{ label: 'on corridor', value: corridor ? C.DEFAULT_WEIGHTS.onCorridor : 0 },
        { label: 'inside box', value: 0 }, { label: 'queued behind', value: queued }, { label: 'road obstruction', value: C.DEFAULT_WEIGHTS.insideBox }] });
  }
  jobs.sort((a, b) => (sim.mode === 'DARKGRID' ? b.w / b.p - a.w / a.p : 0)
    || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const zone = zoneJob(sim);
  return zone ? [zone, ...jobs] : jobs;
}

// Remembers jobs the screen may still show: a batch's id changes when a request joins it.
function refreshJobs(sim: Sim) {
  sim.jobs = currentJobs(sim);
  if (sim.seenJobs.size > 4000) sim.seenJobs = new Map();
  for (const j of sim.jobs) sim.seenJobs.set(j.id, j);
}

// The card the judge clicked may have a new id by now (a request joined or left the batch).
// Pick the current job that shares the most of its requests.
function successor(sim: Sim, jobId: string): Job | undefined {
  const seen = sim.seenJobs.get(jobId);
  if (!seen?.requestIds.length) return undefined;
  const ids = new Set(seen.requestIds);
  let best: Job | undefined;
  let bestN = 0;
  for (const j of sim.jobs) {
    const n = j.requestIds.filter((id) => ids.has(id)).length;
    if (n > bestN) { best = j; bestN = n; }
  }
  return best;
}

function takeJob(sim: Sim, job: Job) {
  if (job.kind === 'ZONE_POLICY') sim.zoneJobTaken = true;
  if (job.incidentId) {
    const incident = sim.incidents.find(i => i.id === job.incidentId);
    if (incident) incident.assigned = true;
  }
  for (const id of job.requestIds) {
    const r = sim.requests.get(id);
    if (r) r.assigned = true;
  }
}

// ---------- movement ----------

function remainingAmbulanceLanes(sim: Sim): Lane[] {
  return sim.amb.place === 'ROAD' ? [sim.lanes[sim.amb.lane], ...sim.amb.route] : sim.ambRoute;
}

function rerouteAmbulance(sim: Sim) {
  if (sim.arriveT !== null) return;
  const from = sim.amb.place === 'ROAD' ? sim.lanes[sim.amb.lane].to : sim.ambRoute[0]?.from;
  if (from === undefined) return;
  const path = route(sim, from, sim.amb.dest, false);
  if (!path) return; // A disconnected route stays blocked until recovery; never teleport through it.
  if (sim.amb.place === 'ROAD') { sim.amb.route = path; sim.ambRoute = [sim.lanes[sim.amb.lane], ...path]; }
  else sim.ambRoute = path;
}

function updateCorridor(sim: Sim) {
  if (sim.mode !== 'DARKGRID') return;
  const active = sim.outageT !== null && sim.t >= sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S - C.CORRIDOR_LEAD_S && sim.arriveT === null;
  const reserved: Lane[] = [];
  let distance = 0;
  if (active) for (const lane of remainingAmbulanceLanes(sim)) {
    reserved.push(lane); distance += lane.len;
    if (distance >= C.CORRIDOR_LOOKAHEAD_M) break;
  }
  const edges = new Set(reserved.map(l => l.edgeId));
  const changed = active !== sim.corridorActive || edges.size !== sim.corridorEdges.size || [...edges].some(id => !sim.corridorEdges.has(id));
  sim.corridorActive = active;
  if (!changed) return;
  sim.corridorEdges = edges;
  sim.corridorNodes = new Set(reserved.flatMap(l => [l.from, l.to]));
  sim.routeCache.clear();
  for (const a of sim.agents) {
    if (a.place !== 'ROAD' && a.place !== 'BOX' && a.place !== 'CURB') continue;
    if (a.route.some(l => edges.has(l.edgeId) || edgeBlocked(sim, l.edgeId))) {
      newTripTo(sim, a, a.place === 'ROAD' ? sim.lanes[a.lane].to : a.boxNode, a.dest);
    }
  }
  if (active) for (const a of sim.agents) {
    const edgeId = a.lane >= 0 ? sim.lanes[a.lane].edgeId : -1;
    sim.yieldCommands.set(a.id, { vehicleId: a.id, edgeId, issuedAt: sim.t, state: 'SENT',
      reason: edges.has(edgeId) ? 'Yield instruction sent to a corridor occupant' : 'Route exclusion sent to the fleet' });
  }
}

function locallyApproaching(sim: Sim, a: Agent): boolean {
  if (sim.dispatchT === null || sim.arriveT !== null || sim.amb.place !== 'ROAD' || a.place !== 'ROAD') return false;
  const lane = sim.lanes[a.lane];
  if (!remainingAmbulanceLanes(sim).slice(0, 2).some(l => l.edgeId === lane.edgeId)) return false;
  if (a.lane === sim.amb.lane && a.s < sim.amb.s) return false;
  const p = agentPos(sim, a), q = agentPos(sim, sim.amb);
  const d = toXY(p, q);
  return Math.hypot(d.x, d.y) <= C.LOCAL_EMERGENCY_YIELD_M;
}

function yieldVehicles(sim: Sim) {
  for (const a of sim.agents) {
    if (a.place === 'ROAD' && a.yieldStartT !== null && sim.t >= a.yieldStartT + C.YIELD_MANEUVER_S) {
      const lane = sim.lanes[a.lane];
      lane.cars.splice(lane.cars.indexOf(a), 1);
      a.place = 'CURB'; a.boxNode = lane.to; sim.nodes.get(lane.to)!.curb.push(a);
    }
    const lane = a.lane >= 0 ? sim.lanes[a.lane] : null;
    const needsCommand = lane && sim.corridorActive && (sim.corridorEdges.has(lane.edgeId)
      || (a.place === 'BOX' && sim.corridorNodes.has(a.boxNode)));
    let command = sim.yieldCommands.get(a.id);
    if (needsCommand && (a.place === 'ROAD' || a.place === 'BOX') && (!command || command.state === 'CLEARED')) {
      command = { vehicleId: a.id, edgeId: lane.edgeId, issuedAt: sim.t, state: 'SENT', reason: 'Awaiting vehicle acknowledgement' };
      sim.yieldCommands.set(a.id, command);
    }
    if (command && sim.t >= command.issuedAt + C.YIELD_ACK_S) {
      if (a.place === 'CURB' || a.place === 'LOT' || a.place === 'OFF' || !needsCommand) {
        command.state = 'CLEARED'; command.reason = 'Vehicle confirmed outside the reserved road';
      } else if (a.yieldStartT !== null) {
        command.state = 'CLEARING'; command.reason = 'Pulling into a reserved curb space';
      } else if (a.place === 'BOX' || a.held || a.requestId && sim.requests.get(a.requestId)?.reason === 'DARK_SIGNAL_CONFIRM') {
        command.state = 'BLOCKED'; command.reason = 'Safety confirmation required; escalated to an operator';
      } else {
        command.state = 'ACKNOWLEDGED'; command.reason = 'Looking for a safe curb space';
      }
    }
    if (a.place !== 'ROAD' || a.yieldStartT !== null || a.held || a.requestId && sim.requests.get(a.requestId)?.reason === 'DARK_SIGNAL_CONFIRM') continue;
    const coordinated = needsCommand && command && sim.t >= command.issuedAt + C.YIELD_ACK_S;
    if (!coordinated && !locallyApproaching(sim, a)) continue;
    const occupied = sim.agents.filter(other => other.lane === a.lane && other.yieldStartT !== null).length;
    // No curb parking within the intersection/stop line, and no unlimited curb capacity.
    if (occupied >= C.CURB_SLOTS_PER_LANE || lane!.len < 2 * C.GAP_M || a.s > lane!.len - C.GAP_M) {
      if (command) { command.state = 'BLOCKED'; command.reason = 'No safe curb space; clearing via the next intersection'; }
      continue;
    }
    if (a.requestId) resolveRequest(sim, a.requestId);
    a.yieldStartT = sim.t; a.speed = 0;
    if (command) { command.state = 'CLEARING'; command.reason = 'Pulling into a reserved curb space'; }
  }
}

function corridorView(sim: Sim): CorridorStatus {
  const commands = [...sim.yieldCommands.values()].map(c => ({ ...c }));
  const segments: CorridorStatus['segments'] = [];
  if (sim.corridorActive) for (const lane of remainingAmbulanceLanes(sim)) {
    if (!sim.corridorEdges.has(lane.edgeId)) continue;
    const blocked = edgeBlocked(sim, lane.edgeId) || sim.lanes.some(l => l.edgeId === lane.edgeId && l.cars.some(a => a.type !== 'AMBULANCE'))
      || [lane.from, lane.to].some(id => sim.nodes.get(id)!.box.length > 0);
    segments.push({ edgeId: lane.edgeId, from: sim.nodes.get(lane.from)!.node, to: sim.nodes.get(lane.to)!.node,
      state: blocked ? commands.some(c => c.edgeId === lane.edgeId && c.state === 'CLEARING') ? 'CLEARING' : 'RESERVED' : 'CLEAR' });
  }
  return { active: sim.corridorActive, commands, segments };
}

function enterLane(sim: Sim, a: Agent, lane: Lane): boolean {
  if (edgeBlocked(sim, lane.edgeId) || (a.type !== 'AMBULANCE' && sim.corridorActive && sim.corridorEdges.has(lane.edgeId))) return false;
  const back = lane.cars[lane.cars.length - 1];
  if (back && back.s < C.GAP_M) return false;
  lane.cars.push(a);
  a.place = 'ROAD'; a.lane = lane.id; a.s = 0; a.decided = false;
  if (a.requestId && sim.requests.get(a.requestId)?.reason === 'STUCK') {
    sim.requests.delete(a.requestId);   // it got moving, the request is moot
    a.requestId = null;
  }
  return true;
}

// The front car of `lane` is at the stop line. Returns nothing; moves it if allowed.
function atStopLine(sim: Sim, a: Agent, lane: Lane) {
  const ns = sim.nodes.get(lane.to)!;
  if (a.yieldStartT !== null) return;

  if (a.route.length && (edgeBlocked(sim, a.route[0].edgeId) || a.type !== 'AMBULANCE' && sim.corridorEdges.has(a.route[0].edgeId))) {
    const detour = route(sim, lane.to, a.dest, a.type !== 'AMBULANCE' && sim.corridorActive);
    const exit = a.type === 'AMBULANCE' ? undefined : ns.out.find(l => !edgeBlocked(sim, l.edgeId) && !sim.corridorEdges.has(l.edgeId));
    if (detour?.length) a.route = detour;
    else if (exit) a.route = [exit]; // Leave the corridor; keep the original destination for later.
    else return;
  }

  if (a.route.length === 0) {
    if (a.dest !== lane.to) {
      const path = route(sim, lane.to, a.dest, a.type !== 'AMBULANCE' && sim.corridorActive);
      if (!path?.length) return;
      a.route = path;
    }
  }
  if (a.route.length === 0) {
    if (a.type === 'AMBULANCE') {
      lane.cars.shift(); a.place = 'OFF'; sim.arriveT = sim.t;
      return;
    }
    if (a.lot >= 0 && sim.lots[a.lot].node === lane.to) {
      lane.cars.shift(); a.place = 'LOT'; sim.lots[a.lot].used++;
      return;
    }
    newTrip(sim, a, lane.to);
    if (a.route.length === 0) return;
  }

  if (ns.box.length > 0) return;    // someone is stopped inside the intersection
  if (a.held) return;               // waiting for an operator

  let priority = a.override;
  if (ns.dark) {
    if (a.type === 'AMBULANCE') {
      priority = priority || sim.corridorActive;
    } else if (!a.decided && !a.override && !a.requestId) {
      a.decided = true;
      const p = sim.zonePolicy ? C.P_CONFIRM_DARK_ZONE_POLICY : C.P_CONFIRM_DARK;
      if (sim.rng() < p) {
        const insideBox = sim.rng() < C.P_STOP_INSIDE_BOX;
        createRequest(sim, a, lane.to, 'DARK_SIGNAL_CONFIRM', insideBox);
        if (insideBox) {
          lane.cars.shift(); a.place = 'BOX'; a.boxNode = lane.to; ns.box.push(a);
        } else if (sim.mode === 'DARKGRID') {
          lane.cars.shift(); a.place = 'CURB'; a.boxNode = lane.to; ns.curb.push(a);
        } else {
          a.held = true;
        }
        return;
      }
    }
    if (!priority && sim.t < ns.nextPassT) return;
  }

  if (!enterLane(sim, a, a.route[0])) return;
  lane.cars.shift();
  a.route.shift();
  a.override = false;
  if (ns.dark) ns.nextPassT = sim.t + C.DARK_HEADWAY_S;
}

// A released car leaves the box or the curb into its next lane.
function leaveNode(sim: Sim, a: Agent, list: Agent[]) {
  if (a.yieldStartT !== null) {
    const ambulanceAhead = sim.arriveT === null && remainingAmbulanceLanes(sim).some(l => l.edgeId === sim.lanes[a.lane].edgeId);
    if (sim.dispatchT === null || ambulanceAhead) return;
    a.yieldStartT = null;
  }
  if (!a.route.length || a.route.some(l => edgeBlocked(sim, l.edgeId) || sim.corridorActive && sim.corridorEdges.has(l.edgeId))) {
    if (a.dest === a.boxNode) newTrip(sim, a, a.boxNode);
    else {
      const path = route(sim, a.boxNode, a.dest, sim.corridorActive);
      if (!path) return;
      a.route = path;
    }
  }
  if (a.route.length === 0 || !enterLane(sim, a, a.route[0])) return;
  list.splice(list.indexOf(a), 1);
  a.route.shift();
  a.override = false;
}

function placeAmbulance(sim: Sim) {
  const a = sim.amb;
  if (a.place !== 'OFF' || sim.dispatchT === null || sim.arriveT !== null || sim.ambRoute.length === 0) return;
  a.route = sim.ambRoute.slice(1);
  if (!enterLane(sim, a, sim.ambRoute[0])) a.route = [];
}

// ---------- tick ----------

function tick(sim: Sim, dt: number) {
  const prevT = sim.t;
  sim.t += dt;

  if (sim.randomEvents && sim.outageT === null && sim.t >= sim.plannedOutage.at) {
    injectEvent(sim, { type: 'OUTAGE', center: sim.plannedOutage.center, radiusM: sim.plannedOutage.radiusM, restoreAfterS: sim.plannedOutage.restoreAfterS });
  }
  for (const incident of sim.plannedCollisions) {
    if (!incident.fired && sim.outageT !== null && sim.t >= sim.outageT + incident.delayS) {
      incident.fired = true;
      injectEvent(sim, { type: 'COLLISION', edgeId: incident.edgeId, clearanceS: incident.clearanceS });
    }
  }
  for (const incident of sim.incidents) {
    if (incident.status === 'RESPONDING' && incident.clearAt !== null && sim.t >= incident.clearAt) {
      incident.status = 'CLEARED'; sim.routeCache.clear();
    }
  }
  if (sim.outage?.restoreAt !== null && sim.outage?.restoreAt !== undefined && sim.t >= sim.outage.restoreAt) {
    sim.outage.status = 'RESTORING';
    for (const [id, at] of sim.restoreTimes) if (sim.t >= at) sim.nodes.get(id)!.dark = false;
    for (const r of [...sim.requests.values()]) if (r.reason === 'DARK_SIGNAL_CONFIRM' && !sim.nodes.get(r.nodeId)!.dark) resolveRequest(sim, r.id);
    sim.policy.darkSignalsAsFourWayStop = sim.zonePolicy ? darkNodeIds(sim) : [];
    if (sim.outage.restoredAt !== null && sim.t >= sim.outage.restoredAt) {
      sim.outage.status = 'RESTORED';
    }
  }

  if (sim.outageT !== null && sim.dispatchT === null && sim.t >= sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S) {
    sim.dispatchT = sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S;
  }
  updateCorridor(sim);
  yieldVehicles(sim);
  placeAmbulance(sim);

  // Move: each car drives up to the car ahead (or the stop line).
  for (const lane of sim.lanes) {
    for (let i = 0; i < lane.cars.length; i++) {
      const a = lane.cars[i];
      if (a.yieldStartT !== null) { a.speed = 0; continue; }
      let limit = i === 0 ? lane.len : lane.cars[i - 1].s - C.GAP_M;
      const obstacle = lane.obstacleS;
      if (edgeBlocked(sim, lane.edgeId) && a.s < obstacle) limit = Math.min(limit, obstacle - C.GAP_M);
      const ns = Math.min(a.s + C.CRUISE_MPS * dt, Math.max(a.s, limit));
      a.speed = (ns - a.s) / dt;
      a.s = ns;
    }
  }
  for (const lane of sim.lanes) {
    const front = lane.cars[0];
    if (front && front.s >= lane.len - 0.01) atStopLine(sim, front, lane);
  }
  for (const ns of sim.nodes.values()) {
    for (const a of [...ns.box]) if (!a.requestId) leaveNode(sim, a, ns.box);
    for (const a of [...ns.curb]) if (!a.requestId) leaveNode(sim, a, ns.curb);
  }

  // Stuck detection: stopped too long -> asks for help. This is the cascade.
  let blocking = 0;
  for (const a of sim.agents) {
    if (a.place === 'BOX') blocking++;
    if (a.place !== 'ROAD') continue;
    if (a.speed < 0.1) { a.stoppedS += dt; blocking++; } else a.stoppedS = 0;
    if (a.yieldStartT !== null) continue;
    if (a.stoppedS >= C.STUCK_TIMEOUT_S && !a.requestId) createRequest(sim, a, sim.lanes[a.lane].to, 'STUCK', false);
  }
  sim.blockingVehMin += (blocking * dt) / 60;
  const amb = sim.amb;
  if (amb.place === 'ROAD' && amb.speed >= 0.1) amb.stoppedS = 0;
  else if (sim.dispatchT !== null && sim.arriveT === null) amb.stoppedS += dt;

  // Operators.
  for (const op of sim.operators) {
    if (op.job && sim.t >= op.doneT) { resolveJob(sim, op.job); op.job = null; }
  }
  if (sim.review && sim.t >= sim.review.endT) {
    resolveJob(sim, sim.review.job);
    sim.answered++;
    sim.review = null;
  }
  if (sim.control === 'AUTO') {
    for (const op of sim.operators) {
      if (op.job) continue;
      const next = currentJobs(sim).find((j) => j.kind !== 'ZONE_POLICY');   // only a human approves policy
      if (!next) break;
      takeJob(sim, next);
      op.job = next; op.doneT = sim.t + next.p;
    }
  }
  refreshJobs(sim);

  if (Math.floor(sim.t) > Math.floor(prevT)) updateMetrics(sim);
}

function updateMetrics(sim: Sim) {
  while (sim.arrivals.length && sim.arrivals[0] < sim.t - 60) sim.arrivals.shift();
  const lambdaPerMin = sim.arrivals.length;
  let stuck = 0;
  for (const a of sim.agents) {
    const r = a.requestId ? sim.requests.get(a.requestId) : undefined;
    if (r?.reason === 'STUCK' || a.stoppedS >= C.STUCK_TIMEOUT_S) stuck++;
  }
  let darkCount = 0;
  for (const ns of sim.nodes.values()) if (ns.dark) darkCount++;
  sim.metrics = {
    requests: sim.requests.size + sim.incidents.filter(i => i.status === 'BLOCKED').length,
    jobs: sim.jobs.length,
    lambdaPerMin,
    rho: lambdaPerMin / ((C.OPERATORS * 60) / C.SERVICE_SINGLE_S),
    blockingVehMin: sim.blockingVehMin,
    stuck,
    darkCount,
    ambulanceTripS: sim.arriveT !== null && sim.dispatchT !== null ? sim.arriveT - sim.dispatchT : null,
  };
}

// ---------- public API ----------

export function step(sim: Sim, dtS: number) {
  let left = dtS;
  while (left > 1e-9) {
    const dt = Math.min(SUBSTEP_S, left);
    tick(sim, dt);
    left -= dt;
  }
}

// A random blackout spot that still cuts the ambulance's path: a node from the middle 60% of the
// ambulance route, moved up to 250 m in a random direction. u1, u2, u3 are uniform [0, 1) numbers
// from the caller (the page), so the sim itself stays deterministic and both cities get the same spot.
export function pickOutageCenter(sim: Sim, u1: number, u2: number, u3: number): LatLng {
  const route = sim.ambRoute;
  if (route.length < 3) return sim.graph.center;
  const lane = route[Math.floor(route.length * (0.2 + 0.6 * u1))];
  const n = sim.nodes.get(lane.to)!.node;
  const r = 250 * Math.sqrt(u2), a = 2 * Math.PI * u3;
  const mPerLng = 111320 * Math.cos((sim.graph.center.lat * Math.PI) / 180);
  return { lat: n.lat + (r * Math.cos(a)) / 110540, lng: n.lng + (r * Math.sin(a)) / mPerLng };
}

export function injectEvent(sim: Sim, event: SimEvent) {
  if (event.type === 'COLLISION') {
    const road = sim.graph.edges.find(e => e.id === event.edgeId) ?? (event.edgeId === undefined ? sim.graph.edges.find(e => e.id === pickCollisionEdge(sim)) : undefined);
    if (!road || sim.incidents.length >= C.MAX_COLLISION_INCIDENTS || edgeBlocked(sim, road.id)) return;
    const a = sim.nodes.get(road.from)!.node, b = sim.nodes.get(road.to)!.node;
    sim.incidents.push({ id: `collision-${sim.incidents.length + 1}`, edgeId: road.id, pos: lerp(a, b, 0.55),
      headingDeg: bearingDeg(b.x - a.x, b.y - a.y), createdAt: sim.t, assigned: false,
      status: 'BLOCKED', clearanceS: Number.isFinite(event.clearanceS) && event.clearanceS! > 0 ? event.clearanceS! : C.COLLISION_CLEARANCE_S[0], clearAt: null });
    sim.arrivals.push(sim.t); sim.routeCache.clear();
    if (sim.mode === 'DARKGRID') {
      rerouteAmbulance(sim);
      for (const car of sim.agents) if (car.place === 'ROAD' && car.route.some(l => l.edgeId === road.id)) newTripTo(sim, car, sim.lanes[car.lane].to, car.dest);
    }
    updateCorridor(sim); refreshJobs(sim); updateMetrics(sim);
    return;
  }
  if (sim.outageT !== null) return;
  sim.outageT = sim.t;
  const c = toXY(sim.graph.center, event.center ?? sim.graph.center);
  sim.outageXY = c;
  const radiusM = Number.isFinite(event.radiusM) && event.radiusM! > 0 ? event.radiusM! : C.OUTAGE_RADIUS_M;
  const restoreAt = Number.isFinite(event.restoreAfterS) && event.restoreAfterS! > 0 ? sim.t + event.restoreAfterS! : null;
  sim.outage = { center: { ...(event.center ?? sim.graph.center) }, radiusM, startedAt: sim.t, restoreAt,
    restoredAt: restoreAt === null ? null : restoreAt + C.RESTORATION_SPREAD_S, status: 'ACTIVE' };
  for (const ns of sim.nodes.values()) {
    if (Math.hypot(ns.node.x - c.x, ns.node.y - c.y) <= radiusM) {
      ns.dark = true; ns.nextPassT = sim.t;
      if (restoreAt !== null) sim.restoreTimes.set(ns.node.id, restoreAt + sim.eventRng() * C.RESTORATION_SPREAD_S);
    }
  }
  if (sim.mode === 'DARKGRID') stageEmptyCars(sim);
  refreshJobs(sim); updateMetrics(sim);
}

export function pickCollisionEdge(sim: Sim): number | undefined {
  const ahead = remainingAmbulanceLanes(sim).filter(l => !edgeBlocked(sim, l.edgeId));
  return ahead[Math.floor(ahead.length * 0.45)]?.edgeId ?? sim.graph.edges.find(e => !edgeBlocked(sim, e.id))?.id;
}

// Reroute keeping the same destination (EMPTY cars get a lot instead).
function newTripTo(sim: Sim, a: Agent, from: number, dest: number) {
  const path = route(sim, from, dest, sim.corridorActive);
  if (path) a.route = path;
  else {
    const exit = sim.nodes.get(from)!.out.find(l => !edgeBlocked(sim, l.edgeId) && !sim.corridorEdges.has(l.edgeId));
    if (exit) a.route = [exit];
  }
}

export function setControl(sim: Sim, control: ControlMode) {
  if (control === sim.control) return;
  sim.control = control;
  if (control === 'MANUAL') {
    // The automatic operators stop; their unfinished jobs go back in the queue.
    for (const op of sim.operators) {
      if (!op.job) continue;
      if (op.job.incidentId) {
        const incident = sim.incidents.find(i => i.id === op.job!.incidentId);
        if (incident) incident.assigned = false;
      }
      for (const id of op.job.requestIds) {
        const r = sim.requests.get(id);
        if (r) r.assigned = false;
      }
      op.job = null;
    }
    refreshJobs(sim);
  }
}

// The judge clicks a job card. False if a review is running or the job is gone.
export function answerJob(sim: Sim, jobId: string): boolean {
  if (sim.review) return false;
  const job = sim.jobs.find((j) => j.id === jobId) ?? successor(sim, jobId);
  if (!job) return false;
  takeJob(sim, job);
  sim.review = { job, endT: sim.t + C.REVIEW_LOCK_REAL_S * C.SIM_SPEED };
  refreshJobs(sim);
  return true;
}

function agentPos(sim: Sim, a: Agent): LatLng {
  if (a.place === 'LOT') return sim.lots[a.lot].pos;
  if (a.place === 'BOX') { const n = sim.nodes.get(a.boxNode)!.node; return { lat: n.lat, lng: n.lng }; }
  if (a.place === 'OFF' || a.lane < 0) {
    const n = sim.nodes.get(sim.ambRoute[0]?.from ?? sim.nodeIds[0])!.node;
    return { lat: n.lat, lng: n.lng };
  }
  const lane = sim.lanes[a.lane];
  const f = a.place === 'CURB' && a.yieldStartT === null ? 1 : a.s / lane.len;
  const pos = lerp(sim.nodes.get(lane.from)!.node, sim.nodes.get(lane.to)!.node, f);
  if (a.yieldStartT !== null) {
    const offset = C.YIELD_OFFSET_M * Math.min(1, (sim.t - a.yieldStartT) / C.YIELD_MANEUVER_S);
    const theta = lane.headingDeg * Math.PI / 180;
    pos.lng += Math.cos(theta) * offset / (111320 * Math.cos(pos.lat * Math.PI / 180));
    pos.lat -= Math.sin(theta) * offset / 110540;
  }
  return pos;
}

function ambulanceView(sim: Sim): Ambulance | null {
  if (sim.outageT === null) return null;
  const a = sim.amb;
  const pos = sim.arriveT !== null ? (() => { const n = sim.nodes.get(a.dest)!.node; return { lat: n.lat, lng: n.lng }; })() : agentPos(sim, a);
  let headingDeg = 0;
  if (a.place === 'ROAD') {
    const next = sim.nodes.get(sim.lanes[a.lane].to)!.node;
    const here = toXY(sim.graph.center, pos);
    headingDeg = bearingDeg(next.x - here.x, next.y - here.y);
  } else if (sim.ambRoute[0]) headingDeg = sim.ambRoute[0].headingDeg;
  const status: Ambulance['status'] =
    sim.arriveT !== null ? 'ARRIVED'
    : sim.dispatchT === null ? 'WAITING'
    : a.stoppedS >= C.AMBULANCE_STUCK_S ? 'STUCK' : 'EN_ROUTE';
  const tripS = sim.dispatchT === null ? 0 : (sim.arriveT ?? sim.t) - sim.dispatchT;
  return { pos, headingDeg, status, tripS };
}

function vehicleView(sim: Sim, a: Agent): Vehicle {
  return {
    id: a.id,
    pos: agentPos(sim, a),
    headingDeg: a.lane >= 0 ? sim.lanes[a.lane].headingDeg : 0,
    state: a.yieldStartT !== null ? a.place === 'CURB' ? 'YIELDED' : 'YIELDING'
      : a.place === 'LOT' ? 'STAGED'
      : a.requestId ? 'REQUESTING_HELP'
      : a.place === 'ROAD' && a.speed < 0.1 ? 'QUEUED_BEHIND' : 'DRIVING',
    type: a.type === 'PASSENGER' ? 'PASSENGER' : 'EMPTY',
  };
}

/** Just where everything is: cheap enough for the 3D map to read on every animation frame. */
export function getMotion(sim: Sim): { t: number; vehicles: Vehicle[]; ambulance: Ambulance | null } {
  return { t: sim.t, vehicles: sim.agents.map((a) => vehicleView(sim, a)), ambulance: ambulanceView(sim) };
}

export function getSnapshot(sim: Sim): SimSnapshot {
  const vehicles: Vehicle[] = sim.agents.map((a) => vehicleView(sim, a));
  const darkNodes: LatLng[] = [];
  for (const ns of sim.nodes.values()) if (ns.dark) darkNodes.push({ lat: ns.node.lat, lng: ns.node.lng });
  const corridor: LatLng[] = [];
  const protocol = corridorView(sim);
  if (protocol.segments.length) {
    corridor.push(protocol.segments[0].from);
    for (const segment of protocol.segments) corridor.push(segment.to);
  }
  const operators = sim.control === 'MANUAL'
    ? [{ id: 'judge', task: sim.review ? sim.review.job.title : 'idle' }]
    : sim.operators.map((op) => ({ id: op.id, task: op.job ? op.job.title : 'idle' }));
  return {
    t: sim.t, mode: sim.mode, control: sim.control,
    manual: {
      reviewingJobId: sim.review?.job.id ?? null,
      lockRemainingS: sim.review ? Math.max(0, (sim.review.endT - sim.t) / C.SIM_SPEED) : 0,
      answered: sim.answered,
    },
    vehicles, ambulance: ambulanceView(sim),
    darkNodes, corridor,
    incidents: sim.incidents.map(i => ({ id: i.id, edgeId: i.edgeId, pos: { ...i.pos }, headingDeg: i.headingDeg,
      createdAt: i.createdAt, status: i.status, clearanceS: i.clearanceS, clearAt: i.clearAt })),
    corridorStatus: protocol, outage: sim.outage ? structuredClone(sim.outage) : null,
    scenario: { seed: sim.seed, automatic: sim.randomEvents, outageAt: sim.plannedOutage.at, collisionCount: sim.plannedCollisions.length },
    lots: sim.lots.map((l) => ({ pos: l.pos, used: l.used, cap: l.cap })),
    jobs: sim.jobs, operators, metrics: sim.metrics, policy: sim.policy,
  };
}
