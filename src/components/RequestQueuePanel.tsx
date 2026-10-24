'use client';

import { useMemo } from 'react';
import type { Job, SimSnapshot } from '@/types/sim';

// -----------------------------------------------------------------------------
// Constants (match the design tokens in the brief)
// -----------------------------------------------------------------------------

const CYAN = '#22d3ee';
const RED = '#f87171';
const AMBER = '#fbbf24';
const ORANGE = '#fb923c';
const LABEL = '#a9b6cc';

// Bar fills out of 6.5 (rho = 6.5 -> full bar). Marker sits at rho = 1.
const RHO_FULL_SCALE = 6.5;

// Kind -> pill styling. Order matters only for readability.
const KIND_STYLE: Record<Job['kind'], { fg: string; bg: string; border: string }> = {
  BATCH: { fg: CYAN, bg: 'rgba(34,211,238,0.12)', border: 'rgba(34,211,238,0.35)' },
  CORRIDOR: { fg: AMBER, bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.35)' },
  STUCK: { fg: ORANGE, bg: 'rgba(251,146,60,0.12)', border: 'rgba(251,146,60,0.35)' },
  SINGLE: { fg: '#cbd5e1', bg: 'rgba(203,213,225,0.10)', border: 'rgba(203,213,225,0.25)' },
  FIFO: { fg: '#cbd5e1', bg: 'rgba(203,213,225,0.10)', border: 'rgba(203,213,225,0.25)' },
};

// -----------------------------------------------------------------------------
// Small building blocks
// -----------------------------------------------------------------------------

function Badge({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-1.5">
      <span
        className="font-mono text-[11px] uppercase tracking-[0.14em]"
        style={{ color: LABEL }}
      >
        {label}
      </span>
      <span
        className="font-mono text-sm font-semibold tabular-nums"
        style={{ color: accent ?? '#e2e8f0' }}
      >
        {value}
      </span>
    </div>
  );
}

function KindPill({ kind }: { kind: Job['kind'] }) {
  const s = KIND_STYLE[kind];
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-[0.16em] rounded-md px-1.5 py-0.5"
      style={{ color: s.fg, background: s.bg, border: `1px solid ${s.border}` }}
    >
      {kind}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Utilization gauge
// -----------------------------------------------------------------------------

function UtilizationGauge({ rho }: { rho: number }) {
  const clamped = Math.max(0, Math.min(rho / RHO_FULL_SCALE, 1));
  const markerLeft = Math.min(1 / RHO_FULL_SCALE, 1) * 100; // rho = 1 position, in %
  // color shifts cyan -> amber -> red as we approach/pass rho = 1
  const color = rho >= 1 ? RED : rho >= 0.85 ? AMBER : CYAN;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <span
          className="font-mono text-[11px] uppercase tracking-[0.14em]"
          style={{ color: LABEL }}
        >
          Operator utilization · ρ
        </span>
        <span
          className="font-mono text-lg font-semibold tabular-nums"
          style={{ color }}
        >
          {rho.toFixed(2)}
        </span>
      </div>

      <div className="relative mt-2 h-2 w-full rounded-full bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500"
          style={{ width: `${clamped * 100}%`, backgroundColor: color }}
        />
      </div>

      {/* white marker at rho = 1 */}
      <div className="relative h-0">
        <div
          className="absolute -top-[10px] h-4 w-[2px] bg-white/80"
          style={{ left: `calc(${markerLeft}% - 1px)` }}
        />
      </div>

      <div className="mt-2 flex justify-between">
        <span className="font-mono text-[10px] tracking-[0.12em]" style={{ color: LABEL }}>
          0
        </span>
        <span className="font-mono text-[10px] tracking-[0.12em]" style={{ color: LABEL }}>
          ρ=1
        </span>
        <span className="font-mono text-[10px] tracking-[0.12em]" style={{ color: LABEL }}>
          {RHO_FULL_SCALE}
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Operator chips
// -----------------------------------------------------------------------------

function OperatorChips({ operators }: { operators: SimSnapshot['operators'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {operators.map((op) => {
        const idle = op.task === 'idle';
        return (
          <div
            key={op.id}
            className="font-mono text-[10px] uppercase tracking-[0.12em] rounded-md border px-2 py-1"
            style={{
              color: idle ? LABEL : CYAN,
              borderColor: idle ? 'rgba(255,255,255,0.10)' : 'rgba(34,211,238,0.35)',
              background: idle ? 'transparent' : 'rgba(34,211,238,0.08)',
            }}
          >
            {op.id}
            <span className="ml-1 opacity-70">· {op.task}</span>
          </div>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Job card
// -----------------------------------------------------------------------------

type JobCardProps = {
  job: Job;
  rank: number;
  reviewing: boolean;
  lockRemainingS: number;
  disabled: boolean;
  onAnswer?: (id: string) => void;
};

function JobCard({ job, rank, reviewing, lockRemainingS, disabled, onAnswer }: JobCardProps) {
  const clickable = !!onAnswer && !disabled && !reviewing;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[11px] tabular-nums"
            style={{ color: LABEL }}
          >
            {String(rank).padStart(2, '0')}
          </span>
          <KindPill kind={job.kind} />
        </div>
        <div className="font-mono text-[11px] tabular-nums" style={{ color: LABEL }}>
          w {job.w.toFixed(1)}
          <span className="mx-1 opacity-60">/</span>
          p {job.p.toFixed(1)}
        </div>
      </div>

      <div className="mt-1.5 text-[13px] font-medium leading-snug text-slate-100">
        {job.title}
      </div>
      <div className="text-[12px] leading-snug" style={{ color: LABEL }}>
        {job.sub}
      </div>

      {reviewing && (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.14em]"
              style={{ color: AMBER }}
            >
              REVIEWING
            </span>
            <span className="font-mono text-[10px] tabular-nums" style={{ color: AMBER }}>
              {Math.max(0, Math.ceil(lockRemainingS))}s
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${Math.min(100, Math.max(0, (lockRemainingS / 6) * 100))}%`,
                backgroundColor: AMBER,
              }}
            />
          </div>
        </div>
      )}

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {job.breakdown.map((b) => (
          <div
            key={b.label}
            className="rounded-md border border-white/5 bg-white/[0.02] px-1.5 py-1"
          >
            <div
              className="font-mono text-[9px] uppercase tracking-[0.10em]"
              style={{ color: LABEL }}
            >
              {b.label}
            </div>
            <div className="font-mono text-[12px] tabular-nums text-slate-200">
              {b.value}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  const base =
    'rounded-xl border p-3 transition-all duration-300 ' +
    (reviewing
      ? 'border-amber-400/40 bg-amber-400/5'
      : 'border-white/10 bg-slate-900/60 hover:border-white/20');

  if (!clickable) {
    return <div className={base + (disabled && !reviewing ? ' opacity-50' : '')}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onAnswer?.(job.id)}
      className={base + ' text-left w-full cursor-pointer'}
    >
      {body}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

export type RequestQueuePanelProps = {
  snapshot: SimSnapshot;
  onAnswer?: (jobId: string) => void;
};

export default function RequestQueuePanel({ snapshot, onAnswer }: RequestQueuePanelProps) {
  const { metrics, jobs, operators, policy, control, manual } = snapshot;

  // Stable rank map — rank by position in the already-sorted jobs array.
  const ranks = useMemo(() => {
    const m = new Map<string, number>();
    jobs.forEach((j, i) => m.set(j.id, i + 1));
    return m;
  }, [jobs]);

  const reviewingJobId = manual.reviewingJobId;
  const lockRemaining = manual.lockRemainingS;

  const isManual = control === 'MANUAL';

  return (
    <section
      className="rounded-2xl border border-white/10 bg-slate-900/60 backdrop-blur-xl p-4 flex flex-col gap-3"
      style={{ color: '#e2e8f0' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge label="REQ" value={metrics.requests} accent={policy.dispatch === 'FIFO' ? RED : CYAN} />
          <Badge label="JOBS" value={metrics.jobs} accent={CYAN} />
        </div>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: isManual ? AMBER : LABEL }}
        >
          {isManual ? 'MANUAL · judge on the loop' : policy.dispatch === 'FIFO' ? 'POLICY · FIFO' : 'POLICY · WSPT'}
        </div>
      </div>

      {/* Utilization + operators */}
      <UtilizationGauge rho={metrics.rho} />
      <OperatorChips operators={operators} />

      {/* Manual counter */}
      {isManual && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: AMBER }}>
            YOU: answered {manual.answered} · waiting {jobs.length}
          </span>
        </div>
      )}

      {/* Jobs list */}
      <div className="flex flex-col gap-2 overflow-y-auto pr-1 max-h-[560px]">
        {jobs.length === 0 && (
          <div className="text-center font-mono text-[11px] tracking-[0.12em] py-6" style={{ color: LABEL }}>
            NO ACTIVE JOBS
          </div>
        )}
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            rank={ranks.get(job.id) ?? 0}
            reviewing={reviewingJobId === job.id}
            lockRemainingS={lockRemaining}
            disabled={!!reviewingJobId && reviewingJobId !== job.id}
            onAnswer={isManual ? onAnswer : undefined}
          />
        ))}
      </div>
    </section>
  );
}