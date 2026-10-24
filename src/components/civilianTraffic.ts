// Civilian (human-driven) traffic for the 3D map. Visual only: these cars are not part of the
// simulation and change no metric. They drive the real street graph in their own lane, wait a
// moment at blacked-out intersections, and pull to the curb and stop when the ambulance comes,
// then pull back out once it has passed. Most of San Francisco's traffic is cars like these.

import type { Ambulance, LatLng, RoadGraph } from '@/types/sim';

export const CIVILIANS = 900;
const CRUISE_MPS = 8;              // sim-time speed
const DARK_STOP_S = 2.5;           // a blacked-out intersection is a 4-way stop
const LANE_M = 1.7;                // drive right of the center line
const CURB_M = 2.8;                // extra offset when pulled over
const YIELD_AHEAD_M = 90;          // pull over when the ambulance is this close behind...
const YIELD_SIDE_M = 14;           // ...on the same street
const YIELD_NEAR_M = 30;           // anyone this close stops, whatever street they are on
const NEAR_CORRIDOR_M = 220;       // once the route is known, most cars are placed near it

type Edge = { from: number; to: number; len: number; ex: number; ny: number; bearing: number; lng0: number; lat0: number };
export type Civilian = { e: number; s: number; v: number; pull: number; waited: number; heading: number; paint: number };
export type Traffic = { edges: Edge[]; out: Map<number, number[]>; cars: Civilian[]; seededNearRoute: boolean; mLng: number };

const M_LAT = 110540;

export function createTraffic(graph: RoadGraph): Traffic {
  const mLng = 111320 * Math.cos((graph.center.lat * Math.PI) / 180);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges: Edge[] = [];
  const add = (a: number, b: number) => {
    const p = nodes.get(a)!, q = nodes.get(b)!;
    const dx = (q.lng - p.lng) * mLng, dy = (q.lat - p.lat) * M_LAT, len = Math.hypot(dx, dy);
    if (len < 1) return;
    edges.push({ from: a, to: b, len, ex: dx / len, ny: dy / len, bearing: (Math.atan2(dx, dy) * 180) / Math.PI, lng0: p.lng, lat0: p.lat });
  };
  for (const e of graph.edges) { add(e.from, e.to); if (!e.oneway) add(e.to, e.from); }
  const out = new Map<number, number[]>();   // node id -> edges leaving it
  edges.forEach((e, i) => (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(i));
  const traffic: Traffic = { edges, out, cars: [], seededNearRoute: false, mLng };
  for (let i = 0; i < CIVILIANS; i++) traffic.cars.push(spawn(traffic, Math.floor(Math.random() * edges.length)));
  return traffic;
}

function spawn(t: Traffic, e: number): Civilian {
  const edge = t.edges[e];
  return { e, s: Math.random() * edge.len, v: CRUISE_MPS, pull: 0, waited: 0, heading: edge.bearing, paint: Math.floor(Math.random() * 6) };
}

const outOf = (t: Traffic, node: number) => t.out.get(node) ?? [];

// Where a car is drawn: on its edge, right of the center line, further right when pulled over.
export function civilianPos(t: Traffic, c: Civilian): LatLng {
  const e = t.edges[c.e], side = LANE_M + CURB_M * c.pull;
  const x = e.ex * c.s + e.ny * side, y = e.ny * c.s - e.ex * side;
  return { lng: e.lng0 + x / t.mLng, lat: e.lat0 + y / M_LAT };
}

// Once the ambulance route exists, move cars that are far from it onto streets near it (away from
// the ambulance itself, so nobody appears under the camera).
function seedNearRoute(t: Traffic, corridor: LatLng[], amb: LatLng | null) {
  const near = (p: LatLng, r: number) => corridor.some((q) => Math.hypot((p.lng - q.lng) * t.mLng, (p.lat - q.lat) * M_LAT) < r);
  const candidates = t.edges.map((e, i) => (near({ lng: e.lng0, lat: e.lat0 }, NEAR_CORRIDOR_M) ? i : -1)).filter((i) => i >= 0);
  if (!candidates.length) return;
  for (const c of t.cars) {
    if (Math.random() < 0.35 || near(civilianPos(t, c), NEAR_CORRIDOR_M * 2)) continue;
    const moved = spawn(t, candidates[Math.floor(Math.random() * candidates.length)]);
    const p = civilianPos(t, moved);
    if (amb && Math.hypot((p.lng - amb.lng) * t.mLng, (p.lat - amb.lat) * M_LAT) < 200) continue;
    Object.assign(c, moved);
  }
  t.seededNearRoute = true;
}

/**
 * Advances every car by `simDt` sim-seconds (0 while paused or replaying); `dt` is real seconds for
 * the smooth parts (pulling over, turning). `darkNodes` are node ids without power.
 */
export function updateTraffic(t: Traffic, simDt: number, dt: number, amb: Ambulance | null, darkNodes: Set<number>, corridor: LatLng[]) {
  if (!t.seededNearRoute && corridor.length > 1) seedNearRoute(t, corridor, amb?.pos ?? null);
  const siren = amb && (amb.status === 'EN_ROUTE' || amb.status === 'STUCK');
  const fx = amb ? Math.sin((amb.headingDeg * Math.PI) / 180) : 0, fy = amb ? Math.cos((amb.headingDeg * Math.PI) / 180) : 0;
  const ease = 1 - Math.exp(-dt * 3);
  const turn = 1 - Math.exp(-dt * 8);
  for (const c of t.cars) {
    let yieldNow = false;
    if (siren) {
      const p = civilianPos(t, c);
      const rx = (p.lng - amb.pos.lng) * t.mLng, ry = (p.lat - amb.pos.lat) * M_LAT;
      const ahead = rx * fx + ry * fy, side = Math.abs(rx * fy - ry * fx);
      yieldNow = Math.hypot(rx, ry) < YIELD_NEAR_M || (ahead > -8 && ahead < YIELD_AHEAD_M && side < YIELD_SIDE_M);
    }
    c.pull += ((yieldNow ? 1 : 0) - c.pull) * ease;
    const e = t.edges[c.e];
    c.heading += ((((e.bearing - c.heading) % 360) + 540) % 360 - 180) * turn;
    if (yieldNow || simDt <= 0) { c.v = yieldNow ? 0 : c.v; continue; }
    c.v = Math.min(CRUISE_MPS, c.v + 3 * simDt);
    // Blacked-out intersection ahead: stop at the line, wait, then go.
    const stopAt = darkNodes.has(e.to) && c.waited < DARK_STOP_S ? e.len - 4 : Infinity;
    if (c.s >= stopAt - 0.1) { c.waited += simDt; c.v = 0; continue; }
    c.s = Math.min(c.s + c.v * simDt, stopAt);
    if (c.s < e.len) continue;
    const options = outOf(t, e.to).filter((i) => t.edges[i].to !== e.from);
    const choices = options.length ? options : outOf(t, e.to);
    if (!choices.length) { c.s = 0; continue; }
    c.s -= e.len;
    c.e = choices[Math.floor(Math.random() * choices.length)];
    c.waited = 0;
  }
}
