// Simulator core. Pure TypeScript, no React. Same seed + same calls = exactly the same run.
// Times are sim seconds. Public API: createSim, step, injectEvent, getSnapshot,
// setControl, answerJob (plus makeGridGraph, the stand-in map until B's graph lands).

import type {
  Ambulance, ControlMode, HelpRequest, Job, LatLng, Metrics, Policy, RoadEdge, RoadGraph,
  RoadNode, SimSnapshot, Vehicle,
} from '@/types/sim';
import * as C from './config';

export type SimMode = 'FIFO' | 'DARKGRID';
// center defaults to graph.center (the substation point).
export type SimEvent = { type: 'OUTAGE'; center?: LatLng };

type Place = 'ROAD' | 'BOX' | 'CURB' | 'LOT' | 'OFF';

type Lane = {
  id: number; edgeId: number; from: number; to: number; len: number; headingDeg: number;
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
  lanes: Lane[]; nodes: Map<number, NodeState>; nodeIds: number[];
  agents: Agent[]; amb: Agent; ambRoute: Lane[];
  dispatchT: number | null; arriveT: number | null;
  outageT: number | null; zonePolicy: boolean;
  corridorActive: boolean; corridorEdges: Set<number>; corridorNodes: Set<number>;
  lots: Lot[];
  requests: Map<string, Req>; reqSeq: number; arrivals: number[];
  operators: Operator[]; review: { job: Job; endT: number } | null; answered: number;
  jobs: Job[]; metrics: Metrics; blockingVehMin: number;
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

// ---------- stand-ins (swap for B's versions when they land) ----------

// Stand-in for B's graph: an n x n grid of two-way streets around SoMa.
export function makeGridGraph(n = 5, spacingM = 250): RoadGraph {
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

// Stand-in for B's shortestPath: Dijkstra over lanes. With avoidCorridor, corridor
// streets cost 50x so other vehicles stay off them.
function shortestPath(sim: Sim, from: number, to: number, avoidCorridor: boolean): Lane[] | null {
  if (from === to) return [];
  const dist = new Map<number, number>([[from, 0]]);
  const via = new Map<number, Lane>();
  const heap: [number, number][] = [[0, from]];
  while (heap.length) {
    const [d, u] = heapPop(heap);
    if (u === to) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const lane of sim.nodes.get(u)!.out) {
      const cost = lane.len * (avoidCorridor && sim.corridorEdges.has(lane.edgeId) ? 50 : 1);
      const nd = d + cost;
      if (nd < (dist.get(lane.to) ?? Infinity)) {
        dist.set(lane.to, nd);
        via.set(lane.to, lane);
        heapPush(heap, [nd, lane.to]);
      }
    }
  }
  if (!via.has(to)) return null;
  const path: Lane[] = [];
  for (let v = to; v !== from; v = via.get(v)!.from) path.push(via.get(v)!);
  return path.reverse();
}

function heapPush(h: [number, number][], item: [number, number]) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h: [number, number][]): [number, number] {
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

// Stand-in for B's orderJobs: one job per request, oldest first.
function orderJobs(requests: HelpRequest[], policy: Policy): Job[] {
  return [...requests]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: `job-${r.id}`,
      kind: policy.dispatch === 'FIFO' ? 'FIFO' : 'SINGLE',
      requestIds: [r.id], vehicleIds: [r.vehicleId],
      w: 1, p: C.SERVICE_SINGLE_S, createdAt: r.createdAt,
      title: r.reason === 'STUCK' ? `Stuck vehicle #${r.vehicleId}` : `Dark signal confirm #${r.vehicleId}`,
      sub: `node ${r.nodeId}${r.insideBox ? ' · inside box' : ''}`,
      breakdown: [],
    }));
}

// Stand-in for B's hungarian(): nearest lot with room, in vehicle-id order.
function assignLot(sim: Sim, from: number): number {
  const p = sim.nodes.get(from)!.node;
  let best = -1;
  let bestD = Infinity;
  sim.lots.forEach((lot, i) => {
    if (lot.reserved >= lot.cap) return;
    const q = sim.nodes.get(lot.node)!.node;
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
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

export function createSim(graph: RoadGraph, seed: number, mode: SimMode): Sim {
  const nodes = new Map<number, NodeState>();
  for (const node of graph.nodes) nodes.set(node.id, { node, out: [], in: [], dark: false, nextPassT: 0, box: [], curb: [] });

  const lanes: Lane[] = [];
  const addLane = (edgeId: number, from: number, to: number, len: number) => {
    const a = nodes.get(from)!.node, b = nodes.get(to)!.node;
    const lane: Lane = { id: lanes.length, edgeId, from, to, len: Math.max(1, len), headingDeg: bearingDeg(b.x - a.x, b.y - a.y), cars: [] };
    lanes.push(lane);
    nodes.get(from)!.out.push(lane);
    nodes.get(to)!.in.push(lane);
  };
  for (const e of graph.edges) {
    addLane(e.id, e.from, e.to, e.lengthM);
    if (!e.oneway) addLane(e.id, e.to, e.from, e.lengthM);
  }

  const blankAgent = (id: number, type: Agent['type']): Agent => ({
    id, type, place: 'OFF', lane: -1, s: 0, speed: 0, route: [], dest: -1, boxNode: -1,
    decided: false, held: false, override: false, stoppedS: 0, requestId: null, lot: -1,
  });

  const sim: Sim = {
    graph, mode, rng: mulberry32(seed), t: 0, control: 'AUTO', policy: policyFor(mode),
    lanes, nodes, nodeIds: graph.nodes.map((n) => n.id),
    agents: [], amb: blankAgent(C.VEHICLES, 'AMBULANCE'), ambRoute: [],
    dispatchT: null, arriveT: null, outageT: null, zonePolicy: false,
    corridorActive: false, corridorEdges: new Set(), corridorNodes: new Set(),
    lots: graph.pois.lots.map((pos) => ({ pos, node: nearestNode(graph, pos), cap: C.LOT_CAPACITY, used: 0, reserved: 0 })),
    requests: new Map(), reqSeq: 0, arrivals: [],
    operators: Array.from({ length: C.OPERATORS }, (_, i) => ({ id: `op${i + 1}`, job: null, doneT: 0 })),
    review: null, answered: 0, jobs: [],
    metrics: { requests: 0, jobs: 0, lambdaPerMin: 0, rho: 0, blockingVehMin: 0, stuck: 0, darkCount: 0, ambulanceTripS: null },
    blockingVehMin: 0,
  };

  // Ambulance route: fire station -> hospital. Same in both modes.
  const fire = nearestNode(graph, graph.pois.fireStation);
  const hosp = nearestNode(graph, graph.pois.hospital);
  sim.ambRoute = shortestPath(sim, fire, hosp, false) ?? [];
  sim.amb.dest = hosp;

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

  sim.jobs = currentJobs(sim);
  return sim;
}

// ---------- trips ----------

function newTrip(sim: Sim, a: Agent, from: number) {
  if (sim.mode === 'DARKGRID' && sim.outageT !== null && a.type === 'EMPTY' && a.lot < 0) {
    const lot = assignLot(sim, from);
    if (lot >= 0) {
      const path = shortestPath(sim, from, sim.lots[lot].node, sim.corridorActive);
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
    const path = shortestPath(sim, from, dest, sim.corridorActive);
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
  for (const id of job.requestIds) resolveRequest(sim, id);
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
    open.push({
      id: r.id, vehicleId: r.vehicleId, nodeId: r.nodeId, reason: r.reason, createdAt: r.createdAt,
      onCorridor: r.onCorridor, insideBox: r.insideBox, queuedBehind: r.queuedBehind, passenger: r.passenger,
    });
  }
  return orderJobs(open, sim.policy);
}

function takeJob(sim: Sim, job: Job) {
  for (const id of job.requestIds) {
    const r = sim.requests.get(id);
    if (r) r.assigned = true;
  }
}

// ---------- movement ----------

function enterLane(sim: Sim, a: Agent, lane: Lane): boolean {
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
  if (a.route.length === 0) newTrip(sim, a, a.boxNode);
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

  if (sim.outageT !== null && sim.dispatchT === null && sim.t >= sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S) {
    sim.dispatchT = sim.outageT + C.AMBULANCE_DISPATCH_DELAY_S;
  }
  placeAmbulance(sim);

  // Move: each car drives up to the car ahead (or the stop line).
  for (const lane of sim.lanes) {
    for (let i = 0; i < lane.cars.length; i++) {
      const a = lane.cars[i];
      const limit = i === 0 ? lane.len : lane.cars[i - 1].s - C.GAP_M;
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
      const next = currentJobs(sim)[0];
      if (!next) break;
      takeJob(sim, next);
      op.job = next; op.doneT = sim.t + next.p;
    }
  }
  sim.jobs = currentJobs(sim);

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
    requests: sim.requests.size,
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

export function injectEvent(sim: Sim, event: SimEvent) {
  if (event.type !== 'OUTAGE' || sim.outageT !== null) return;
  sim.outageT = sim.t;
  const c = toXY(sim.graph.center, event.center ?? sim.graph.center);
  const dark: number[] = [];
  for (const ns of sim.nodes.values()) {
    if (Math.hypot(ns.node.x - c.x, ns.node.y - c.y) <= C.OUTAGE_RADIUS_M) {
      ns.dark = true; ns.nextPassT = sim.t;
      dark.push(ns.node.id);
    }
  }
  if (sim.mode !== 'DARKGRID') return;

  // DARK GRID: approve the zone policy, open the ambulance corridor, stage empty cars.
  sim.zonePolicy = true;
  sim.policy = { ...sim.policy, darkSignalsAsFourWayStop: dark };
  sim.corridorActive = true;
  for (const lane of sim.ambRoute) {
    sim.corridorEdges.add(lane.edgeId);
    sim.corridorNodes.add(lane.from);
    sim.corridorNodes.add(lane.to);
  }
  for (const a of sim.agents) {
    if (a.place !== 'ROAD') continue;
    const from = sim.lanes[a.lane].to;
    if (a.type === 'EMPTY' || a.route.some((l) => sim.corridorEdges.has(l.edgeId))) newTripTo(sim, a, from, a.dest);
  }
}

// Reroute keeping the same destination (EMPTY cars get a lot instead).
function newTripTo(sim: Sim, a: Agent, from: number, dest: number) {
  if (a.type === 'EMPTY') { newTrip(sim, a, from); return; }
  const path = shortestPath(sim, from, dest, true);
  if (path) a.route = path;
}

export function setControl(sim: Sim, control: ControlMode) {
  if (control === sim.control) return;
  sim.control = control;
  if (control === 'MANUAL') {
    // The automatic operators stop; their unfinished jobs go back in the queue.
    for (const op of sim.operators) {
      if (!op.job) continue;
      for (const id of op.job.requestIds) {
        const r = sim.requests.get(id);
        if (r) r.assigned = false;
      }
      op.job = null;
    }
    sim.jobs = currentJobs(sim);
  }
}

// The judge clicks a job card. False if a review is running or the job is gone.
export function answerJob(sim: Sim, jobId: string): boolean {
  if (sim.review) return false;
  const job = sim.jobs.find((j) => j.id === jobId);
  if (!job) return false;
  takeJob(sim, job);
  sim.review = { job, endT: sim.t + C.REVIEW_LOCK_REAL_S * C.SIM_SPEED };
  sim.jobs = currentJobs(sim);
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
  const f = a.place === 'CURB' ? 1 : a.s / lane.len;
  return lerp(sim.nodes.get(lane.from)!.node, sim.nodes.get(lane.to)!.node, f);
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

export function getSnapshot(sim: Sim): SimSnapshot {
  const vehicles: Vehicle[] = sim.agents.map((a) => ({
    id: a.id,
    pos: agentPos(sim, a),
    headingDeg: a.lane >= 0 ? sim.lanes[a.lane].headingDeg : 0,
    state: a.place === 'LOT' ? 'STAGED'
      : a.requestId ? 'REQUESTING_HELP'
      : a.place === 'ROAD' && a.speed < 0.1 ? 'QUEUED_BEHIND' : 'DRIVING',
    type: a.type === 'PASSENGER' ? 'PASSENGER' : 'EMPTY',
  }));
  const darkNodes: LatLng[] = [];
  for (const ns of sim.nodes.values()) if (ns.dark) darkNodes.push({ lat: ns.node.lat, lng: ns.node.lng });
  const corridor: LatLng[] = [];
  if (sim.corridorActive && sim.ambRoute.length) {
    const first = sim.nodes.get(sim.ambRoute[0].from)!.node;
    corridor.push({ lat: first.lat, lng: first.lng });
    for (const lane of sim.ambRoute) { const n = sim.nodes.get(lane.to)!.node; corridor.push({ lat: n.lat, lng: n.lng }); }
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
    lots: sim.lots.map((l) => ({ pos: l.pos, used: l.used, cap: l.cap })),
    jobs: sim.jobs, operators, metrics: sim.metrics, policy: sim.policy,
  };
}
