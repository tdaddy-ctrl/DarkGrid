import { describe, expect, it } from 'vitest';
import type { FrameLite, HistoryFrame } from '../types/sim';
import { HISTORY_EVERY_S } from './config';
import { createHistory, frameAt, push, range } from './history';

function lite(t: number): FrameLite {
  return {
    t,
    vehicles: [{ id: 1, pos: { lat: 37.77, lng: -122.408 }, headingDeg: 0, state: 'DRIVING', type: 'EMPTY' }],
    ambulance: { pos: { lat: 37.77, lng: -122.408 }, headingDeg: 0, status: 'EN_ROUTE', tripS: t },
    corridor: [{ lat: 37.77, lng: -122.408 }],
    lots: [{ pos: { lat: 37.77, lng: -122.408 }, used: 0, cap: 25 }],
    metrics: { requests: 1, jobs: 1, lambdaPerMin: 1, rho: 0.1, blockingVehMin: 0, stuck: 0, darkCount: 1, ambulanceTripS: null },
    jobs: [{ id: 'job-1', kind: 'SINGLE', requestIds: ['r1'], vehicleIds: [1], w: 1, p: 30,
      createdAt: t, title: 'Confirm', sub: 'node 1', breakdown: [{ label: 'passenger', value: 1 }] }],
  };
}

const frame = (t: number): HistoryFrame => ({ t, fifo: lite(t), darkgrid: lite(t) });

describe('simulation history', () => {
  it('returns null for an empty history', () => {
    const h = createHistory();
    expect(range(h)).toBeNull();
    expect(frameAt(h, 0)).toBeNull();
    expect(frameAt(h, Infinity)).toBeNull();
  });

  it('finds the greatest timestamp <= the query in the required sequence', () => {
    const h = createHistory();
    for (const t of [0, 2, 4, 6, 8, 10]) push(h, frame(t));
    expect(frameAt(h, 5)?.t).toBe(4);
    expect(frameAt(h, -1)).toBeNull();
    expect(frameAt(h, 100)?.t).toBe(10);
    expect(range(h)).toEqual({ start: 0, end: 10 });
  });

  it('finds every exact timestamp, including first and last', () => {
    const h = createHistory();
    for (const t of [0, 2, 4, 6, 8, 10]) push(h, frame(t));
    for (const t of [0, 2, 4, 6, 8, 10]) expect(frameAt(h, t)).toEqual(frame(t));
  });

  it('retains only 6, 8, 10 with maxFrames=3', () => {
    const h = createHistory(3);
    for (const t of [0, 2, 4, 6, 8, 10]) push(h, frame(t));
    expect(range(h)).toEqual({ start: 6, end: 10 });
    expect(frameAt(h, 5)).toBeNull();
    for (const t of [6, 8, 10]) expect(frameAt(h, t)?.t).toBe(t);
  });

  it('evicts only after capacity is exceeded', () => {
    const h = createHistory(3);
    push(h, frame(0)); push(h, frame(2)); push(h, frame(4));
    expect(range(h)).toEqual({ start: 0, end: 4 });
    push(h, frame(6));
    expect(range(h)).toEqual({ start: 2, end: 6 });
    expect(frameAt(h, 0)).toBeNull();
  });

  it('supports capacity one', () => {
    const h = createHistory(1);
    push(h, frame(0)); push(h, frame(4));
    expect(range(h)).toEqual({ start: 4, end: 4 });
    expect(frameAt(h, 3)).toBeNull();
    expect(frameAt(h, 4)).toEqual(frame(4));
  });

  it('defaults to 450 frames at the configured four-second interval', () => {
    const h = createHistory();
    expect(HISTORY_EVERY_S).toBe(4);
    for (let i = 0; i < 450; i++) push(h, frame(i * HISTORY_EVERY_S));
    expect(range(h)).toEqual({ start: 0, end: 1796 });
    push(h, frame(1800));
    expect(range(h)).toEqual({ start: 4, end: 1800 });
    expect(frameAt(h, 0)).toBeNull();
  });

  it('handles out-of-order timestamps deterministically and evicts the earliest', () => {
    for (const times of [[10, 0, 8, 4, 6, 2], [0, 2, 4, 6, 8, 10]]) {
      const h = createHistory(3);
      for (const t of times) push(h, frame(t));
      expect(range(h)).toEqual({ start: 6, end: 10 });
      expect(frameAt(h, 7)).toEqual(frame(6));
    }
  });

  it('replaces a duplicate timestamp without evicting another frame', () => {
    const h = createHistory(2), replacement = frame(4);
    push(h, frame(0)); push(h, frame(4));
    replacement.darkgrid.metrics.requests = 99;
    push(h, replacement);
    expect(range(h)).toEqual({ start: 0, end: 4 });
    expect(frameAt(h, 4)).toEqual(replacement);
  });

  it('does not mutate input snapshots and isolates later input changes', () => {
    const h = createHistory(), input = frame(4), before = structuredClone(input);
    push(h, input); frameAt(h, 4); range(h);
    expect(input).toEqual(before);
    input.fifo.vehicles[0].pos.lat = 0;
    input.darkgrid.jobs[0].requestIds.push('later');
    input.darkgrid.metrics.requests = 999;
    input.t = 100;
    expect(frameAt(h, 4)).toEqual(before);
    expect(range(h)).toEqual({ start: 4, end: 4 });
  });

  it('isolates nested lookup results and range objects from stored history', () => {
    const h = createHistory(), expected = frame(4);
    push(h, expected);
    const found = frameAt(h, 4)!;
    found.fifo.ambulance!.pos.lat = 0;
    found.darkgrid.lots[0].used = 25;
    found.fifo.corridor[0].lng = 0;
    found.darkgrid.jobs[0].breakdown[0].value = 999;
    range(h)!.start = -100;
    expect(frameAt(h, 4)).toEqual(expected);
    expect(range(h)).toEqual({ start: 4, end: 4 });
  });

  it('rejects invalid capacities', () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createHistory(n)).toThrow(RangeError);
    }
  });

  it('rejects nonfinite recorded times without changing history', () => {
    const h = createHistory(1);
    push(h, frame(4));
    for (const t of [NaN, Infinity, -Infinity]) expect(() => push(h, frame(t))).toThrow(RangeError);
    expect(frameAt(h, 4)).toEqual(frame(4));
    expect(() => frameAt(h, NaN)).toThrow(RangeError);
    expect(frameAt(h, -Infinity)).toBeNull();
    expect(frameAt(h, Infinity)).toEqual(frame(4));
  });
});
