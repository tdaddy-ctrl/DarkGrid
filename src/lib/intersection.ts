// Intersection rules every robotaxi follows, in FIFO and DARK GRID alike. Pure functions: no mode,
// no randomness, no simulator state. The sim gathers the inputs; these decide.

import type { HelpCause } from '@/types/sim';
import { ARRIVAL_TIE_S } from './config';

/** Which cause wins when a vehicle has several: the first one in this list. */
export const CAUSE_ORDER: readonly HelpCause[] = [
  'VEHICLE_FAULT', 'INCIDENT', 'CORRIDOR_BLOCKED', 'EXIT_BLOCKED',
  'MISSING_OUTAGE_INFO', 'SIGHTLINE_OCCLUDED', 'PRIORITY_AMBIGUOUS', 'STUCK',
];

export function primaryCause(causes: Iterable<HelpCause>): HelpCause | null {
  const set = new Set(causes);
  return CAUSE_ORDER.find((c) => set.has(c)) ?? null;
}

/** What a vehicle at the stop line of a dark intersection knows about it. */
export type DarkApproach = {
  knowsOutage: boolean;        // its own confirmed information, or an active zone policy covering the node
  unsureWithoutInfo: boolean;  // this vehicle cannot tell an outage from a fault here without that information
  occluded: boolean;           // this approach cannot see cross traffic
  sightlineCleared: boolean;   // an operator confirmed the crossing for this visit
};

/** Causes that stop the vehicle from treating the dark signal as a four-way stop on its own. */
export function darkSignalCauses(v: DarkApproach): HelpCause[] {
  const causes: HelpCause[] = [];
  if (v.unsureWithoutInfo && !v.knowsOutage) causes.push('MISSING_OUTAGE_INFO');
  if (v.occluded && !v.sightlineCleared) causes.push('SIGHTLINE_OCCLUDED');
  return causes;
}

/** A vehicle waiting at a four-way stop line, ready to go apart from right of way. */
export type Waiting = { id: number; arrivedT: number; headingDeg: number; token: boolean };

/** True when `b` approaches from `a`'s right (it travels about 90 degrees counterclockwise of `a`). */
export function fromRight(a: Waiting, b: Waiting): boolean {
  const d = (((b.headingDeg - a.headingDeg) % 360) + 360) % 360;
  return d > 225 && d < 315;
}

/**
 * Four-way stop: first to arrive goes first. Arrivals within ARRIVAL_TIE_S are simultaneous; then the
 * vehicle with nobody on its right goes. If every simultaneous vehicle has one on its right, nobody can
 * decide by the rules: a deadlock. An operator's priority token overrides the order (not safety checks).
 */
export function fourWayStopTurn(waiting: Waiting[]): { go: number | null; deadlock: number[] } {
  if (!waiting.length) return { go: null, deadlock: [] };
  const byOrder = (p: Waiting, q: Waiting) => p.arrivedT - q.arrivedT || p.id - q.id;
  const tokens = waiting.filter((w) => w.token).sort(byOrder);
  if (tokens.length) return { go: tokens[0].id, deadlock: [] };
  const first = Math.min(...waiting.map((w) => w.arrivedT));
  const tied = waiting.filter((w) => w.arrivedT <= first + ARRIVAL_TIE_S).sort(byOrder);
  if (tied.length === 1) return { go: tied[0].id, deadlock: [] };
  const free = tied.filter((a) => !tied.some((b) => b !== a && fromRight(a, b)));
  if (free.length) return { go: free[0].id, deadlock: [] };
  return { go: null, deadlock: tied.map((w) => w.id) };
}
