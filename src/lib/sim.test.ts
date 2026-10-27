// Determinism, safety and fairness checks for the simulator, on the real downtown street graph.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as C from './config';
import { loadRoadGraph } from './graph';
import { answerJob, createSim, injectEvent, pickCollisionEdge, revokeZonePolicy, setControl, step, type Features, type Sim } from './sim';

const graph = loadRoadGraph(JSON.parse(readFileSync('public/data/downtown_roads.json', 'utf8')));
const DT = 0.5;   // the sim's own substep
const NO_FEATURES: Features = { triage: false, batching: false, zonePolicy: false, corridor: false, staging: false, incidentBroadcast: false };

/** Everything that moves or decides, as one string. Excludes the mode label on purpose. */
function state(sim: Sim): string {
  return JSON.stringify({
    t: sim.t,
    agents: sim.agents.map(a => [a.place, a.lane, a.s, a.route.length, a.dest, a.requestId, a.held, a.lot, a.yieldStartT, a.fault]),
    amb: [sim.amb.place, sim.amb.lane, sim.amb.s, sim.arriveT],
    requests: [...sim.requests.values()].map(r => [r.id, r.cause, r.vehicleId, r.nodeId, r.createdAt]),
    incidents: sim.incidents.map(i => [i.id, i.status, i.clearAt]),
    jobs: sim.jobs.map(j => j.id),
  });
}

type Script = { outageAt: number; collisionAt: number; zoneAt: number | null; until: number };
const SCRIPT: Script = { outageAt: 30, collisionAt: 50, zoneAt: 35, until: 900 };

/** The page's manual scenario: same outage and collision for both cities, zone card approved by a human. */
function drive(sims: Sim[], script: Script, each?: (t: number) => void) {
  for (let t = 0; t < script.until; t += DT) {
    if (t === script.outageAt) {
      const plan = sims[0].plannedOutage;
      for (const s of sims) injectEvent(s, { type: 'OUTAGE', center: plan.center, radiusM: plan.radiusM, restoreAfterS: plan.restoreAfterS });
    }
    if (t === script.collisionAt) {
      const edgeId = pickCollisionEdge(sims[0]);
      if (edgeId !== undefined) for (const s of sims) injectEvent(s, { type: 'COLLISION', edgeId });
    }
    if (t === script.zoneAt) for (const s of sims) answerJob(s, 'job-zone-policy');
    for (const s of sims) step(s, DT);
    each?.(t);
  }
}

describe('determinism', () => {
  it('the same seed and the same events give the same run', () => {
    const a = createSim(graph, 11, 'DARKGRID'), b = createSim(graph, 11, 'DARKGRID');
    const states: [string, string][] = [];
    drive([a, b], SCRIPT, (t) => { if (t % 50 === 0) states.push([state(a), state(b)]); });
    for (const [x, y] of states) expect(x).toBe(y);
  });

  it('FIFO and DARK GRID are identical until the outage', () => {
    const f = createSim(graph, 12, 'FIFO'), d = createSim(graph, 12, 'DARKGRID');
    step(f, SCRIPT.outageAt); step(d, SCRIPT.outageAt);
    expect(state(d)).toBe(state(f));
  });
});

describe('fairness', () => {
  for (const seed of [21, 22]) {
    it(`DARK GRID with every feature off reproduces FIFO exactly (seed ${seed})`, () => {
      const f = createSim(graph, seed, 'FIFO'), d = createSim(graph, seed, 'DARKGRID', { features: NO_FEATURES });
      const mismatches: number[] = [];
      drive([f, d], SCRIPT, (t) => { if (t % 10 === 0 && state(f) !== state(d)) mismatches.push(t); });
      expect(mismatches).toEqual([]);
      expect(d.metrics.ambulanceTripS).toBe(f.metrics.ambulanceTripS);
    });
  }

  it('both modes get the same outage, collisions and fault schedule', () => {
    const f = createSim(graph, 23, 'FIFO'), d = createSim(graph, 23, 'DARKGRID');
    drive([f, d], { ...SCRIPT, until: 200 });
    expect(d.outage).toEqual(f.outage);
    expect(d.incidents.map(i => [i.edgeId, i.createdAt, i.clearanceS])).toEqual(f.incidents.map(i => [i.edgeId, i.createdAt, i.clearanceS]));
    expect(d.plannedFaults.map(p => [p.vehicleId, p.delayS, p.hard])).toEqual(f.plannedFaults.map(p => [p.vehicleId, p.delayS, p.hard]));
  });

  it('the simulator uses no unseeded randomness and never reads civilian traffic', () => {
    for (const file of ['src/lib/sim.ts', 'src/lib/intersection.ts']) {
      const code = readFileSync(file, 'utf8');
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/civilianTraffic/);
    }
  });
});

// Checks every substep. Returns readable violations instead of throwing, so one run reports them all.
function watchSafety(sim: Sim) {
  const problems: string[] = [];
  let prev = sim.agents.map(a => ({ place: a.place, lane: a.lane, s: a.s, held: a.held }));
  let prevAmb = { place: sim.amb.place, lane: sim.amb.lane };
  const lastEntry = new Map<number, number>();   // dark node -> last robotaxi entry time
  return {
    problems,
    check() {
      const t = sim.t;
      for (const lane of sim.lanes) {
        for (let i = 1; i < lane.cars.length; i++) {
          const gap = lane.cars[i - 1].s - lane.cars[i].s;
          if (gap < C.GAP_M - 1e-6) problems.push(`t=${t} lane ${lane.id}: gap ${gap.toFixed(2)} m`);
        }
      }
      sim.agents.forEach((a, i) => {
        const p = prev[i];
        if (p.place === 'ROAD' && a.place === 'ROAD') {
          if (a.lane === p.lane) {
            const ds = a.s - p.s;
            if (ds < -1e-6 || ds > C.CRUISE_MPS * DT + 1e-6) problems.push(`t=${t} car ${a.id}: moved ${ds.toFixed(2)} m in ${DT} s`);
            if (p.held && ds > 1e-6) problems.push(`t=${t} car ${a.id}: moved while held for an answer`);
          } else {
            const from = sim.lanes[p.lane], to = sim.lanes[a.lane];
            if (to.from !== from.to) problems.push(`t=${t} car ${a.id}: jumped from lane ${from.id} to unconnected lane ${to.id}`);
            // It may drive up to the stop line and cross in the same substep, but never from farther back.
            if (p.s + C.CRUISE_MPS * DT < from.len - 0.02) problems.push(`t=${t} car ${a.id}: left lane ${from.id} before its stop line`);
            if (a.s > 1e-6) problems.push(`t=${t} car ${a.id}: entered lane ${to.id} past its start`);
            // Restored power answers a dark-signal question by itself; anywhere still dark, held means held.
            if (p.held && sim.nodes.get(from.to)!.dark) problems.push(`t=${t} car ${a.id}: crossed a dark signal while held for an answer`);
            if (sim.incidents.some(x => x.edgeId === to.edgeId && x.status !== 'CLEARED')) problems.push(`t=${t} car ${a.id}: entered a closed road`);
            if (sim.corridorActive && sim.corridorEdges.has(to.edgeId)) problems.push(`t=${t} car ${a.id}: entered the reserved road`);
            const node = sim.nodes.get(from.to)!;
            if (node.dark) {
              const last = lastEntry.get(from.to);
              if (last !== undefined && t - last < C.DARK_HEADWAY_S - 1e-6) problems.push(`t=${t} node ${from.to}: two robotaxis within the four-way-stop headway`);
              lastEntry.set(from.to, t);
            }
          }
        }
        if ((p.place === 'ROAD') !== (a.place === 'ROAD') && (p.place === 'CURB' || a.place === 'CURB')) {
          if (a.lane !== p.lane || Math.abs(a.s - p.s) > 1e-6) problems.push(`t=${t} car ${a.id}: changed position while pulling over or rejoining`);
        }
      });
      for (const c of sim.yieldCommands.values()) {
        const v = sim.agents[c.vehicleId];
        const onReserved = sim.corridorActive && v.place === 'ROAD' && sim.corridorEdges.has(sim.lanes[v.lane].edgeId);
        if (c.kind === 'CLEAR' && c.state === 'CLEARED' && onReserved) problems.push(`t=${t} car ${v.id}: marked cleared while on the reserved road`);
      }
      const amb = sim.amb;
      if (amb.place === 'ROAD' && amb.lane !== prevAmb.lane && prevAmb.place === 'ROAD') {
        const to = sim.lanes[amb.lane];
        if (to.from !== sim.lanes[prevAmb.lane].to) problems.push(`t=${t} ambulance jumped lanes`);
        if (sim.incidents.some(x => x.edgeId === to.edgeId && x.status !== 'CLEARED')) problems.push(`t=${t} ambulance entered a closed road`);
      }
      if (sim.zone?.status === 'ACTIVE' && t > sim.zone.expiresAt + DT) problems.push(`t=${t} zone policy active after expiry`);
      prev = sim.agents.map(a => ({ place: a.place, lane: a.lane, s: a.s, held: a.held }));
      prevAmb = { place: amb.place, lane: amb.lane };
    },
  };
}

describe('safety', () => {
  for (const mode of ['FIFO', 'DARKGRID'] as const) {
    for (const seed of [31, 32, 33]) {
      it(`${mode} seed ${seed}: no gaps violated, no jumps, no closed or reserved roads entered`, () => {
        const sim = createSim(graph, seed, mode);
        const watch = watchSafety(sim);
        drive([sim], { ...SCRIPT, until: 1200 }, () => watch.check());
        expect(watch.problems.slice(0, 20)).toEqual([]);
      });
    }
  }
});

describe('zone policy', () => {
  it('automatic operators never approve it', () => {
    const sim = createSim(graph, 41, 'DARKGRID');
    drive([sim], { ...SCRIPT, zoneAt: null, until: 200 });   // before power returns
    expect(sim.zone).toBeNull();
    expect(sim.jobs[0]?.kind).toBe('ZONE_POLICY');
  });

  it('answers only outage-information requests; other causes stay with operators', () => {
    const sim = createSim(graph, 42, 'DARKGRID');
    setControl(sim, 'MANUAL');   // nobody else answers anything, so only the policy can remove requests
    drive([sim], { ...SCRIPT, zoneAt: null, until: 300 });
    const stays = new Map<string, number>(), info: string[] = [];   // request id -> node
    for (const r of sim.requests.values()) {
      if (r.cause === 'VEHICLE_FAULT' || r.cause === 'SIGHTLINE_OCCLUDED') stays.set(r.id, r.nodeId);
      if (r.cause === 'MISSING_OUTAGE_INFO') info.push(r.id);
    }
    expect(info.length).toBeGreaterThan(0);
    expect(stays.size).toBeGreaterThan(0);
    expect(answerJob(sim, 'job-zone-policy')).toBe(true);
    step(sim, C.REVIEW_LOCK_REAL_S * C.SIM_SPEED + DT);
    expect(sim.zone?.status).toBe('ACTIVE');
    // Still open, unless power came back at that intersection meanwhile (then the signal answers it).
    for (const [id, node] of stays) {
      if (sim.requests.get(id)?.cause === 'SIGHTLINE_OCCLUDED' && !sim.nodes.get(node)!.dark) continue;
      expect(sim.requests.has(id) || !sim.nodes.get(node)!.dark).toBe(true);
    }
    for (const r of sim.requests.values()) {
      if (r.cause === 'MISSING_OUTAGE_INFO') expect(sim.zone!.area.has(r.nodeId)).toBe(false);
    }
  });

  it('expires after its time limit and a renewal card follows; a revoke is final', () => {
    const sim = createSim(graph, 43, 'DARKGRID');
    drive([sim], { ...SCRIPT, until: SCRIPT.zoneAt! + C.ZONE_POLICY_TTL_S + 60 });
    // The outage may have ended first; then the policy ended with the power, not by time.
    expect(sim.zone?.status).not.toBe('ACTIVE');
    if (sim.zone?.endReason === 'EXPIRED' && [...sim.nodes.values()].some(n => n.dark)) {
      expect(sim.jobs[0]?.kind).toBe('ZONE_POLICY');
    }
    const other = createSim(graph, 43, 'DARKGRID');
    drive([other], { ...SCRIPT, until: 120 });
    expect(other.zone?.status).toBe('ACTIVE');
    expect(revokeZonePolicy(other)).toBe(true);
    expect(other.zone?.status).toBe('REVOKED');
    expect(other.policy.darkSignalsAsFourWayStop).toEqual([]);
    expect(other.jobs.some(j => j.kind === 'ZONE_POLICY')).toBe(false);
  });
});

describe('ambulance corridor', () => {
  it('messages only vehicles on or routed through the reserved road', () => {
    const sim = createSim(graph, 51, 'DARKGRID');
    let maxCommands = 0;
    drive([sim], { ...SCRIPT, until: 400 }, () => { maxCommands = Math.max(maxCommands, sim.yieldCommands.size); });
    expect(maxCommands).toBeGreaterThan(0);
    expect(maxCommands).toBeLessThan(C.VEHICLES / 2);
    for (const c of sim.yieldCommands.values()) expect(['CLEAR', 'REROUTE']).toContain(c.kind);
  });

  it('every unable vehicle is escalated to a real request', () => {
    const sim = createSim(graph, 52, 'DARKGRID');
    const problems: string[] = [];
    drive([sim], { ...SCRIPT, until: 600 }, (t) => {
      for (const c of sim.yieldCommands.values()) {
        if (c.state === 'ESCALATED' && !c.requestId) problems.push(`t=${t} car ${c.vehicleId}: escalated without a request`);
      }
    });
    expect(problems).toEqual([]);
  });
});


describe('operator jobs after request cancellation', () => {
  // Keep real scheduling and intersection rules, but isolate the request lifecycle from other traffic.
  function fixture(mode: 'FIFO' | 'DARKGRID', count = 1) {
    const sim = createSim(graph, 71, mode, { features: { corridor: false, staging: false, zonePolicy: false, incidentBroadcast: false } });
    for (const lane of sim.lanes) lane.cars = [];
    for (const a of sim.agents) { a.place = 'OFF'; a.requestId = null; a.held = false; }
    sim.plannedFaults = [];
    injectEvent(sim, { type: 'OUTAGE', center: graph.center, radiusM: 100000, restoreAfterS: 100000 });
    const node = [...sim.nodes.values()].find(n => n.in.length >= 2 && n.out.length > 0)!;
    const add = (index: number, sameNode = true) => {
      const lane = sameNode ? node.in[index] : sim.lanes.find(l => l.to !== node.node.id && sim.nodes.get(l.to)!.out.length > 0)!;
      const next = sim.nodes.get(lane.to)!.out[0];
      const a = sim.agents[index];
      a.place = 'ROAD'; a.lane = lane.id; a.s = lane.len; a.route = [next]; a.dest = next.to;
      a.held = true; a.known.clear(); a.grants.clear(); lane.occluded = false; lane.cars.push(a);
      const id = 'lifecycle-' + index;
      a.requestId = id;
      sim.requests.set(id, { id, vehicleId: a.id, nodeId: lane.to, cause: 'MISSING_OUTAGE_INFO', reason: 'DARK_SIGNAL_CONFIRM',
        createdAt: sim.t, onCorridor: false, insideBox: false, queuedBehind: 0, passenger: false, assigned: false });
      return id;
    };
    const ids = Array.from({ length: count }, (_, i) => add(i));
    const restore = () => {
      sim.outage!.restoreAt = sim.t + DT;
      sim.restoreTimes.set(node.node.id, sim.t + DT);
    };
    return { sim, ids, add, restore };
  }

  for (const mode of ['FIFO', 'DARKGRID'] as const) {
    it(mode + ': releases a canceled single job without applying its answer', () => {
      const { sim, ids, restore } = fixture(mode);
      step(sim, DT);
      const op = sim.operators.find(o => o.job?.requestIds.includes(ids[0]))!;
      const job = op.job!;
      const a = sim.agents[0];
      restore();
      step(sim, DT);
      expect(sim.requests.has(ids[0])).toBe(false);
      expect(sim.operators.some(o => o.job === job)).toBe(false);
      expect(op.job).toBeNull();
      expect(op.doneT).toBe(0);
      expect(a.requestId).toBeNull();
      expect(a.held).toBe(false);
      expect(a.known.has(sim.lanes[a.lane].from)).toBe(false);
      expect(sim.answered).toBe(0);
      expect(sim.jobs.some(j => j.requestIds.includes(ids[0]))).toBe(false);
    });

    it(mode + ': reuses the released operator for another valid request in the same tick', () => {
      const { sim, ids, add, restore } = fixture(mode);
      step(sim, DT);
      const op = sim.operators.find(o => o.job?.requestIds.includes(ids[0]))!;
      const next = add(1, false);
      restore();
      step(sim, DT);
      expect(op.job?.requestIds).toEqual([next]);
      expect(sim.requests.get(next)?.assigned).toBe(true);
      expect(op.doneT).toBe(sim.t + C.SERVICE_SINGLE_S);
    });

    it(mode + ': keeps the normal single-job deadline at 30 simulation seconds', () => {
      const { sim, ids } = fixture(mode);
      step(sim, DT);
      const op = sim.operators.find(o => o.job?.requestIds.includes(ids[0]))!;
      const job = op.job!;
      expect(op.doneT - sim.t).toBe(30);
      step(sim, C.SERVICE_SINGLE_S - DT);
      expect(op.job).toBe(job);
      expect(sim.requests.has(ids[0])).toBe(true);
      step(sim, DT);
      expect(sim.requests.has(ids[0])).toBe(false);
      expect(sim.agents[0].known.size).toBe(1);
    });

    it(mode + ': releases a replaced request without answering the new fault early', () => {
      const { sim, ids } = fixture(mode);
      step(sim, DT);
      const op = sim.operators.find(o => o.job?.requestIds.includes(ids[0]))!;
      const oldJob = op.job!;
      sim.plannedFaults.push({ vehicleId: 0, delayS: sim.t + DT, hard: false, fired: false });
      step(sim, DT);
      const replacement = sim.agents[0].requestId!;
      expect(replacement).not.toBe(ids[0]);
      expect(sim.requests.has(ids[0])).toBe(false);
      expect(sim.operators.some(o => o.job === oldJob)).toBe(false);
      expect(op.job?.requestIds).toEqual([replacement]);
      expect(sim.requests.get(replacement)?.cause).toBe('VEHICLE_FAULT');
      expect(sim.agents[0].fault).not.toBeNull();
      expect(sim.agents[0].held).toBe(true);
      step(sim, C.SERVICE_SINGLE_S - DT);
      expect(sim.agents[0].fault).not.toBeNull();
      step(sim, DT);
      expect(sim.agents[0].fault).toBeNull();
    });
  }

  it('keeps a partial batch and its original 45-second deadline', () => {
    const { sim, ids } = fixture('DARKGRID', 2);
    step(sim, DT);
    const op = sim.operators.find(o => o.job?.kind === 'BATCH')!;
    const job = op.job!, deadline = op.doneT;
    expect(deadline - sim.t).toBe(45);
    // Simulate one member receiving independent outage information: the other still needs review.
    sim.requests.delete(ids[0]); sim.agents[0].requestId = null; sim.agents[0].held = false;
    sim.agents[0].known.add(sim.lanes[sim.agents[0].lane].to);
    step(sim, DT);
    expect(op.job).toBe(job);
    expect(op.doneT).toBe(deadline);
    expect(sim.requests.get(ids[1])?.assigned).toBe(true);
    expect(sim.operators.filter(o => o.job?.requestIds.includes(ids[1]))).toHaveLength(1);
    step(sim, deadline - sim.t - DT);
    expect(sim.requests.has(ids[1])).toBe(true);
    step(sim, DT);
    expect(sim.requests.has(ids[1])).toBe(false);
    expect(sim.agents[1].known.size).toBe(1);
  });

  it('releases a batch when restoration cancels all members', () => {
    const { sim, ids, restore } = fixture('DARKGRID', 2);
    step(sim, DT);
    const op = sim.operators.find(o => o.job?.kind === 'BATCH')!;
    restore(); step(sim, DT);
    expect(ids.every(id => !sim.requests.has(id))).toBe(true);
    expect(op.job).toBeNull();
    expect(op.doneT).toBe(0);
    expect(sim.agents.slice(0, 2).every(a => a.known.size === 0)).toBe(true);
  });

  it('preserves independent collision recovery with no request members', () => {
    const { sim } = fixture('FIFO', 0);
    injectEvent(sim, { type: 'COLLISION', edgeId: graph.edges[0].id });
    step(sim, DT);
    const op = sim.operators.find(o => o.job?.kind === 'COLLISION')!;
    const job = op.job!;
    expect(job.requestIds).toEqual([]);
    step(sim, C.SERVICE_SINGLE_S - DT);
    expect(op.job).toBe(job);
    expect(sim.incidents[0].status).toBe('BLOCKED');
    step(sim, DT);
    expect(sim.incidents[0].status).toBe('RESPONDING');
  });

  it('preserves human zone-policy review with no request members', () => {
    const { sim } = fixture('DARKGRID', 0);
    sim.features.zonePolicy = true;
    step(sim, DT);
    expect(answerJob(sim, 'job-zone-policy')).toBe(true);
    expect(sim.review!.job.requestIds).toEqual([]);
    step(sim, C.SERVICE_SINGLE_S - DT);
    expect(sim.review).not.toBeNull();
    expect(sim.zone).toBeNull();
    step(sim, DT);
    expect(sim.zone?.status).toBe('ACTIVE');
    expect(sim.answered).toBe(1);
  });
});
