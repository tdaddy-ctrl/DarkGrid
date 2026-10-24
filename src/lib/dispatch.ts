import type { HelpRequest, Job, Policy } from '../types/sim';
import { SERVICE_BATCH_S, SERVICE_SINGLE_S } from './config';

/** Values are weighted contributions, including zero terms for a consistent UI. */
export function triageWeight(
  request: HelpRequest,
  weights: Policy['triageWeights'],
): { w: number; breakdown: Job['breakdown'] } {
  const breakdown = [
    { label: 'on corridor', value: request.onCorridor ? weights.onCorridor : 0 },
    { label: 'inside box', value: request.insideBox ? weights.insideBox : 0 },
    { label: 'queued behind', value: request.queuedBehind * weights.perQueuedBehind },
    { label: 'passenger', value: request.passenger ? weights.passenger : 0 },
  ];
  return { w: breakdown.reduce((sum, term) => sum + term.value, 0), breakdown };
}

// Explicit code-unit comparison avoids locale-dependent ordering.
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compareRequests = (a: HelpRequest, b: HelpRequest) => a.createdAt - b.createdAt || compareIds(a.id, b.id);

function makeJob(members: HelpRequest[], policy: Policy): Job {
  const first = members[0];
  const weights = members.map(request => triageWeight(request, policy.triageWeights));
  const batch = members.length > 1;
  const kind: Job['kind'] = policy.dispatch === 'FIFO' ? 'FIFO'
    : batch ? 'BATCH' : first.reason === 'STUCK' ? 'STUCK' : first.onCorridor ? 'CORRIDOR' : 'SINGLE';
  // JSON encoding prevents delimiter collisions; sorted membership ignores arrival/input order.
  // IDs deliberately exclude mode, dynamic weights, queue lengths and counters.
  const id = `job-${JSON.stringify(members.map(r => r.id).sort(compareIds))}`;
  return {
    id, kind,
    requestIds: members.map(r => r.id), vehicleIds: members.map(r => r.vehicleId),
    w: weights.reduce((sum, result) => sum + result.w, 0),
    p: batch ? SERVICE_BATCH_S : SERVICE_SINGLE_S,
    createdAt: first.createdAt,
    title: batch ? `Confirm ${members.length} dark-signal requests`
      : first.reason === 'STUCK' ? `Stuck vehicle #${first.vehicleId}` : `Dark signal confirm #${first.vehicleId}`,
    sub: `node ${first.nodeId} · ${members.length} request${batch ? 's' : ''}`,
    breakdown: weights[0].breakdown.map((term, index) => ({
      label: term.label,
      value: weights.reduce((sum, result) => sum + result.breakdown[index].value, 0),
    })),
  };
}

/** Pure dispatch calculation. ZONE_POLICY remains the simulator's responsibility.
 * Compatible requests are partitioned oldest-first into chunks of batchMax.
 * Equal priorities use earliest member creation time, then canonical job ID.
 */
export function orderJobs(requests: HelpRequest[], policy: Policy): Job[] {
  if (!Number.isSafeInteger(policy.batchMax) || policy.batchMax < 1) {
    throw new RangeError('batchMax must be a positive safe integer');
  }
  if (new Set(requests.map(r => r.id)).size !== requests.length) {
    throw new Error('Request IDs must be unique');
  }
  const sorted = [...requests].sort(compareRequests);
  if (policy.dispatch === 'FIFO') return sorted.map(request => makeJob([request], policy));

  const jobs: Job[] = [];
  const byNode = new Map<number, HelpRequest[]>();
  for (const request of sorted) {
    if (request.reason === 'STUCK') {
      jobs.push(makeJob([request], policy));
    } else {
      const group = byNode.get(request.nodeId);
      if (group) group.push(request);
      else byNode.set(request.nodeId, [request]);
    }
  }
  for (const group of byNode.values()) {
    for (let start = 0; start < group.length; start += policy.batchMax) {
      jobs.push(makeJob(group.slice(start, start + policy.batchMax), policy));
    }
  }
  return jobs.sort((a, b) => b.w / b.p - a.w / a.p
    || a.createdAt - b.createdAt || compareIds(a.id, b.id));
}
