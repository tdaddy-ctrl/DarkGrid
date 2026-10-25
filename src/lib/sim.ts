// Simulator core. Pure TypeScript, no React. Same seed + same calls = exactly the same run.
// Times are sim seconds. Public API: createSim, step, injectEvent, getSnapshot,
// setControl, answerJob (plus makeGridGraph, the "Test Grid" environment).
// Routing, dispatch and lot staging come from B: graph.ts, dispatch.ts, hungarian.ts.

import type {
  Ambulance, ControlMode, HelpRequest, Job, LatLng, Metrics, Policy, RoadEdge, RoadGraph,
  RoadNode, SimSnapshot, Vehicle, CollisionIncident, YieldCommand, OutageState, CorridorStatus, RoadMotion,
  HelpCause, ZonePolicyState,
} from '@/types/sim';
import * as C from './config';
import { orderJobs } from './dispatch';
import { shortestPath } from './graph';
import { hungarian } from './hungarian';
import { darkSignalCauses, fourWayStopTurn, type Waiting } from './intersection';

export type SimMode = 'FIFO' | 'DARKGRID';
// Everything DARK GRID adds on top of FIFO. Vehicles drive by the same rules in both; only these differ.
// FIFO = all false, DARK GRID = all true. Turning all of them off in DARK GRID must reproduce FIFO exactly.
export type Features = {
  triage: boolean;            // sort jobs by impact / handling time (FIFO: by arrival)
  batching: boolean;          // answer compatible requests at one intersection together
  zonePolicy: boolean;        // offer the human-approved zone policy card
  corridor: boolean;          // reserve the road ahead of the ambulance and coordinate the vehicles on it
  staging: boolean;           // send empty cars to lots outside the blackout
  incidentBroadcast: boolean; // tell the fleet about closed roads at once (FIFO: found at the stop line)
};
const ALL_FEATURES: Features = { triage: true, batching: true, zonePolicy: true, corridor: true, staging: true, incidentBroadcast: true };
const NO_FEATURES: Features = { triage: false, batching: false, zonePolicy: false, corridor: false, staging: false, incidentBroadcast: false };
// center defaults to graph.center (the substation point).
export type SimEvent =
  | { type: 'OUTAGE'; center?: LatLng; radiusM?: number; restoreAfterS?: number }
  | { type: 'COLLISION'; edgeId?: number; clearanceS?: number };

type Place = 'ROAD' | 'BOX' | 'CURB' | 'LOT' | 'OFF';

type Lane = {
  id: number; edgeId: number; from: number; to: number; len: number; headingDeg: number;
  obstacleS: number;
  occluded: boolean;                // this approach cannot see cross traffic at its end node
  shape: LatLng[]; cumulativeM: number[]; shapeLengthM: number;
  cars: Agent[];                    // front (closest to `to`) first
};

type Agent = {
  id: number; type: 'PASSENGER' | 'EMPTY' | 'AMBULANCE';
  place: Place; lane: number; s: number; speed: number;
  route: Lane[];                    // lanes still to drive after the current one
  dest: number;
  boxNode: number;                  // node id while in BOX or CURB
  held: boolean;                    // stopped at the stop line until an operator answers
  stoppedS: number;
  requestId: string | null;
  lot: number;                      // index into sim.lots, -1 = none
  yieldStartT: number | null;
  arrivedT: number | null;          // reached the stop line of its current lane at this time
  exitBlockedSince: number | null;  // waiting for room past the intersection since
  known: Set<number>;               // dark nodes this vehicle has confirmed outage information for
  grants: Set<HelpCause>;           // operator answers that apply to the intersection ahead (cleared on the next lane)
  trips: number;                    // random trips started, keys the deterministic destination draw
  fault: { hard: boolean; towAt: number | null } | null;
};

type NodeState = {
  node: RoadNode; out: Lane[]; in: Lane[];
  dark: boolean; nextPassT: number;
  box: Agent[];                     // stopped inside the intersection: nobody passes
  curb: Agent[];                    // pulled over, not blocking
};

type Lot = { pos: LatLng; node: number; cap: number; used: number; reserved: number };
type Req = HelpRequest & { assigned: boolean; cause: HelpCause };
type Zone = ZonePolicyState & { area: Set<number> };
type Operator = { id: string; job: Job | null; doneT: number };

export type Sim = {
  graph: RoadGraph; mode: SimMode; features: Features; rng: () => number; t: number;
  control: ControlMode; policy: Policy;
  lanes: Lane[]; laneByStep: Map<string, Lane>; nodes: Map<number, NodeState>; nodeIds: number[];
  agents: Agent[]; amb: Agent; ambRoute: Lane[];
  mission: { originNode: number; pickupNode: number; hospitalNode: number;
    phase: NonNullable<Ambulance['mission']>['phase']; pickupStartedAt: number | null; pickupCompleteAt: number | null };
  dispatchT: number | null; arriveT: number | null;
  outageT: number | null; outageXY: { x: number; y: number } | null; zone: Zone | null; zoneJobTaken: boolean;
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
  plannedFaults: { vehicleId: number; delayS: number; hard: boolean; fired: boolean }[];
  yieldCommands: Map<number, YieldCommand>; corridorEpoch: number;
  ambulanceReroutes: number; ambulanceAvoid: Set<number>;
  createdByCause: Partial<Record<HelpCause, number>>;
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

// Counter-based draws: the same (seed, vehicle, node, ...) always gives the same number, whatever
// happened before. Mode-independent decisions use these instead of the shared rng stream.
const SALT = { UNSURE: 1, OCCLUDED: 2, TRIP: 3, FAULT_CLEAR: 4 } as const;
function hashU(seed: number, ...xs: number[]): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
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

function pointDistance(a: LatLng, b: LatLng): number {
  const d = toXY(a, b);
  return Math.hypot(d.x, d.y);
}

/** Attach the OSM bends lost by the original exporter without changing teammates' graph loader. */
export function withRoadGeometry(graph: RoadGraph): RoadGraph {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const key = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  return { ...graph, edges: graph.edges.map(edge => {
    if (edge.geometry?.length) return edge;
    const from = nodes.get(edge.from)!, to = nodes.get(edge.to)!;
    const direct = C.ROAD_GEOMETRY_OVERRIDES[`${key(from)}>${key(to)}`];
    const reversed = direct ? undefined : C.ROAD_GEOMETRY_OVERRIDES[`${key(to)}>${key(from)}`];
    const coordinates = direct ?? reversed?.slice().reverse();
    if (!coordinates) return edge;
    const geometry = coordinates.map(([lat, lng]) => ({ lat, lng }));
    geometry[0] = { lat: from.lat, lng: from.lng };
    geometry[geometry.length - 1] = { lat: to.lat, lng: to.lng };
    return { ...edge, geometry, lengthM: geometry.slice(1).reduce((sum, p, i) => sum + pointDistance(geometry[i], p), 0) };
  }) };
}

function laneSample(lane: Lane, s: number): { pos: LatLng; headingDeg: number } {
  const distance = Math.max(0, Math.min(lane.shapeLengthM, s / lane.len * lane.shapeLengthM));
  let index = 1;
  while (index < lane.shape.length - 1 && lane.cumulativeM[index] < distance) index++;
  const a = lane.shape[index - 1], b = lane.shape[index];
  const span = lane.cumulativeM[index] - lane.cumulativeM[index - 1];
  const f = span > 0 ? (distance - lane.cumulativeM[index - 1]) / span : 0;
  const d = toXY(a, b);
  return { pos: { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, headingDeg: bearingDeg(d.x, d.y) };
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
function route(sim: Sim, from: number, to: number, avoidCorridor: boolean, topologyOnly = false, avoid?: Set<number>): Lane[] | null {
  if (from === to) return [];
  const key = `${from}:${to}:${avoidCorridor}:${topologyOnly}:${avoid ? [...avoid].sort((a, b) => a - b).join(',') : ''}`;
  if (sim.routeCache.has(key)) return sim.routeCache.get(key)?.slice() ?? null;
  const cost = (e: RoadEdge) => !topologyOnly && (edgeBlocked(sim, e.id) || (avoidCorridor && sim.corridorEdges.has(e.id)) || avoid?.has(e.id)) ? Infinity : e.lengthM;
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

function policyFor(features: Features): Policy {
  return { dispatch: features.triage ? 'WSPT_TRIAGE' : 'FIFO', batchMax: features.batching ? 40 : 1,
    darkSignalsAsFourWayStop: [], triageWeights: { ...C.DEFAULT_WEIGHTS } };
}

export function createSim(graph: RoadGraph, seed: number, mode: SimMode,
  options: { randomEvents?: boolean; features?: Partial<Features> } = {}): Sim {
  const features = { ...(mode === 'DARKGRID' ? ALL_FEATURES : NO_FEATURES), ...options.features };
  graph = withRoadGeometry(graph);
  const nodes = new Map<number, NodeState>();
  for (const node of graph.nodes) nodes.set(node.id, { node, out: [], in: [], dark: false, nextPassT: 0, box: [], curb: [] });

  const lanes: Lane[] = [];
  const laneByStep = new Map<string, Lane>();
  const addLane = (edgeId: number, from: number, to: number, len: number, shape: LatLng[], fraction = 0.55) => {
    const a = nodes.get(from)!.node, b = nodes.get(to)!.node;
    const cumulativeM = [0];
    for (let i = 1; i < shape.length; i++) cumulativeM.push(cumulativeM[i - 1] + pointDistance(shape[i - 1], shape[i]));
    const lane: Lane = { id: lanes.length, edgeId, from, to, len: Math.max(1, len), obstacleS: Math.max(1, len) * fraction,
      occluded: hashU(seed, SALT.OCCLUDED, lanes.length) < C.OCCLUDED_APPROACH_SHARE,
      shape, cumulativeM, shapeLengthM: cumulativeM[cumulativeM.length - 1], headingDeg: bearingDeg(b.x - a.x, b.y - a.y), cars: [] };
    lanes.push(lane);
    const key = `${from}>${to}`;
    const prev = laneByStep.get(key);
    if (!prev || prev.len > lane.len) laneByStep.set(key, lane);   // parallel edges: keep the shorter
    nodes.get(from)!.out.push(lane);
    nodes.get(to)!.in.push(lane);
  };
  for (const e of graph.edges) {
    const shape = e.geometry ?? [nodes.get(e.from)!.node, nodes.get(e.to)!.node];
    addLane(e.id, e.from, e.to, e.lengthM, shape);
    if (!e.oneway) addLane(e.id, e.to, e.from, e.lengthM, shape.slice().reverse(), 0.45);
  }

  const blankAgent = (id: number, type: Agent['type']): Agent => ({
    id, type, place: 'OFF', lane: -1, s: 0, speed: 0, route: [], dest: -1, boxNode: -1,
    held: false, stoppedS: 0, requestId: null, lot: -1, yieldStartT: null,
    arrivedT: null, exitBlockedSince: null, known: new Set(), grants: new Set(), trips: 0, fault: null,
  });

  const sim: Sim = {
    graph, mode, features, rng: mulberry32(seed), t: 0, control: 'AUTO', policy: policyFor(features),
    lanes, laneByStep, nodes, nodeIds: graph.nodes.map((n) => n.id),
    agents: [], amb: blankAgent(C.VEHICLES, 'AMBULANCE'), ambRoute: [],
    mission: { originNode: nearestNode(graph, graph.pois.fireStation), pickupNode: -1,
      hospitalNode: nearestNode(graph, graph.pois.hospital), phase: 'TO_PICKUP', pickupStartedAt: null, pickupCompleteAt: null },
    dispatchT: null, arriveT: null, outageT: null, outageXY: null, zone: null, zoneJobTaken: false,
    corridorActive: false, corridorEdges: new Set(), corridorNodes: new Set(),
    lots: stagingLots(graph).map((pos) => ({ pos, node: nearestNode(graph, pos), cap: C.LOT_CAPACITY, used: 0, reserved: 0 })),
    requests: new Map(), reqSeq: 0, arrivals: [],
    operators: Array.from({ length: C.OPERATORS }, (_, i) => ({ id: `op${i + 1}`, job: null, doneT: 0 })),
    review: null, answered: 0, jobs: [], seenJobs: new Map(),
    metrics: { requests: 0, jobs: 0, lambdaPerMin: 0, rho: 0, blockingVehMin: 0, stuck: 0, darkCount: 0, ambulanceTripS: null },
    blockingVehMin: 0,
    seed: seed >>> 0, eventRng: mulberry32(seed ^ 0x5a17c0de), randomEvents: options.randomEvents ?? false,
    plannedOutage: { at: Infinity, center: graph.center, radiusM: C.OUTAGE_RADIUS_M, restoreAfterS: 300 },
    plannedCollisions: [], outage: null, restoreTimes: new Map(), incidents: [], plannedFaults: [],
    yieldCommands: new Map(), corridorEpoch: 0, ambulanceReroutes: 0, ambulanceAvoid: new Set(), createdByCause: {},
    routeCache: new Map(),
  };

  // A separate event RNG means traffic/policy decisions cannot change the world's incident schedule.
  const between = (range: readonly [number, number]) => Math.round(range[0] + sim.eventRng() * (range[1] - range[0]));
  sim.plannedOutage = {
    at: between(C.RANDOM_OUTAGE_START_S),
    center: graph.nodes[Math.floor(sim.eventRng() * graph.nodes.length)],
    radiusM: between(C.RANDOM_OUTAGE_RADIUS_M), restoreAfterS: between(C.RANDOM_RESTORATION_DELAY_S),
  };
  planAmbulanceMission(sim, sim.plannedOutage.center, sim.plannedOutage.radiusM);
  if (sim.randomEvents) {
    const rescueRoute = [...sim.ambRoute, ...(sim.mission.pickupNode >= 0 ? route(sim, sim.mission.pickupNode, sim.mission.hospitalNode, false, true) ?? [] : [])];
    const primary = rescueRoute.length ? rescueRoute[Math.floor(rescueRoute.length * (0.3 + sim.eventRng() * 0.4))].edgeId : graph.edges[0]?.id;
    const others = graph.edges.filter(e => e.id !== primary);
    const secondary = others[Math.floor(sim.eventRng() * others.length)]?.id;
    for (const [index, edgeId] of [primary, secondary].entries()) if (edgeId !== undefined) {
      sim.plannedCollisions.push({ delayS: index ? 90 + Math.floor(sim.eventRng() * 45) : 15 + Math.floor(sim.eventRng() * 20),
        edgeId, clearanceS: between(C.COLLISION_CLEARANCE_S), fired: false });
    }
  }

  // Vehicle faults: their own stream, so they are identical in both modes and do not move the outage plan.
  const faultRng = mulberry32(seed ^ 0x0fa017ed);
  const faulty = new Set<number>();
  while (faulty.size < Math.min(C.FAULTS_PER_RUN, C.VEHICLES)) faulty.add(Math.floor(faultRng() * C.VEHICLES));
  for (const vehicleId of [...faulty].sort((a, b) => a - b)) {
    const [lo, hi] = C.FAULT_AFTER_OUTAGE_S;
    sim.plannedFaults.push({ vehicleId, delayS: Math.round(lo + faultRng() * (hi - lo)), hard: faultRng() < C.HARD_FAULT_SHARE, fired: false });
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

function planAmbulanceMission(sim: Sim, center: LatLng, radiusM: number) {
  const origin = sim.mission.originNode, hospital = sim.mission.hospitalNode;
  const candidates = sim.graph.nodes.filter(n => pointDistance(center, n) <= radiusM && n.id !== origin && n.id !== hospital)
    .sort((a, b) => pointDistance(center, a) - pointDistance(center, b) || a.id - b.id);
  for (const node of candidates) {
    const inbound = route(sim, origin, node.id, false, true);
    const outbound = route(sim, node.id, hospital, false, true);
    if (!inbound?.length || !outbound?.length) continue;
    sim.mission.pickupNode = node.id;
    sim.amb.dest = node.id;
    sim.ambRoute = inbound;
    return;
  }
  sim.mission.pickupNode = -1; sim.ambRoute = [];
}

function prepareHospitalLeg(sim: Sim): boolean {
  const path = route(sim, sim.mission.pickupNode, sim.mission.hospitalNode, false);
  if (!path?.length) return false;
  sim.amb.dest = sim.mission.hospitalNode; sim.ambRoute = path;
  return true;
}

function newTrip(sim: Sim, a: Agent, from: number) {
  if (sim.features.staging && sim.outageT !== null && a.type === 'EMPTY' && a.lot < 0) {
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
  // The k-th trip of a vehicle goes to the same place in both modes.
  const trip = a.trips++;
  for (let tries = 0; tries < 5; tries++) {
    const dest = sim.nodeIds[Math.floor(hashU(sim.seed, SALT.TRIP, a.id, trip, tries) * sim.nodeIds.length)];
    if (dest === from) continue;
    const path = route(sim, from, dest, sim.corridorActive);
    if (path) { a.dest = dest; a.route = path; return; }
  }
  a.dest = from; a.route = [];
}

// ---------- requests and jobs ----------

// Only outage-information requests are batchable confirmations; everything else is handled one by one.
const reasonFor = (cause: HelpCause): HelpRequest['reason'] => cause === 'MISSING_OUTAGE_INFO' ? 'DARK_SIGNAL_CONFIRM' : 'STUCK';

// `hold`: the vehicle cannot decide on its own and waits at the stop line for the answer.
function createRequest(sim: Sim, a: Agent, nodeId: number, cause: HelpCause, hold: boolean): string {
  const id = `r${++sim.reqSeq}`;
  sim.requests.set(id, {
    id, vehicleId: a.id, nodeId, reason: reasonFor(cause), cause, createdAt: sim.t,
    onCorridor: sim.corridorActive && sim.corridorNodes.has(nodeId),
    insideBox: a.place === 'BOX', queuedBehind: 0, passenger: a.type === 'PASSENGER', assigned: false,
  });
  a.requestId = id; a.held = hold;
  sim.arrivals.push(sim.t);
  sim.createdByCause[cause] = (sim.createdByCause[cause] ?? 0) + 1;
  return id;
}

// The situation went away without an answer (the car got moving, the signal came back).
function cancelRequest(sim: Sim, id: string) {
  const r = sim.requests.get(id);
  if (!r) return;
  sim.requests.delete(id);
  const a = sim.agents[r.vehicleId];
  if (a.requestId === id) { a.requestId = null; a.held = false; }
}

// Requests that stop mattering once the vehicle drives into its next lane.
const MOOT_ON_MOVE = new Set<HelpCause>(['STUCK', 'EXIT_BLOCKED', 'INCIDENT', 'PRIORITY_AMBIGUOUS', 'CORRIDOR_BLOCKED']);
// Requests that exist only because a signal is dark.
const DARK_ONLY = new Set<HelpCause>(['MISSING_OUTAGE_INFO', 'SIGHTLINE_OCCLUDED', 'PRIORITY_AMBIGUOUS']);

// An operator's answer. Each cause gets its own remedy; none of them lets the vehicle skip the
// four-way stop order, the empty-box check or the exit-room check.
function resolveRequest(sim: Sim, id: string) {
  const r = sim.requests.get(id);
  if (!r) return;                   // cancelled meanwhile (the car got moving)
  sim.requests.delete(id);
  const a = sim.agents[r.vehicleId];
  if (a.requestId === id) { a.requestId = null; a.held = false; }
  a.stoppedS = 0;
  switch (r.cause) {
    case 'MISSING_OUTAGE_INFO': a.known.add(r.nodeId); break;
    case 'SIGHTLINE_OCCLUDED': a.grants.add('SIGHTLINE_OCCLUDED'); break;
    case 'PRIORITY_AMBIGUOUS': a.grants.add('PRIORITY_AMBIGUOUS'); break;
    case 'EXIT_BLOCKED': case 'INCIDENT': a.exitBlockedSince = null; alternateExit(sim, a); break;
    case 'CORRIDOR_BLOCKED':
      // The operator vouches for the next crossing so the car can leave the reserved road there.
      a.known.add(r.nodeId); a.grants.add('SIGHTLINE_OCCLUDED'); a.grants.add('PRIORITY_AMBIGUOUS'); break;
    case 'VEHICLE_FAULT':
      if (a.fault?.hard) {
        const [lo, hi] = C.COLLISION_CLEARANCE_S;   // the tow takes as long as a collision recovery
        a.fault.towAt = sim.t + Math.round(lo + hashU(sim.seed, SALT.FAULT_CLEAR, a.id) * (hi - lo));
      } else a.fault = null;
      break;
    default: break;
  }
}

// After an operator answers an exit or incident request: leave by another open street with room.
function alternateExit(sim: Sim, a: Agent) {
  if (a.place !== 'ROAD') return;
  const node = sim.lanes[a.lane].to;
  let best: Lane[] | null = null, bestLen = Infinity;
  for (const lane of sim.nodes.get(node)!.out) {
    if (lane === a.route[0] || !canEnter(sim, a, lane)) continue;
    const rest = route(sim, lane.to, a.dest, sim.corridorActive) ?? (lane.to === a.dest ? [] : null);
    if (!rest) continue;
    const len = lane.len + rest.reduce((n, l) => n + l.len, 0);
    if (len < bestLen || len === bestLen && best && lane.id < best[0].id) { best = [lane, ...rest]; bestLen = len; }
  }
  if (best) a.route = best;
}

function resolveJob(sim: Sim, job: Job, byHuman: boolean) {
  if (job.kind === 'ZONE_POLICY' && byHuman) approveZonePolicy(sim);   // automatic operators never approve policy
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

// DARK GRID's first card after an outage, and again after an approved policy expires.
// A manual revoke is final for this outage: a human decided the zone should not run under it.
function zoneJob(sim: Sim): Job | null {
  if (!sim.features.zonePolicy || sim.outageT === null || sim.zoneJobTaken) return null;
  if (sim.zone && sim.zone.endReason !== 'EXPIRED') return null;
  const dark = darkNodeIds(sim).length;
  if (!dark) return null;
  let waiting = 0;
  for (const r of sim.requests.values()) if (r.cause === 'MISSING_OUTAGE_INFO') waiting++;
  const renewal = sim.zone?.endReason === 'EXPIRED';
  return {
    id: ZONE_JOB_ID, kind: 'ZONE_POLICY', requestIds: [], vehicleIds: [],
    w: 1000, p: C.SERVICE_SINGLE_S, createdAt: renewal ? sim.zone!.endedAt! : sim.outageT,
    title: `${renewal ? 'Renew' : 'Approve'} zone policy · ${dark} dark signals`,
    sub: `Share outage information for ${dark} dark signals for ${Math.round(C.ZONE_POLICY_TTL_S / 60)} min · answers ${waiting} outage-info requests · other causes stay with operators`,
    breakdown: [
      { label: 'dark signals', value: dark },
      { label: 'outage-info requests answered', value: waiting },
    ],
  };
}

function zoneCovers(sim: Sim, node: number): boolean {
  return sim.zone?.status === 'ACTIVE' && sim.zone.area.has(node);
}

function syncPolicyList(sim: Sim) {
  sim.policy = { ...sim.policy, darkSignalsAsFourWayStop:
    sim.zone?.status === 'ACTIVE' ? [...sim.zone.area].filter((id) => sim.nodes.get(id)!.dark).sort((a, b) => a - b) : [] };
}

function approveZonePolicy(sim: Sim) {
  sim.zoneJobTaken = false;
  const area = new Set(darkNodeIds(sim));
  sim.zone = { status: 'ACTIVE', area, areaNodes: area.size, approvedAt: sim.t, expiresAt: sim.t + C.ZONE_POLICY_TTL_S,
    endedAt: null, endReason: null };
  syncPolicyList(sim);
  // Outage-information requests inside the area are answered. A vehicle that still has another
  // reason to wait keeps its request, re-labelled with that reason and its original time.
  for (const r of [...sim.requests.values()]) {
    if (r.cause !== 'MISSING_OUTAGE_INFO' || !area.has(r.nodeId)) continue;
    const a = sim.agents[r.vehicleId];
    const lane = a.place === 'ROAD' ? sim.lanes[a.lane] : null;
    if (lane?.occluded && !a.grants.has('SIGHTLINE_OCCLUDED')) { r.cause = 'SIGHTLINE_OCCLUDED'; r.reason = reasonFor(r.cause); continue; }
    sim.requests.delete(r.id);
    if (a.requestId === r.id) { a.requestId = null; a.held = false; }
  }
}

function endZone(sim: Sim, reason: NonNullable<ZonePolicyState['endReason']>) {
  if (sim.zone?.status !== 'ACTIVE') return;
  sim.zone.status = reason === 'EXPIRED' ? 'EXPIRED' : 'REVOKED';
  sim.zone.endedAt = sim.t; sim.zone.endReason = reason;
  syncPolicyList(sim);
}

/** A human ends the active zone policy. Vehicles keep only what they confirmed individually. */
export function revokeZonePolicy(sim: Sim): boolean {
  if (sim.zone?.status !== 'ACTIVE') return false;
  endZone(sim, 'MANUAL');
  refreshJobs(sim);
  return true;
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
  const jobs = orderJobs(open, sim.policy).map((job) => job.requestIds.length === 1 ? labelled(sim, job) : job);
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
  jobs.sort((a, b) => (sim.features.triage ? b.w / b.p - a.w / a.p : 0)
    || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const zone = zoneJob(sim);
  return zone ? [zone, ...jobs] : jobs;
}

const CAUSE_TITLE: Record<HelpCause, string> = {
  MISSING_OUTAGE_INFO: 'Dark signal confirm', SIGHTLINE_OCCLUDED: 'Sightline blocked', PRIORITY_AMBIGUOUS: 'Right of way unclear',
  EXIT_BLOCKED: 'Exit blocked', INCIDENT: 'Road closed ahead', VEHICLE_FAULT: 'Vehicle fault',
  CORRIDOR_BLOCKED: 'Cannot clear corridor', STUCK: 'Stuck vehicle',
};

// dispatch.ts only knows two reasons; name single jobs by their actual cause.
function labelled(sim: Sim, job: Job): Job {
  const r = sim.requests.get(job.requestIds[0]);
  if (!r) return job;
  return { ...job, title: `${CAUSE_TITLE[r.cause]} #${r.vehicleId}`, sub: `node ${r.nodeId} · ${r.cause.toLowerCase().replace(/_/g, ' ')}` };
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
  const from = sim.amb.place === 'ROAD' ? sim.lanes[sim.amb.lane].to
    : sim.mission.phase === 'PICKING_UP' ? sim.mission.pickupNode : sim.ambRoute[0]?.from;
  if (from === undefined) return;
  const path = route(sim, from, sim.amb.dest, false);
  if (!path) return; // A disconnected route stays blocked until recovery; never teleport through it.
  if (sim.amb.place === 'ROAD') { sim.amb.route = path; sim.ambRoute = [sim.lanes[sim.amb.lane], ...path]; }
  else sim.ambRoute = path;
}

// Physically on the reserved road: in one of its lanes, or stopped inside one of its intersections.
function onReservedRoad(sim: Sim, a: Agent): boolean {
  if (!sim.corridorActive) return false;
  if (a.place === 'ROAD') return sim.corridorEdges.has(sim.lanes[a.lane].edgeId);
  if (a.place === 'BOX') return sim.corridorNodes.has(a.boxNode);
  return false;
}

const TERMINAL = new Set<YieldCommand['state']>(['CLEARED', 'REROUTED']);

function issue(sim: Sim, a: Agent, kind: YieldCommand['kind'], reason: string): YieldCommand {
  const command: YieldCommand = { vehicleId: a.id, edgeId: a.lane >= 0 ? sim.lanes[a.lane].edgeId : -1, issuedAt: sim.t,
    epoch: sim.corridorEpoch, kind, state: 'SENT', reason };
  sim.yieldCommands.set(a.id, command);
  return command;
}

function updateCorridor(sim: Sim) {
  if (!sim.features.corridor) return;
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
  sim.corridorEpoch++;
  sim.corridorEdges = edges;
  sim.corridorNodes = new Set(reserved.flatMap(l => [l.from, l.to]));
  sim.routeCache.clear();
  // Only vehicles whose route used the reserved road get a reroute request; vehicles on it get a
  // clear request in yieldVehicles. Nobody else is messaged.
  for (const a of sim.agents) {
    if (a.place !== 'ROAD' && a.place !== 'BOX' && a.place !== 'CURB') continue;
    const usesCorridor = a.route.some(l => edges.has(l.edgeId));
    if (!usesCorridor && !a.route.some(l => edgeBlocked(sim, l.edgeId))) continue;
    newTripTo(sim, a, a.place === 'ROAD' ? sim.lanes[a.lane].to : a.boxNode, a.dest);
    if (usesCorridor && !onReservedRoad(sim, a)) issue(sim, a, 'REROUTE', 'Route used the reserved road; replanning around it');
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

// Free curb right here: not in or next to an intersection, and no other pulled-over car within CURB_SPACING_M.
function curbRoom(sim: Sim, a: Agent): boolean {
  if (a.place !== 'ROAD' || a.yieldStartT !== null || a.held || a.fault) return false;
  const lane = sim.lanes[a.lane];
  if (lane.len < 2 * C.GAP_M || a.s < C.GAP_M || a.s > lane.len - C.GAP_M) return false;
  return !sim.agents.some(o => o !== a && o.lane === a.lane && o.yieldStartT !== null && Math.abs(o.s - a.s) < C.CURB_SPACING_M);
}

function startPullOver(sim: Sim, a: Agent) {
  const r = a.requestId ? sim.requests.get(a.requestId) : undefined;
  if (r && MOOT_ON_MOVE.has(r.cause)) cancelRequest(sim, r.id);
  a.yieldStartT = sim.t; a.speed = 0;
}

// One step of a vehicle's corridor command. CLEARED is only ever set from the vehicle's position.
function progressCommand(sim: Sim, a: Agent, c: YieldCommand, reserved: boolean) {
  if (c.kind === 'REROUTE') {
    if (c.state === 'SENT' && sim.t >= c.issuedAt + C.YIELD_ACK_S) {
      const stillUses = a.route.some(l => sim.corridorEdges.has(l.edgeId));
      c.state = stillUses ? 'UNABLE' : 'REROUTED';
      c.reason = stillUses ? 'No route around the reserved road' : 'Replanned around the reserved road';
    }
    return;
  }
  if (TERMINAL.has(c.state)) return;
  if (!reserved) {
    c.state = 'CLEARED';
    c.reason = a.place === 'CURB' ? 'At the curb, off the reserved road' : a.place === 'LOT' || a.place === 'OFF' ? 'Off the road' : 'Drove off the reserved road';
    return;
  }
  if (c.state === 'SENT') {
    if (sim.t < c.issuedAt + C.YIELD_ACK_S) return;
    c.state = 'ACKNOWLEDGED'; c.reason = 'Acknowledged; looking for a safe way off';
  }
  const unable = a.fault ? 'Vehicle fault; cannot move' : a.held ? 'Waiting for a safety answer; cannot move' : null;
  if (c.state === 'ACKNOWLEDGED' || c.state === 'ESCALATED') {
    if (a.yieldStartT !== null) { c.state = 'EXECUTING'; c.reason = 'Pulling over into free curb space'; }
    else if (!unable && curbRoom(sim, a)) {
      if (c.requestId && sim.requests.get(c.requestId)?.cause === 'CORRIDOR_BLOCKED') cancelRequest(sim, c.requestId);
      startPullOver(sim, a); c.state = 'EXECUTING'; c.reason = 'Pulling over into free curb space';
    } else if (!unable && a.place === 'ROAD' && a.route.length && !sim.corridorEdges.has(a.route[0].edgeId)) {
      if (c.state === 'ACKNOWLEDGED') { c.state = 'EXECUTING'; c.reason = 'Driving off the reserved road at the next intersection'; }
    } else if (c.state === 'ACKNOWLEDGED') {
      c.state = 'UNABLE'; c.reason = unable ?? 'No free curb and no exit off the reserved road';
    }
  } else if (c.state === 'EXECUTING' && a.yieldStartT === null && unable) {
    c.state = 'UNABLE'; c.reason = unable;
  }
  if (c.state === 'UNABLE') {
    // Escalate: an open request now carries corridor priority; otherwise open one.
    const node = a.place === 'ROAD' ? sim.lanes[a.lane].to : a.boxNode;
    c.requestId = a.requestId ?? createRequest(sim, a, node, 'CORRIDOR_BLOCKED', false);
    c.state = 'ESCALATED'; c.reason = `${c.reason} · escalated to an operator`;
  }
}

function yieldVehicles(sim: Sim) {
  for (const a of sim.agents) {
    // A pull-over finishes: the car leaves the lane for the curb at the same spot.
    if (a.place === 'ROAD' && a.yieldStartT !== null && sim.t >= a.yieldStartT + C.YIELD_MANEUVER_S) {
      const lane = sim.lanes[a.lane];
      lane.cars.splice(lane.cars.indexOf(a), 1);
      a.place = 'CURB'; a.boxNode = lane.to; a.speed = 0; sim.nodes.get(lane.to)!.curb.push(a);
    }
    const reserved = onReservedRoad(sim, a);
    let command = sim.yieldCommands.get(a.id);
    if (reserved && (!command || command.kind === 'REROUTE' || TERMINAL.has(command.state))) {
      command = issue(sim, a, 'CLEAR', 'Clear request sent to a vehicle on the reserved road');
    }
    if (command) progressCommand(sim, a, command, reserved);
    // Local emergency yielding: every vehicle does this, in both modes.
    if (!reserved && a.yieldStartT === null && locallyApproaching(sim, a) && curbRoom(sim, a)) startPullOver(sim, a);
  }
}

// A vehicle on the reserved road that cannot clear it: once the ambulance is close, look for a detour
// around it. Without one the ambulance waits behind it; it never passes through.
function ambulanceDetour(sim: Sim) {
  if (!sim.features.corridor || sim.amb.place !== 'ROAD' || sim.arriveT !== null) return;
  const blockers = new Set<number>();
  for (const c of sim.yieldCommands.values()) {
    if (c.kind !== 'CLEAR' || c.state !== 'ESCALATED') continue;
    const v = sim.agents[c.vehicleId];
    if (v.place === 'ROAD' && onReservedRoad(sim, v)) blockers.add(sim.lanes[v.lane].edgeId);
  }
  if (!blockers.size || [...blockers].every(e => sim.ambulanceAvoid.has(e))) return;
  const here = sim.lanes[sim.amb.lane];
  let distance = here.len - sim.amb.s, ahead = false;
  for (const lane of sim.amb.route) {
    if (distance > C.AMBULANCE_REROUTE_M) break;
    if (blockers.has(lane.edgeId)) { ahead = true; break; }
    distance += lane.len;
  }
  if (!ahead) return;
  sim.ambulanceAvoid = new Set([...sim.ambulanceAvoid, ...blockers]);
  const path = route(sim, here.to, sim.amb.dest, false, false, sim.ambulanceAvoid);
  const length = (lanes: Lane[]) => lanes.reduce((n, l) => n + l.len, 0);
  if (!path || length(path) > length(sim.amb.route) + C.AMBULANCE_DETOUR_MAX_M) return;
  sim.amb.route = path; sim.ambRoute = [here, ...path]; sim.ambulanceReroutes++;
}

function corridorView(sim: Sim): CorridorStatus {
  const commands = [...sim.yieldCommands.values()].map(c => ({ ...c }));
  const segments: CorridorStatus['segments'] = [];
  if (sim.corridorActive) for (const lane of remainingAmbulanceLanes(sim)) {
    if (!sim.corridorEdges.has(lane.edgeId)) continue;
    const blocked = edgeBlocked(sim, lane.edgeId) || sim.lanes.some(l => l.edgeId === lane.edgeId && l.cars.some(a => a.type !== 'AMBULANCE'))
      || [lane.from, lane.to].some(id => sim.nodes.get(id)!.box.length > 0);
    segments.push({ edgeId: lane.edgeId, from: sim.nodes.get(lane.from)!.node, to: sim.nodes.get(lane.to)!.node, shape: lane.shape,
      state: blocked ? commands.some(c => c.edgeId === lane.edgeId && c.state === 'EXECUTING') ? 'CLEARING' : 'RESERVED' : 'CLEAR' });
  }
  return { active: sim.corridorActive, commands, segments, epoch: sim.corridorEpoch, ambulanceReroutes: sim.ambulanceReroutes };
}

function canEnter(sim: Sim, a: Agent, lane: Lane): boolean {
  if (edgeBlocked(sim, lane.edgeId) || (a.type !== 'AMBULANCE' && sim.corridorActive && sim.corridorEdges.has(lane.edgeId))) return false;
  const back = lane.cars[lane.cars.length - 1];
  return !(back && back.s < C.GAP_M);
}

function enterLane(sim: Sim, a: Agent, lane: Lane): boolean {
  if (!canEnter(sim, a, lane)) return false;
  lane.cars.push(a);
  a.place = 'ROAD'; a.lane = lane.id; a.s = 0;
  a.arrivedT = null; a.exitBlockedSince = null; a.grants.clear();
  const r = a.requestId ? sim.requests.get(a.requestId) : undefined;
  if (r && MOOT_ON_MOVE.has(r.cause)) cancelRequest(sim, r.id);   // it got moving, the request is moot
  return true;
}

// Ask for help, replacing a request that only said "I am stopped" with the actual reason.
function raise(sim: Sim, a: Agent, node: number, cause: HelpCause, hold: boolean) {
  if (a.type === 'AMBULANCE') return;   // the ambulance crew drives; it never queues for remote assistance
  const r = a.requestId ? sim.requests.get(a.requestId) : undefined;
  if (r?.cause === cause) return;
  if (r && !MOOT_ON_MOVE.has(r.cause)) return;
  if (r) cancelRequest(sim, r.id);
  createRequest(sim, a, node, cause, hold);
}

// Waiting for room past the intersection or for a closed road: autonomous until EXIT_WAIT_S.
function waitFor(sim: Sim, a: Agent, node: number, cause: 'EXIT_BLOCKED' | 'INCIDENT') {
  a.exitBlockedSince ??= sim.t;
  if (sim.t - a.exitBlockedSince >= C.EXIT_WAIT_S) raise(sim, a, node, cause, false);
}

function darkCauses(sim: Sim, a: Agent, lane: Lane): HelpCause[] {
  return darkSignalCauses({
    knowsOutage: a.known.has(lane.to) || zoneCovers(sim, lane.to),
    unsureWithoutInfo: hashU(sim.seed, SALT.UNSURE, a.id, lane.to) < C.UNSURE_WITHOUT_OUTAGE_INFO,
    occluded: lane.occluded, sightlineCleared: a.grants.has('SIGHTLINE_OCCLUDED'),
  });
}

// Vehicles at the stop lines of a dark node that could go now apart from right of way.
function waitingAt(sim: Sim, ns: NodeState): Waiting[] {
  const list: Waiting[] = [];
  for (const lane of ns.in) {
    const f = lane.cars[0];
    if (!f || f.type === 'AMBULANCE' || f.arrivedT === null || f.s < lane.len - 0.01) continue;
    if (f.held || f.fault || f.yieldStartT !== null || !f.route.length || !canEnter(sim, f, f.route[0])) continue;
    if (darkCauses(sim, f, lane).length) continue;
    list.push({ id: f.id, arrivedT: f.arrivedT, headingDeg: lane.headingDeg, token: f.grants.has('PRIORITY_AMBIGUOUS') });
  }
  return list;
}

// The front car of `lane` is at the stop line. The same rules in both modes: go when every condition
// holds, wait while one is temporarily false, ask for help only when it cannot decide.
function atStopLine(sim: Sim, a: Agent, lane: Lane) {
  const ns = sim.nodes.get(lane.to)!;
  if (a.yieldStartT !== null || a.fault) return;
  if (a.arrivedT === null) a.arrivedT = sim.t;

  if (a.route.length && (edgeBlocked(sim, a.route[0].edgeId) || a.type !== 'AMBULANCE' && sim.corridorEdges.has(a.route[0].edgeId))) {
    const detour = route(sim, lane.to, a.dest, a.type !== 'AMBULANCE' && sim.corridorActive);
    const exit = a.type === 'AMBULANCE' ? undefined : ns.out.find(l => !edgeBlocked(sim, l.edgeId) && !sim.corridorEdges.has(l.edgeId));
    if (detour?.length) a.route = detour;
    else if (exit) a.route = [exit]; // Leave the corridor; keep the original destination for later.
    else { if (edgeBlocked(sim, a.route[0].edgeId) && a.type !== 'AMBULANCE') waitFor(sim, a, lane.to, 'INCIDENT'); return; }
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
      lane.cars.shift(); a.speed = 0; a.stoppedS = 0;
      if (sim.mission.phase === 'TO_PICKUP') {
        a.place = 'CURB'; a.boxNode = lane.to;
        sim.mission.phase = 'PICKING_UP'; sim.mission.pickupStartedAt = sim.t;
        sim.mission.pickupCompleteAt = sim.t + C.PATIENT_LOADING_S;
        sim.ambRoute = [];
        prepareHospitalLeg(sim);
      } else {
        a.place = 'OFF'; sim.arriveT = sim.t; sim.mission.phase = 'DELIVERED';
      }
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
  if (a.held) return;               // waiting for an operator's answer
  const robotaxi = a.type !== 'AMBULANCE';
  if (ns.dark && robotaxi) {
    const cause = darkCauses(sim, a, lane)[0];
    if (cause) { raise(sim, a, lane.to, cause, true); return; }
  }
  const next = a.route[0];
  if (!canEnter(sim, a, next)) { waitFor(sim, a, lane.to, 'EXIT_BLOCKED'); return; }   // never block the box
  a.exitBlockedSince = null;
  // Four-way stop at a dark node. The ambulance has right of way there in both modes.
  if (ns.dark && robotaxi) {
    if (sim.t < ns.nextPassT) return;
    const turn = fourWayStopTurn(waitingAt(sim, ns));
    if (turn.go !== a.id) {
      if (turn.deadlock[0] === a.id && sim.t - a.arrivedT >= C.PRIORITY_DEADLOCK_S) raise(sim, a, lane.to, 'PRIORITY_AMBIGUOUS', false);
      return;
    }
  }

  enterLane(sim, a, next);
  lane.cars.shift();
  a.route.shift();
  if (ns.dark) ns.nextPassT = sim.t + C.DARK_HEADWAY_S;
}

// A released car leaves the intersection box into its next lane.
function leaveNode(sim: Sim, a: Agent, list: Agent[]) {
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
}

// A pulled-over car merges back into its own lane at the spot where it stopped, once the ambulance
// has passed and there is a gap. It never reappears anywhere else.
function rejoinLane(sim: Sim, a: Agent, list: Agent[]) {
  const lane = sim.lanes[a.lane];
  const ambulanceAhead = sim.arriveT === null && remainingAmbulanceLanes(sim).some(l => l.edgeId === lane.edgeId);
  if (sim.dispatchT === null || ambulanceAhead) return;
  if (sim.corridorActive && sim.corridorEdges.has(lane.edgeId)) return;
  if (lane.cars.some(o => Math.abs(o.s - a.s) < C.GAP_M)) return;
  let i = 0;
  while (i < lane.cars.length && lane.cars[i].s > a.s) i++;
  lane.cars.splice(i, 0, a);
  list.splice(list.indexOf(a), 1);
  a.place = 'ROAD'; a.yieldStartT = null; a.stoppedS = 0;
}

function placeAmbulance(sim: Sim) {
  const a = sim.amb;
  if (a.place !== 'OFF' || sim.dispatchT === null || sim.arriveT !== null || sim.ambRoute.length === 0 || sim.mission.phase === 'PICKING_UP') return;
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
    // A working signal answers dark-signal questions by itself; nobody needs to.
    for (const r of [...sim.requests.values()]) {
      if (DARK_ONLY.has(r.cause) && !sim.nodes.get(r.nodeId)!.dark) cancelRequest(sim, r.id);
    }
    syncPolicyList(sim);
    if (sim.outage.restoredAt !== null && sim.t >= sim.outage.restoredAt) {
      sim.outage.status = 'RESTORED';
    }
  }

  if (sim.zone?.status === 'ACTIVE') {
    if (sim.t >= sim.zone.expiresAt) endZone(sim, 'EXPIRED');
    else if ([...sim.zone.area].every((id) => !sim.nodes.get(id)!.dark)) endZone(sim, 'POWER_RESTORED');
  }
  for (const f of sim.plannedFaults) {
    if (f.fired || sim.outageT === null || sim.t < sim.outageT + f.delayS) continue;
    f.fired = true;
    const a = sim.agents[f.vehicleId];
    if (a.place !== 'ROAD' || a.yieldStartT !== null) continue;   // parked or at the curb: blocks nobody
    if (a.requestId) cancelRequest(sim, a.requestId);
    a.fault = { hard: f.hard, towAt: null }; a.speed = 0;
    createRequest(sim, a, sim.lanes[a.lane].to, 'VEHICLE_FAULT', true);
  }
  for (const a of sim.agents) {
    if (a.fault?.towAt == null || sim.t < a.fault.towAt) continue;
    const lane = sim.lanes[a.lane];   // towed away: out of the lane and out of service
    lane.cars.splice(lane.cars.indexOf(a), 1);
    a.place = 'OFF'; a.fault = null; a.speed = 0; a.route = [];
  }

  if (sim.outageT !== null && sim.dispatchT === null && sim.t >= sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S) {
    sim.dispatchT = sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S;
  }
  if (sim.mission.phase === 'PICKING_UP' && sim.mission.pickupCompleteAt !== null && sim.t >= sim.mission.pickupCompleteAt && prepareHospitalLeg(sim)) {
    sim.mission.phase = 'TO_HOSPITAL'; sim.amb.place = 'OFF'; sim.amb.stoppedS = 0; sim.ambulanceAvoid = new Set();
  }
  updateCorridor(sim);
  yieldVehicles(sim);
  ambulanceDetour(sim);
  placeAmbulance(sim);

  // Move: each car drives up to the car ahead (or the stop line).
  for (const lane of sim.lanes) {
    for (let i = 0; i < lane.cars.length; i++) {
      const a = lane.cars[i];
      if (a.yieldStartT !== null || a.fault) { a.speed = 0; continue; }
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
    for (const a of [...ns.curb]) rejoinLane(sim, a, ns.curb);
  }

  // Stuck detection: stopped too long -> asks for help. This is the cascade.
  let blocking = 0;
  for (const a of sim.agents) {
    if (a.place === 'BOX') blocking++;
    if (a.place !== 'ROAD') continue;
    if (a.speed < 0.1) { a.stoppedS += dt; blocking++; } else a.stoppedS = 0;
    if (a.yieldStartT !== null || a.fault) continue;
    if (a.stoppedS >= C.STUCK_TIMEOUT_S && !a.requestId) createRequest(sim, a, sim.lanes[a.lane].to, 'STUCK', false);
  }
  sim.blockingVehMin += (blocking * dt) / 60;
  const amb = sim.amb;
  if (sim.mission.phase === 'PICKING_UP' || amb.place === 'ROAD' && amb.speed >= 0.1) amb.stoppedS = 0;
  else if (sim.dispatchT !== null && sim.arriveT === null) amb.stoppedS += dt;

  // Operators.
  for (const op of sim.operators) {
    if (op.job && sim.t >= op.doneT) { resolveJob(sim, op.job, false); op.job = null; }
  }
  if (sim.review && sim.t >= sim.review.endT) {
    resolveJob(sim, sim.review.job, true);
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
  const openByCause: Partial<Record<HelpCause, number>> = {};
  for (const r of sim.requests.values()) openByCause[r.cause] = (openByCause[r.cause] ?? 0) + 1;
  sim.metrics = {
    requests: sim.requests.size + sim.incidents.filter(i => i.status === 'BLOCKED').length,
    jobs: sim.jobs.length,
    lambdaPerMin,
    rho: lambdaPerMin / ((C.OPERATORS * 60) / C.SERVICE_SINGLE_S),
    blockingVehMin: sim.blockingVehMin,
    stuck,
    darkCount,
    ambulanceTripS: sim.arriveT !== null && sim.dispatchT !== null ? sim.arriveT - sim.dispatchT : null,
    createdByCause: { ...sim.createdByCause },
    openByCause,
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
    const lane = sim.lanes.find(l => l.edgeId === road.id && l.from === road.from)!;
    const sample = laneSample(lane, lane.len * 0.55);
    sim.incidents.push({ id: `collision-${sim.incidents.length + 1}`, edgeId: road.id, pos: sample.pos,
      headingDeg: sample.headingDeg, createdAt: sim.t, assigned: false,
      status: 'BLOCKED', clearanceS: Number.isFinite(event.clearanceS) && event.clearanceS! > 0 ? event.clearanceS! : C.COLLISION_CLEARANCE_S[0], clearAt: null });
    sim.arrivals.push(sim.t); sim.routeCache.clear();
    if (sim.features.incidentBroadcast) {
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
  planAmbulanceMission(sim, sim.outage.center, radiusM);
  if (sim.features.incidentBroadcast) rerouteAmbulance(sim);
  for (const ns of sim.nodes.values()) {
    if (Math.hypot(ns.node.x - c.x, ns.node.y - c.y) <= radiusM) {
      ns.dark = true; ns.nextPassT = sim.t;
      if (restoreAt !== null) sim.restoreTimes.set(ns.node.id, restoreAt + sim.eventRng() * C.RESTORATION_SPREAD_S);
    }
  }
  if (sim.features.staging) stageEmptyCars(sim);
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
  if (a.place === 'OFF' && a.type !== 'AMBULANCE' && a.lane >= 0) return laneSample(sim.lanes[a.lane], a.s).pos;   // towed
  if (a.place === 'OFF' || a.lane < 0) {
    const node = a.type === 'AMBULANCE' ? sim.mission.phase === 'TO_HOSPITAL' ? sim.mission.pickupNode : sim.mission.originNode : sim.nodeIds[0];
    const n = sim.nodes.get(node)!.node;
    return { lat: n.lat, lng: n.lng };
  }
  const lane = sim.lanes[a.lane];
  const f = a.place === 'CURB' && a.yieldStartT === null ? 1 : a.s / lane.len;
  const sample = laneSample(lane, f * lane.len);
  const pos = sample.pos;
  if (a.yieldStartT !== null) {
    const offset = C.YIELD_OFFSET_M * Math.min(1, (sim.t - a.yieldStartT) / C.YIELD_MANEUVER_S);
    const theta = sample.headingDeg * Math.PI / 180;
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
    headingDeg = laneSample(sim.lanes[a.lane], a.s).headingDeg;
  } else if (sim.ambRoute[0]) headingDeg = sim.ambRoute[0].headingDeg;
  const status: Ambulance['status'] =
    sim.arriveT !== null ? 'ARRIVED'
    : sim.dispatchT === null ? 'WAITING'
    : a.stoppedS >= C.AMBULANCE_STUCK_S ? 'STUCK' : 'EN_ROUTE';
  const tripS = sim.dispatchT === null ? 0 : (sim.arriveT ?? sim.t) - sim.dispatchT;
  const point = (id: number): LatLng => { const n = sim.nodes.get(id)!.node; return { lat: n.lat, lng: n.lng }; };
  return { pos, headingDeg, status, tripS, road: agentRoad(sim, a),
    mission: sim.mission.pickupNode < 0 ? undefined : { origin: point(sim.mission.originNode), pickup: point(sim.mission.pickupNode), hospital: point(sim.mission.hospitalNode),
      phase: sim.mission.phase, pickupStartedAt: sim.mission.pickupStartedAt, pickupCompleteAt: sim.mission.pickupCompleteAt } };
}

function agentRoad(sim: Sim, a: Agent): RoadMotion | undefined {
  if (a.place !== 'ROAD' || a.yieldStartT !== null) return undefined;
  const lane = sim.lanes[a.lane];
  return { laneId: lane.id, from: lane.from, to: lane.to, shape: lane.shape };
}

function vehicleView(sim: Sim, a: Agent): Vehicle {
  return {
    id: a.id,
    pos: agentPos(sim, a),
    headingDeg: a.lane >= 0 ? laneSample(sim.lanes[a.lane], a.s).headingDeg : 0,
    state: a.yieldStartT !== null ? a.place === 'CURB' ? 'YIELDED' : 'YIELDING'
      : a.place === 'LOT' || a.place === 'OFF' ? 'STAGED'   // towed cars are hidden like parked ones
      : a.requestId || a.fault ? 'REQUESTING_HELP'
      : a.place === 'ROAD' && a.speed < 0.1 ? 'QUEUED_BEHIND' : 'DRIVING',
    type: a.type === 'PASSENGER' ? 'PASSENGER' : 'EMPTY',
    road: agentRoad(sim, a),
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
    for (const lane of remainingAmbulanceLanes(sim)) {
      if (!sim.corridorEdges.has(lane.edgeId)) continue;
      corridor.push(...(corridor.length ? lane.shape.slice(1) : lane.shape));
    }
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
    zonePolicy: sim.zone ? { status: sim.zone.status, areaNodes: sim.zone.areaNodes, approvedAt: sim.zone.approvedAt,
      expiresAt: sim.zone.expiresAt, endedAt: sim.zone.endedAt, endReason: sim.zone.endReason } : null,
    scenario: { seed: sim.seed, automatic: sim.randomEvents, outageAt: sim.plannedOutage.at, collisionCount: sim.plannedCollisions.length },
    lots: sim.lots.map((l) => ({ pos: l.pos, used: l.used, cap: l.cap })),
    jobs: sim.jobs, operators, metrics: sim.metrics, policy: sim.policy,
  };
}
