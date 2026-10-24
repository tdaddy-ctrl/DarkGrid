'use client';

import type { Ambulance } from '@/types/sim';

// Big banner overlay for the map when the ambulance arrives or gets stuck.
// Parent must be `position: relative` (the current <MapPlaceholder> is already relative).
// Renders nothing when status is WAITING or EN_ROUTE.

export default function ArrivalOverlay({ ambulance }: { ambulance: Ambulance | null }) {
  if (!ambulance) return null;
  const { status, tripS } = ambulance;
  if (status !== 'ARRIVED' && status !== 'STUCK') return null;

  const isArrived = status === 'ARRIVED';
  const mm = String(Math.floor(tripS / 60)).padStart(2, '0');
  const ss = String(Math.floor(tripS % 60)).padStart(2, '0');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <div
        className={`flex flex-col items-center gap-1 rounded-2xl border px-10 py-6 backdrop-blur-md ${
          isArrived
            ? 'border-dg-green/40 bg-dg-green/[0.08] shadow-[0_0_60px_-10px_rgba(34,197,94,.7)]'
            : 'border-dg-red/40 bg-dg-red/[0.08] shadow-[0_0_60px_-10px_rgba(255,42,84,.7)]'
        }`}
      >
        <span
          className={`font-display text-5xl font-bold tracking-[0.18em] ${
            isArrived ? 'text-dg-green' : 'text-dg-red'
          }`}
        >
          {isArrived ? 'ARRIVED' : 'STUCK'}
        </span>
        <span
          className={`font-mono text-2xl tabular-nums tracking-[0.14em] ${
            isArrived ? 'text-dg-green/80' : 'text-dg-red/80'
          }`}
        >
          {mm}:{ss}
        </span>
      </div>
    </div>
  );
}