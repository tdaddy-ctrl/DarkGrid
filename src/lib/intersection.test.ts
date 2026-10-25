import { describe, expect, it } from 'vitest';
import { darkSignalCauses, fourWayStopTurn, fromRight, primaryCause, type Waiting } from './intersection';

const car = (id: number, arrivedT: number, headingDeg: number, token = false): Waiting => ({ id, arrivedT, headingDeg, token });

describe('fourWayStopTurn', () => {
  it('lets the first arrival go', () => {
    expect(fourWayStopTurn([car(2, 10, 0), car(1, 13, 90)]).go).toBe(2);
  });

  it('gives simultaneous arrivals to the vehicle with nobody on its right', () => {
    // 1 drives north; 2 drives west, i.e. it comes from 1's right. 2 has 1 on its left, so 2 goes.
    expect(fromRight(car(1, 0, 0), car(2, 0, 270))).toBe(true);
    expect(fourWayStopTurn([car(1, 10, 0), car(2, 10.5, 270)]).go).toBe(2);
  });

  it('reports a deadlock when every simultaneous vehicle has one on its right', () => {
    const turn = fourWayStopTurn([car(4, 10, 0), car(3, 10, 90), car(2, 10, 180), car(1, 10, 270)]);
    expect(turn.go).toBeNull();
    expect(turn.deadlock).toEqual([1, 2, 3, 4]);
  });

  it('lets an operator token break the order', () => {
    expect(fourWayStopTurn([car(4, 10, 0), car(3, 10, 90), car(2, 10, 180), car(1, 10, 270, true)]).go).toBe(1);
  });
});

describe('darkSignalCauses', () => {
  const base = { knowsOutage: false, unsureWithoutInfo: true, occluded: false, sightlineCleared: false };

  it('outage information removes only the outage-information cause', () => {
    expect(darkSignalCauses(base)).toEqual(['MISSING_OUTAGE_INFO']);
    expect(darkSignalCauses({ ...base, knowsOutage: true })).toEqual([]);
    expect(darkSignalCauses({ ...base, occluded: true })).toEqual(['MISSING_OUTAGE_INFO', 'SIGHTLINE_OCCLUDED']);
    expect(darkSignalCauses({ ...base, occluded: true, knowsOutage: true })).toEqual(['SIGHTLINE_OCCLUDED']);
  });

  it('a confident vehicle at a clear approach decides alone', () => {
    expect(darkSignalCauses({ ...base, unsureWithoutInfo: false })).toEqual([]);
  });

  it('primaryCause follows the documented order', () => {
    expect(primaryCause(['STUCK', 'SIGHTLINE_OCCLUDED', 'VEHICLE_FAULT'])).toBe('VEHICLE_FAULT');
    expect(primaryCause([])).toBeNull();
  });
});
