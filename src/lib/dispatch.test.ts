import { describe, expect, it } from 'vitest';
import type { HelpRequest, Policy } from '../types/sim';
import { DEFAULT_WEIGHTS } from './config';
import { orderJobs, triageWeight } from './dispatch';

const policy = (batchMax = 40, dispatch: Policy['dispatch'] = 'WSPT_TRIAGE'): Policy => ({
  dispatch, batchMax, darkSignalsAsFourWayStop: [], triageWeights: { ...DEFAULT_WEIGHTS },
});
const request = (id: string, fields: Partial<HelpRequest> = {}): HelpRequest => ({
  id, vehicleId: Number(id.replace(/\D/g, '')) || 0, nodeId: 1, reason: 'DARK_SIGNAL_CONFIRM',
  createdAt: 0, onCorridor: false, insideBox: false, queuedBehind: 0, passenger: false, ...fields,
});
const scenario = (): HelpRequest[] => [
  request('R1', { onCorridor: true, insideBox: true, queuedBehind: 1, passenger: true, createdAt: 1 }),
  ...[2, 3, 4].map(i => request(`R${i}`, { nodeId: 7, queuedBehind: 2, createdAt: i })),
  request('R5', { reason: 'STUCK', queuedBehind: 3, createdAt: 5 }),
];

describe('triageWeight', () => {
  it('returns the exact R1 weight and weighted breakdown', () => {
    expect(triageWeight(scenario()[0], DEFAULT_WEIGHTS)).toEqual({ w: 14.5, breakdown: [
      { label: 'on corridor', value: 10 }, { label: 'inside box', value: 3 },
      { label: 'queued behind', value: 1 }, { label: 'passenger', value: 0.5 },
    ] });
    expect(scenario().map(r => triageWeight(r, DEFAULT_WEIGHTS).w)).toEqual([14.5, 2, 2, 2, 3]);
  });
  it('uses supplied policy weights and returns zero for no factors', () => {
    expect(triageWeight(request('x'), DEFAULT_WEIGHTS).w).toBe(0);
    expect(triageWeight(scenario()[0], { onCorridor: 2, insideBox: 4, perQueuedBehind: 3, passenger: 1 }).w).toBe(10);
  });
});

describe('original brief scenario', () => {
  it('WSPT batchMax=40: R1, batch(R2,R3,R4), R5', () => {
    const jobs = orderJobs(scenario(), policy());
    expect(jobs.map(j => j.requestIds)).toEqual([['R1'], ['R2', 'R3', 'R4'], ['R5']]);
    expect(jobs.map(j => j.w)).toEqual([14.5, 6, 3]);
    expect(jobs.map(j => j.p)).toEqual([30, 45, 30]);
    expect(jobs.map(j => j.kind)).toEqual(['CORRIDOR', 'BATCH', 'STUCK']);
    expect(jobs.map(j => j.createdAt)).toEqual([1, 2, 5]);
    expect(jobs[1].vehicleIds).toEqual([2, 3, 4]);
    expect(jobs[1].breakdown.reduce((sum, b) => sum + b.value, 0)).toBe(6);
  });
  it('WSPT batchMax=1: R1, R5, R2, R3, R4', () => {
    const jobs = orderJobs(scenario(), policy(1));
    expect(jobs.map(j => j.requestIds)).toEqual([['R1'], ['R5'], ['R2'], ['R3'], ['R4']]);
    expect(jobs.every(j => j.p === 30)).toBe(true);
  });
  it('FIFO: R1, R2, R3, R4, R5, regardless of input order or weight', () => {
    const jobs = orderJobs(scenario().reverse(), policy(40, 'FIFO'));
    expect(jobs.map(j => j.requestIds)).toEqual([['R1'], ['R2'], ['R3'], ['R4'], ['R5']]);
    expect(jobs.every(j => j.kind === 'FIFO' && j.p === 30)).toBe(true);
  });
});

describe('batching and priorities', () => {
  it('never batches different nodes or STUCK, including two STUCK at one node', () => {
    const requests = [request('a'), request('b', { nodeId: 2 }),
      request('c', { reason: 'STUCK' }), request('d', { reason: 'STUCK' })];
    expect(orderJobs(requests, policy()).every(j => j.requestIds.length === 1)).toBe(true);
  });
  it('batches compatible requests despite different triage flags', () => {
    const jobs = orderJobs([request('a'), request('b', { onCorridor: true, insideBox: true })], policy());
    expect(jobs).toHaveLength(1); expect(jobs[0].w).toBe(13); expect(jobs[0].p).toBe(45);
  });
  it('chunks oldest-first at batchMax and charges 30 seconds for a leftover singleton', () => {
    const requests = Array.from({ length: 5 }, (_, i) => request(`r${i}`, { createdAt: i, queuedBehind: 1 }));
    const jobs = orderJobs(requests.reverse(), policy(2));
    expect(jobs.map(j => j.requestIds)).toEqual([['r0', 'r1'], ['r2', 'r3'], ['r4']]);
    expect(jobs.map(j => j.p)).toEqual([45, 45, 30]);
  });
  it('ranks by weight/time rather than raw weight', () => {
    const jobs = orderJobs([request('a', { queuedBehind: 2 }), request('b', { queuedBehind: 2 }),
      request('c', { reason: 'STUCK', queuedBehind: 3 })], policy());
    expect(jobs.map(j => j.requestIds)).toEqual([['c'], ['a', 'b']]);
  });
  it('breaks equal ratios by creation time then stable ID', () => {
    const requests = [request('b', { reason: 'STUCK', queuedBehind: 1 }),
      request('a', { reason: 'STUCK', queuedBehind: 1 }),
      request('z', { reason: 'STUCK', queuedBehind: 1, createdAt: -1 })];
    for (const dispatch of ['FIFO', 'WSPT_TRIAGE'] as const) {
      expect(orderJobs(requests, policy(1, dispatch)).map(j => j.requestIds[0])).toEqual(['z', 'a', 'b']);
    }
  });
  it('handles empty queues in both modes and never creates ZONE_POLICY', () => {
    for (const dispatch of ['FIFO', 'WSPT_TRIAGE'] as const) {
      expect(orderJobs([], policy(40, dispatch))).toEqual([]);
      expect(orderJobs(scenario(), policy(40, dispatch)).some(j => j.kind === 'ZONE_POLICY')).toBe(false);
    }
  });
});

describe('purity and stable identities', () => {
  it('repeats deterministically across input permutations and batch boundaries', () => {
    const requests = scenario(), before = structuredClone(requests), p = policy(2);
    const expected = orderJobs(requests, p);
    for (let i = 0; i < requests.length; i++) {
      expect(orderJobs([...requests.slice(i), ...requests.slice(0, i)], p)).toEqual(expected);
    }
    expect(orderJobs([...requests].reverse(), p)).toEqual(expected);
    expect(requests).toEqual(before); expect(p).toEqual(policy(2));
  });
  it('keeps group IDs stable when weights or timestamps change without changing membership', () => {
    const initial = orderJobs(scenario(), policy());
    const changed = orderJobs(scenario().map(r => ({ ...r, queuedBehind: 10, createdAt: r.createdAt + 100 })), policy());
    const ids = (jobs: ReturnType<typeof orderJobs>) => jobs.map(j => j.id).sort();
    expect(ids(initial)).toEqual(ids(changed));
    expect(new Set(initial.map(j => j.id)).size).toBe(initial.length);
  });
  it('avoids delimiter collisions and reflects changed group membership', () => {
    const a = orderJobs([request('a,b'), request('c')], policy())[0].id;
    const b = orderJobs([request('a'), request('b,c')], policy())[0].id;
    expect(a).not.toBe(b);
    expect(orderJobs([request('a,b')], policy())[0].id).not.toBe(a);
  });
  it('does not return mutable references to requests or policy', () => {
    const requests = scenario(), p = policy(), before = structuredClone(requests);
    requests.forEach(Object.freeze); Object.freeze(requests); Object.freeze(p.triageWeights); Object.freeze(p);
    const jobs = orderJobs(requests, p);
    jobs[0].requestIds.push('extra'); jobs[0].breakdown[0].value = 999;
    expect(requests).toEqual(before);
    expect(orderJobs(requests, p)[0].w).toBe(14.5);
  });
  it('rejects invalid batchMax and duplicate request identities', () => {
    for (const limit of [0, -1, 1.5, Infinity, NaN]) expect(() => orderJobs([], policy(limit))).toThrow();
    expect(() => orderJobs([request('same'), request('same')], policy())).toThrow();
  });
});
