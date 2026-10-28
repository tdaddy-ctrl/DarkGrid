import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RoadGraph } from '../types/sim';
import { loadRoadGraph } from './graph';
import { createSim, getSnapshot, injectEvent, step, type Sim } from './sim';
import * as C from './config';

const DT = 0.5;
function network(immediateExit = false): RoadGraph {
  const center = { lat: 37.78, lng: -122.4 };
  const xy = [[0, 0], [30, 0], [45, 0], [75, 0], [75, 30], [105, 0], [135, 0], [30, -30]];
  const nodes = xy.map(([x, y], id) => ({ id, x, y, lat: center.lat + y / 110540, lng: center.lng + x / (111320 * Math.cos(center.lat * Math.PI / 180)) }));
  const streets = [[0, 1, 30], [1, 2, 15], [2, 3, 30], [3, 5, 30], [5, 6, 30], [3, 4, 30], [7, 1, 30]];
  if (immediateExit) streets.push([1, 4, 60]);
  const edges = streets
    .map(([from, to, lengthM], id) => ({ id, from, to, lengthM, oneway: true }));
  return { center, nodes, edges, pois: { fireStation: nodes[0], hospital: nodes[6], lots: [nodes[4]] } };
}

function fixture(mode: 'FIFO' | 'DARKGRID' = 'DARKGRID', immediateExit = false) {
  const sim = createSim(network(immediateExit), 73, mode);
  for (const lane of sim.lanes) lane.cars = [];
  for (const a of sim.agents) { a.place = 'OFF'; a.requestId = null; a.held = false; }
  sim.plannedFaults = [];
  injectEvent(sim, { type: 'OUTAGE', radiusM: 1, restoreAfterS: 10000 });
  sim.t = 60;
  const lane = (from: number, to: number) => sim.laneByStep.get(from + '>' + to)!;
  const here = lane(0, 1), first = lane(1, 2), second = lane(2, 3), exit = lane(3, 4);
  const root = sim.agents[0];
  Object.assign(root, { type: 'PASSENGER', place: 'ROAD', lane: here.id, s: here.len, speed: 0,
    route: [first, second, exit], dest: 4, held: false, fault: null, arrivedT: 60, yieldStartT: null });
  root.known.clear(); root.grants.clear();
  here.cars.push(root);
  const rescue = [here, first, second, lane(3, 5), lane(5, 6)];
  Object.assign(sim.amb, { place: 'ROAD', lane: here.id, s: here.len - C.GAP_M, speed: 0,
    route: rescue.slice(1), dest: 6, arrivedT: null });
  sim.ambRoute = rescue; sim.dispatchT = 60; sim.mission.phase = 'TO_HOSPITAL';
  here.cars.push(sim.amb);
  const block = () => {
    const obstacle = sim.agents[1];
    Object.assign(obstacle, { place: 'ROAD', lane: first.id, s: 0, speed: 0, fault: { hard: true, towAt: null }, route: [second], dest: 3 });
    first.cars.push(obstacle);
    return obstacle;
  };
  return { sim, root, here, first, second, exit, lane, block };
}

function safeStep(sim: Sim, seconds = DT) {
  for (let t = 0; t < seconds; t += DT) {
    const previous = [...sim.agents, sim.amb].map(a => ({ place: a.place, lane: a.lane, s: a.s, held: a.held }));
    step(sim, DT);
    for (const lane of sim.lanes) for (let i = 1; i < lane.cars.length; i++) {
      if (lane.cars[i - 1].s - lane.cars[i].s < C.GAP_M - 1e-6) throw new Error('Vehicle spacing violated on lane ' + lane.id);
    }
    [...sim.agents, sim.amb].forEach((a, i) => {
      const old = previous[i];
      if (old.place !== 'ROAD' || a.place !== 'ROAD') return;
      if (a.lane === old.lane) {
        if (a.s < old.s || a.s - old.s > C.CRUISE_MPS * DT + 1e-6) throw new Error('Nonphysical movement: vehicle ' + a.id);
      } else {
        if (sim.lanes[old.lane].to !== sim.lanes[a.lane].from || a.s !== 0
          || old.s + C.CRUISE_MPS * DT < sim.lanes[old.lane].len - 0.02) throw new Error('Disconnected/jumping lane transition: vehicle ' + a.id);
        if (sim.incidents.some(e => e.edgeId === sim.lanes[a.lane].edgeId && e.status !== 'CLEARED')) throw new Error('Entered closed road');
        if (old.held && sim.nodes.get(sim.lanes[old.lane].to)!.dark) throw new Error('Held vehicle crossed a dark signal');
      }
    });
  }
}

describe('controlled corridor egress', () => {
  it('drives through the one-exit connector and multiple reserved segments to a real exit', () => {
    const { sim, root, here, first, second, exit } = fixture();
    const visited = new Set<number>();
    for (let i = 0; i < 160; i++) { safeStep(sim); if (root.place === 'ROAD') visited.add(root.lane); }
    expect(visited.has(first.id)).toBe(true);
    expect(visited.has(second.id)).toBe(true);
    expect(visited.has(exit.id)).toBe(true);
    expect(here.cars.includes(root)).toBe(false);
    expect(sim.yieldCommands.get(root.id)?.state).toBe('CLEARED');
    expect(sim.arriveT).not.toBeNull();
    expect(root.dest).toBe(4);
  });

  it('does not grant the exemption to an outside vehicle, even with a stale CLEAR record', () => {
    const { sim, lane, block } = fixture();
    block();
    const outside = sim.agents[2], road = lane(7, 1);
    Object.assign(outside, { place: 'ROAD', lane: road.id, s: road.len, speed: 0,
      route: [lane(1, 2), lane(2, 3), lane(3, 4)], dest: 4, held: false, fault: null, yieldStartT: null });
    road.cars.push(outside);
    sim.yieldCommands.set(outside.id, { vehicleId: outside.id, edgeId: road.edgeId, issuedAt: 0,
      epoch: 0, kind: 'CLEAR', state: 'ESCALATED', reason: 'Old instruction' });
    safeStep(sim, 5);
    expect(outside.lane).toBe(road.id);
  });

  it('keeps the existing curb mechanism when it is available', () => {
    const { sim, root } = fixture();
    root.s = 12; sim.amb.s = 4;
    safeStep(sim, 6);
    expect(root.place).toBe('CURB');
    expect(sim.yieldCommands.get(root.id)?.reason).toContain('curb');
  });

  it('uses an available non-reserved immediate exit without special egress', () => {
    const { sim, root, lane } = fixture('DARKGRID', true);
    safeStep(sim);
    expect(root.lane).toBe(lane(1, 4).id);
    expect(sim.yieldCommands.get(root.id)?.reason).not.toContain('validated corridor egress');
  });

  it('does not enter a full downstream lane', () => {
    const { sim, root, here, block } = fixture();
    block(); safeStep(sim, 5);
    expect(root.lane).toBe(here.id);
    expect(root.s).toBe(here.len);
  });

  it('does not enter a closed downstream road', () => {
    const { sim, root, here, first } = fixture();
    injectEvent(sim, { type: 'COLLISION', edgeId: first.edgeId });
    safeStep(sim, 5);
    expect(root.lane).toBe(here.id);
    expect(sim.incidents[0].status).not.toBe('CLEARED');
  });

  it('does not exempt a vehicle with a hard fault', () => {
    const { sim, root, here } = fixture();
    root.fault = { hard: true, towAt: null };
    safeStep(sim, 5);
    expect(root.lane).toBe(here.id);
    expect(root.s).toBe(here.len);
  });

  it('revalidates a planned exit after the ambulance route changes', () => {
    const { sim, root, here, first, second, exit } = fixture();
    safeStep(sim, 1.5);
    expect(root.lane).toBe(first.id);
    // The old exit now belongs to the rescue route; no non-reserved route to this destination remains.
    sim.amb.route = [first, second, exit];
    sim.ambRoute = [here, ...sim.amb.route]; sim.amb.dest = 4;
    safeStep(sim, 8);
    expect(root.lane).toBe(first.id);
    expect(root.s).toBe(first.len);
  });

  it('revalidates downstream capacity after egress has started', () => {
    const { sim, root, first, second } = fixture();
    safeStep(sim, 1.5);
    expect(root.lane).toBe(first.id);
    const obstacle = sim.agents[1];
    Object.assign(obstacle, { place: 'ROAD', lane: second.id, s: 0, fault: { hard: true, towAt: null } });
    second.cars.push(obstacle);
    safeStep(sim, 5);
    expect(root.lane).toBe(first.id);
  });

  it('revokes forward entry when a planned segment closes after egress starts', () => {
    const { sim, root, first, second } = fixture();
    safeStep(sim, 1.5);
    expect(root.lane).toBe(first.id);
    injectEvent(sim, { type: 'COLLISION', edgeId: second.edgeId });
    safeStep(sim, 5);
    expect(root.lane).toBe(first.id);
  });

  it('reports no modeled egress when no directed route to the trip destination exists', () => {
    const { sim, root, here } = fixture();
    root.dest = 0; // This directed network has no return path to node 0.
    safeStep(sim, 5);
    expect(root.lane).toBe(here.id);
    expect(sim.yieldCommands.get(root.id)?.state).toBe('ESCALATED');
  });

  it('requires a vehicle-specific CLEAR instruction and does not act ahead of acknowledgment', () => {
    const { sim, root, here } = fixture();
    safeStep(sim, 1);
    expect(root.lane).toBe(here.id);
    expect(sim.yieldCommands.get(root.id)?.state).toBe('SENT');
    safeStep(sim);
    expect(root.lane).not.toBe(here.id);
  });

  it('does not let a vehicle behind the ambulance receive a forward egress exemption', () => {
    const { sim, root, here } = fixture();
    root.s = here.len - 16; sim.amb.s = here.len - 8;
    here.cars.sort((a, b) => b.s - a.s);
    safeStep(sim, 0.5);
    expect(sim.yieldCommands.get(root.id)?.reason).not.toContain('validated corridor egress');
    expect(root.s).toBeLessThan(sim.amb.s);
  });

  it('does not merge an old CLEAR vehicle into an ambulance approaching on another lane', () => {
    const { sim, root, here, first, second, lane } = fixture();
    here.cars = here.cars.filter(a => a !== sim.amb);
    const approach = lane(7, 1);
    sim.amb.lane = approach.id; sim.amb.s = approach.len - C.GAP_M;
    approach.cars.push(sim.amb);
    sim.amb.route = [first, second, lane(3, 5), lane(5, 6)];
    sim.ambRoute = [approach, ...sim.amb.route];
    sim.yieldCommands.set(root.id, { vehicleId: root.id, edgeId: here.edgeId, issuedAt: 0,
      epoch: 0, kind: 'CLEAR', state: 'ACKNOWLEDGED', reason: 'Earlier corridor' });
    safeStep(sim, 2);
    expect(root.lane).toBe(here.id);
    expect(sim.amb.lane).toBe(first.id);
    expect(sim.yieldCommands.get(root.id)?.reason).not.toContain('validated corridor egress');
  });

  it('leaves FIFO movement unchanged and needs no corridor exemption', () => {
    const { sim, root, first } = fixture('FIFO');
    safeStep(sim);
    expect(root.lane).toBe(first.id);
    expect(sim.yieldCommands.size).toBe(0);
  });

  it('regresses the exact Downtown t=22 blackout through t=2269', () => {
    const graph = loadRoadGraph(JSON.parse(readFileSync('public/data/downtown_roads.json', 'utf8')));
    const sim = createSim(graph, 20251220, 'DARKGRID');
    let crossedConnector = false;
    for (let t = 0; t < 2269; t += DT) {
      if (t === 22) injectEvent(sim, { type: 'OUTAGE', center: sim.plannedOutage.center, radiusM: 1394, restoreAfterS: sim.plannedOutage.restoreAfterS });
      const old = sim.agents[48].lane;
      safeStep(sim);
      if (old === 1795 && sim.agents[48].lane === 1880) crossedConnector = true;
    }
    expect(crossedConnector).toBe(true);
    expect(sim.arriveT).not.toBeNull();
    expect(sim.metrics.ambulanceTripS).toBeLessThan(2187);
    expect(getSnapshot(sim).ambulance?.status).toBe('ARRIVED');
  }, 60000);
});
