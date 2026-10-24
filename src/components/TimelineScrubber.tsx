'use client';

import { useId } from 'react';
import { HISTORY_EVERY_S } from '@/lib/config';

export type TimelineScrubberProps = {
  range: { start: number; end: number } | null;
  t: number;
  isLive: boolean;
  outageT: number | null;
  onScrub(t: number): void;
  onGoLive(): void;
};

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '--:--';
  const seconds = Math.floor(Math.max(0, t));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Controlled display only: the parent owns recording, playback and the live clock. */
export default function TimelineScrubber({ range, t, isLive, outageT, onScrub, onGoLive }: TimelineScrubberProps) {
  const helpId = useId();
  const hasRange = range !== null && Number.isFinite(range.start)
    && Number.isFinite(range.end) && range.end >= range.start;
  const start = hasRange ? range.start : 0;
  const end = hasRange ? range.end : 0;
  const canScrub = hasRange && end > start;
  const clamp = (value: number) => Math.min(end, Math.max(start, value));
  const selected = clamp(Number.isFinite(t) ? t : start);
  const progress = canScrub ? (selected - start) / (end - start) * 100 : 0;
  const hasMarker = hasRange && outageT !== null && Number.isFinite(outageT)
    && outageT >= start && outageT <= end;
  const markerPercent = hasMarker && canScrub ? (outageT - start) / (end - start) * 100 : 0;

  const scrub = (value: number) => {
    if (canScrub && Number.isFinite(value)) onScrub(clamp(value));
  };

  return (
    <div role="group" aria-label="Simulation timeline"
      className="dg-panel flex h-11 w-full shrink-0 items-center gap-2 px-3 sm:gap-3">
      <span className="dg-label hidden shrink-0 sm:inline">Timeline</span>
      <output aria-label="Current simulation time" className="shrink-0 font-mono text-xs tabular-nums text-slate-100">
        {formatTime(t)}
      </output>

      <div className="relative min-w-0 flex-1">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-dg-label/20">
          <div className="h-full bg-dg-cyan/70" style={{ width: `${progress}%` }} />
        </div>
        <input type="range" aria-label="Simulation history time" aria-describedby={helpId}
          aria-valuetext={hasRange ? formatTime(selected) : 'No recorded history'}
          min={start} max={end} step="any" value={selected} disabled={!canScrub}
          onChange={(event) => scrub(event.currentTarget.valueAsNumber)}
          onKeyDown={(event) => {
            const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1
              : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
            if (direction) {
              event.preventDefault();
              scrub(selected + direction * HISTORY_EVERY_S);
            }
          }}
          className="relative z-10 block h-8 w-full cursor-pointer appearance-none rounded bg-transparent accent-dg-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dg-cyan disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-dg-cyan [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-dg-cyan"
        />
        {hasMarker && (
          <div className="pointer-events-none absolute inset-x-2 inset-y-0 z-20">
            <span role="img" aria-label={`Blackout at ${formatTime(outageT)}`}
              title={`Blackout at ${formatTime(outageT)}`}
              className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-dg-red shadow-[0_0_6px_rgba(255,42,84,0.65)]"
              style={{ left: `${markerPercent}%` }} />
          </div>
        )}
      </div>

      <span id={helpId} className="sr-only">
        {canScrub ? `Use arrow keys to move ${HISTORY_EVERY_S} simulation seconds. Recorded range ${formatTime(start)} to ${formatTime(end)}.`
          : hasRange ? 'Only one recorded timestamp is available.' : 'No recorded history is available.'}
      </span>
      <button type="button" aria-label="Go live" aria-pressed={isLive} onClick={onGoLive}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] font-semibold tracking-widest transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dg-cyan ${
          isLive ? 'border-dg-cyan/60 bg-dg-cyan/15 text-dg-cyan shadow-[0_0_12px_rgba(56,189,248,0.3)]'
            : 'border-dg-line text-dg-label hover:border-dg-cyan/50 hover:text-dg-cyan'}`}>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${isLive ? 'bg-dg-cyan' : 'bg-dg-label/50'}`} />
        LIVE
      </button>
    </div>
  );
}
