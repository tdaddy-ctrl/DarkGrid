import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGrid, distancesFrom, loadRoadGraph, nearestNode, nodesWithinRadius, pathLength, shortestPath } from './graph';
import type { RoadEdge, RoadGraph } from '../types/sim';

const length = (e: RoadEdge) => e.lengthM;
function directed(edges: RoadEdge[]): RoadGraph {
  return { ...buildGrid(3, 1, 100), edges };
}
const edge = (id: number, from: number, to: number, lengthM: number): RoadEdge => ({ id, from, to, lengthM, oneway: true });

describe('Team Task Brief grid cases', () => {
  it('uses row * cols + col IDs and finds a 400 m route', () => {
    const g = buildGrid(3, 3, 100);
    expect(g.nodes.map(n => n.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const path = shortestPath(g, 0, 8, length)!;
    expect(path[0]).toBe(0); expect(path.at(-1)).toBe(8);
    expect(pathLength(g, path)).toBe(400);
    expect(pathLength(g, shortestPath(g, 8, 0, length)!)).toBe(400);
  });
  it('avoids node 4 without increasing the route length', () => {
    const g = buildGrid(3, 3, 100);
    const path = shortestPath(g, 0, 8, e => e.from === 4 || e.to === 4 ? Infinity : e.lengthM)!;
    expect(path).not.toContain(4); expect(pathLength(g, path)).toBe(400);
  });
  it('returns null when both exits from 0 are forbidden', () => {
    const g = buildGrid(3, 3, 100);
    expect(shortestPath(g, 0, 8, e => e.from === 0 ? Infinity : e.lengthM)).toBeNull();
  });
  it('includes the exact radius boundary and sorts IDs', () => {
    expect(nodesWithinRadius(buildGrid(3, 3, 100), { x: 100, y: 100 }, 100)).toEqual([1, 3, 4, 5, 7]);
  });
});

describe('Dijkstra', () => {
  it('respects one-way roads and unreachable nodes', () => {
    const g = directed([edge(0, 0, 1, 10)]);
    expect(shortestPath(g, 0, 1, length)).toEqual([0, 1]);
    expect(shortestPath(g, 1, 0, length)).toBeNull();
    expect(shortestPath(g, 0, 2, length)).toBeNull();
    expect([...distancesFrom(g, 0, length)]).toEqual([[0, 0], [1, 10], [2, Infinity]]);
  });
  it('handles parallel edges, stale heap entries, and custom costs', () => {
    const g = directed([edge(0, 0, 1, 100), edge(1, 0, 1, 5), edge(2, 1, 2, 5), edge(3, 0, 2, 20)]);
    expect(distancesFrom(g, 0, length).get(2)).toBe(10);
    expect(shortestPath(g, 0, 2, length)).toEqual([0, 1, 2]);
    expect(shortestPath(g, 0, 2, e => e.id === 3 ? 0 : 1)).toEqual([0, 2]);
    expect(shortestPath(g, 0, 2, e => e.id === 1 ? Infinity : e.lengthM)).toEqual([0, 2]);
    expect(pathLength(g, [0, 1, 2])).toBe(10);
  });
  it('returns singleton paths and handles zero-cost cycles', () => {
    const g = buildGrid(3, 3, 100);
    expect(shortestPath(g, 4, 4, length)).toEqual([4]);
    expect(pathLength(g, [])).toBe(0); expect(pathLength(g, [4])).toBe(0);
    expect(shortestPath(g, 0, 8, () => 0)).not.toBeNull();
  });
  it('is deterministic even when input arrays are reversed', () => {
    const g = buildGrid(3, 3, 100);
    const expected = [0, 1, 2, 5, 8];
    expect(shortestPath(g, 0, 8, length)).toEqual(expected);
    expect(shortestPath({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }, 0, 8, length)).toEqual(expected);
  });
  it('rejects negative and NaN costs, even on disconnected edges', () => {
    const g = directed([edge(0, 1, 2, 10)]);
    for (const bad of [-1, -Infinity, NaN]) expect(() => shortestPath(g, 0, 0, () => bad)).toThrow();
  });
  it('rejects unknown endpoints and invalid path steps', () => {
    const g = directed([edge(0, 0, 1, 10)]);
    expect(() => shortestPath(g, 99, 0, length)).toThrow();
    expect(() => shortestPath(g, 0, 99, length)).toThrow();
    expect(() => pathLength(g, [1, 0])).toThrow();
  });
});

describe('graph loading and geometry', () => {
  it('loads parsed objects and strings without sharing mutable data', () => {
    const g = buildGrid(3, 3, 100), copy = loadRoadGraph(g);
    expect(copy).toEqual(g); expect(loadRoadGraph(JSON.stringify(g))).toEqual(g);
    copy.nodes[0].x = 999; expect(g.nodes[0].x).toBe(0);
    expect(() => loadRoadGraph({ ...g, edges: [edge(0, 0, 99, 10)] })).toThrow();
    expect(() => loadRoadGraph({ ...g, nodes: [g.nodes[0], g.nodes[0]] })).toThrow();
    expect(() => loadRoadGraph({})).toThrow();
  });
  it('finds nearest nodes with simulator coordinates and smallest-ID ties', () => {
    const g = buildGrid(3, 3, 100);
    expect(nearestNode(g, g.nodes[4])).toBe(4);
    const tied = { ...g, nodes: [{ ...g.nodes[1], x: 0, y: 0 }, g.nodes[0]] };
    expect(nearestNode(tied, g.center)).toBe(0);
    expect(nodesWithinRadius(g, { x: 0, y: 0 }, 0)).toEqual([0]);
    expect(() => nodesWithinRadius(g, { x: 0, y: 0 }, -1)).toThrow();
    expect(() => nearestNode({ ...g, nodes: [] }, g.center)).toThrow();
  });
  it('rejects invalid grid dimensions', () => {
    expect(() => buildGrid(0, 3, 100)).toThrow();
    expect(() => buildGrid(3, 3, -1)).toThrow();
  });
  it('loads the real road file and routes between its real POIs', () => {
    const g = loadRoadGraph(JSON.parse(readFileSync('public/data/soma_roads.json', 'utf8')));
    const from = nearestNode(g, g.pois.fireStation), to = nearestNode(g, g.pois.hospital);
    const path = shortestPath(g, from, to, length)!;
    expect(path[0]).toBe(from); expect(path.at(-1)).toBe(to);
    expect(pathLength(g, path)).toBeGreaterThan(0);
    expect(distancesFrom(g, from, length).get(to)).toBe(pathLength(g, path));
    // Simulator geometry is the straight segment between each pair of road nodes.
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const distances = path.slice(1).map((id, i) => {
      const a = byId.get(path[i])!, b = byId.get(id)!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = dx || dy ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy))) : 0;
      return Math.hypot(a.x + t * dx, a.y + t * dy);
    });
    expect(Math.min(...distances)).toBeLessThanOrEqual(300);
    expect(g.pois.fireStation).toEqual({ lat: byId.get(from)!.lat, lng: byId.get(from)!.lng });
    expect(g.pois.hospital).toEqual({ lat: byId.get(to)!.lat, lng: byId.get(to)!.lng });
  });
});
