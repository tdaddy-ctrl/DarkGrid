import type { LatLng, RoadEdge, RoadGraph, RoadNode } from '../types/sim';

type Cost = (edge: RoadEdge) => number;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const position = (v: unknown): v is LatLng & Record<string, unknown> => record(v) && finite(v.lat) && finite(v.lng)
  && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180;

/** Accept a parsed object or JSON string; validate references and return an owned copy. */
export function loadRoadGraph(json: unknown): RoadGraph {
  const g: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (!record(g) || !position(g.center) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)
    || !record(g.pois) || !position(g.pois.fireStation) || !position(g.pois.hospital)
    || !Array.isArray(g.pois.lots) || !g.pois.lots.every(position)) throw new Error('Invalid RoadGraph');
  const ids = new Set<number>();
  for (const n of g.nodes) {
    if (!record(n) || !Number.isSafeInteger(n.id) || !position(n) || !finite(n.x) || !finite(n.y)
      || ids.has(n.id as number)) throw new Error('Invalid or duplicate road node');
    ids.add(n.id as number);
  }
  const edgeIds = new Set<number>();
  for (const e of g.edges) {
    if (!record(e) || !Number.isSafeInteger(e.id) || edgeIds.has(e.id as number)
      || !ids.has(e.from as number) || !ids.has(e.to as number) || !finite(e.lengthM)
      || e.lengthM < 0 || typeof e.oneway !== 'boolean') throw new Error('Invalid road edge');
    edgeIds.add(e.id as number);
  }
  return structuredClone(g) as RoadGraph;
}

/** Synthetic test grid: origin at southwest; each stored edge is two-way. */
export function buildGrid(cols: number, rows: number, edgeLengthM: number): RoadGraph {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0
    || !finite(edgeLengthM) || edgeLengthM <= 0) throw new Error('Invalid grid dimensions or length');
  const center = { lat: 37.7700, lng: -122.4080 };
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const id = row * cols + col, x = col * edgeLengthM, y = row * edgeLengthM;
    nodes.push({ id, x, y, lat: center.lat + y / 110540,
      lng: center.lng + x / (111320 * Math.cos(center.lat * Math.PI / 180)) });
    if (col + 1 < cols) edges.push({ id: edges.length, from: id, to: id + 1, lengthM: edgeLengthM, oneway: false });
    if (row + 1 < rows) edges.push({ id: edges.length, from: id, to: id + cols, lengthM: edgeLengthM, oneway: false });
  }
  const pos = (n: RoadNode): LatLng => ({ lat: n.lat, lng: n.lng });
  return { center, nodes, edges, pois: { fireStation: pos(nodes[0]), hospital: pos(nodes[nodes.length - 1]), lots: [] } };
}

type Entry = { node: number; distance: number };
/** Binary min-heap ordered by distance, then node ID. */
class MinHeap {
  private items: Entry[] = [];
  private less(a: Entry, b: Entry) { return a.distance < b.distance || (a.distance === b.distance && a.node < b.node); }
  push(item: Entry) {
    const h = this.items;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]]; i = p;
    }
  }
  pop(): Entry | undefined {
    const h = this.items;
    if (!h.length) return undefined;
    const first = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= h.length) break;
        if (child + 1 < h.length && this.less(h[child + 1], h[child])) child++;
        if (!this.less(h[child], h[i])) break;
        [h[i], h[child]] = [h[child], h[i]]; i = child;
      }
    }
    return first;
  }
}

function dijkstra(g: RoadGraph, source: number, cost: Cost) {
  const distances = new Map(g.nodes.map(n => [n.id, Infinity]));
  if (!distances.has(source)) throw new Error(`Unknown source node: ${source}`);
  const adjacent = new Map(g.nodes.map(n => [n.id, [] as { to: number; weight: number; id: number }[]]));
  for (const edge of g.edges) {
    if (!adjacent.has(edge.from) || !adjacent.has(edge.to)) throw new Error('Invalid edge reference');
    const weight = cost(edge);
    // Validate every edge, including disconnected edges and source === destination queries.
    if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0) throw new Error('Edge cost must be nonnegative or Infinity');
    if (weight === Infinity) continue;
    adjacent.get(edge.from)!.push({ to: edge.to, weight, id: edge.id });
    if (!edge.oneway) adjacent.get(edge.to)!.push({ to: edge.from, weight, id: edge.id });
  }
  for (const list of adjacent.values()) list.sort((a, b) => a.to - b.to || a.id - b.id);
  const previous = new Map<number, number>();
  const heap = new MinHeap();
  distances.set(source, 0); heap.push({ node: source, distance: 0 });
  let entry: Entry | undefined;
  while ((entry = heap.pop())) {
    const { node, distance } = entry;
    if (distance !== distances.get(node)) continue;
    for (const edge of adjacent.get(node)!) {
      const next = distance + edge.weight;
      // Keep the first equal-cost predecessor; strict updates also prevent zero-cost cycles.
      if (next < distances.get(edge.to)!) {
        distances.set(edge.to, next); previous.set(edge.to, node);
        heap.push({ node: edge.to, distance: next });
      }
    }
  }
  return { distances, previous };
}

export function shortestPath(g: RoadGraph, from: number, to: number, cost: Cost): number[] | null {
  if (!g.nodes.some(n => n.id === to)) throw new Error(`Unknown destination node: ${to}`);
  const { distances, previous } = dijkstra(g, from, cost);
  if (distances.get(to) === Infinity) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(previous.get(path[path.length - 1])!);
  return path.reverse();
}

/** Map includes every node; unreachable nodes have distance Infinity. */
export function distancesFrom(g: RoadGraph, source: number, cost: Cost): Map<number, number> {
  return dijkstra(g, source, cost).distances;
}

/** Node-only paths cannot identify parallel edges: use the shortest legal physical edge. */
export function pathLength(g: RoadGraph, path: number[]): number {
  const ids = new Set(g.nodes.map(n => n.id));
  if (path.some(id => !ids.has(id))) throw new Error('Path contains unknown node');
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1], to = path[i];
    const edges = g.edges.filter(e => (e.from === from && e.to === to) || (!e.oneway && e.from === to && e.to === from));
    if (!edges.length) throw new Error('Path contains an invalid directed step');
    total += Math.min(...edges.map(e => e.lengthM));
  }
  return total;
}

export function nodesWithinRadius(g: RoadGraph, point: { x: number; y: number }, r: number): number[] {
  if (!finite(point.x) || !finite(point.y) || !finite(r) || r < 0) throw new Error('Invalid radius query');
  return g.nodes.filter(n => Math.hypot(n.x - point.x, n.y - point.y) <= r).map(n => n.id).sort((a, b) => a - b);
}

export function nearestNode(g: RoadGraph, latLng: LatLng): number {
  if (!position(latLng) || !g.nodes.length) throw new Error('Invalid position or empty graph');
  const x = (latLng.lng - g.center.lng) * 111320 * Math.cos(g.center.lat * Math.PI / 180);
  const y = (latLng.lat - g.center.lat) * 110540;
  let best = g.nodes[0], distance = Infinity;
  for (const n of g.nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < distance || (d === distance && n.id < best.id)) { best = n; distance = d; }
  }
  return best.id;
}
