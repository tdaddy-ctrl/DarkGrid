'use client';

import type { Ambulance } from '@/types/sim';

// A simulated view of the data packet we push to AV fleets.
// This is the "product" — the machine-readable feed.

export default function EmergencyFeedPanel({ ambulance }: { ambulance: Ambulance | null }) {
  if (!ambulance) return null;

  const isActive = ambulance.status === 'EN_ROUTE' || ambulance.status === 'ARRIVED';
  
  return (
    <section className="dg-panel flex min-h-[200px] flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-dg-line px-4 py-3">
        <h2 className="dg-label flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-dg-cyan shadow-[0_0_8px_#38BDF8]" />
          EMS DATA FEED
        </h2>
        <span className="font-mono text-[10px] tracking-[0.12em] text-slate-400">
          {isActive ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>
      
      <div className="flex-1 p-4 font-mono text-xs text-slate-300">
        {isActive ? (
          <div className="space-y-2">
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-dg-label">UNIT</span>
              <span className="text-dg-cyan">AMB-01</span>
            </div>
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-dg-label">STATUS</span>
              <span className={ambulance.status === 'ARRIVED' ? 'text-dg-green' : 'text-dg-amber'}>
                {ambulance.status.replace('_', ' ')}
              </span>
            </div>
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-dg-label">PRIORITY</span>
              <span className="text-dg-red">HIGH</span>
            </div>
            <div className="flex justify-between border-b border-white/5 pb-1">
              <span className="text-dg-label">BROADCAST</span>
              <span className="text-dg-cyan">FLEET-WIDE</span>
            </div>
            <div className="mt-3 rounded bg-black/40 p-2 text-[10px] leading-relaxed text-slate-400">
              <p className="text-dg-cyan">{"{"} type: "RESCUE_CORRIDOR", {"}"}</p>
              <p className="text-dg-cyan">{"{"} route: "4th St → Mission St", {"}"}</p>
              <p className="text-dg-cyan">{"{"} action: "YIELD_AND_STAGE", {"}"}</p>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-slate-500">
            Awaiting Emergency Feed...
          </div>
        )}
      </div>
    </section>
  );
}