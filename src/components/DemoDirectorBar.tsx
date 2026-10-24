'use client';

import { useId, useState } from 'react';

export type DemoDirectorBarProps = {
  step: number;
  onReset: () => void;
  onBlackout: () => void;
  onManual: () => void;
  onDarkGrid: () => void;
  onSplit: () => void;
  onFollow: () => void;
};

/** The parent owns the demo step and simulation; only visibility is local state. */
export default function DemoDirectorBar({
  step, onReset, onBlackout, onManual, onDarkGrid, onSplit, onFollow,
}: DemoDirectorBarProps) {
  const actionsId = useId();
  const [hidden, setHidden] = useState(false);
  const actions = [
    { step: 0, label: 'RESET', onClick: onReset },
    { step: 1, label: '1 BLACKOUT', onClick: onBlackout },
    { step: 2, label: '2 JUDGE TAKES OVER', onClick: onManual },
    { step: 3, label: '3 DARK GRID ON', onClick: onDarkGrid },
    { step: 4, label: '4 SPLIT VIEW', onClick: onSplit },
    { step: 5, label: '5 FOLLOW AMBULANCE', onClick: onFollow },
  ];

  return (
    <section aria-label="Demo director" className="dg-panel flex w-full shrink-0 flex-wrap items-center gap-2 px-3 py-1.5">
      <span className="dg-label shrink-0">Demo director</span>
      <div id={actionsId} role="group" aria-label="Demo actions" hidden={hidden}
        className={`${hidden ? 'hidden' : 'flex'} min-w-0 flex-1 flex-wrap items-center gap-1.5`}>
        {actions.map((action) => {
          const selected = step === action.step;
          return (
            <button key={action.step} type="button" onClick={action.onClick}
              aria-current={selected ? 'step' : undefined}
              className={`min-h-8 shrink-0 whitespace-nowrap rounded-md border px-2.5 font-mono text-[10px] font-semibold tracking-[0.1em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dg-cyan ${
                selected ? 'border-dg-cyan/60 bg-dg-cyan/15 text-dg-cyan shadow-[0_0_12px_rgba(56,189,248,0.25)]'
                  : 'border-dg-line bg-white/[0.02] text-dg-label hover:border-dg-cyan/40 hover:text-dg-cyan'}`}>
              {action.label}
            </button>
          );
        })}
      </div>
      <button type="button" aria-controls={actionsId} aria-expanded={!hidden}
        aria-label={hidden ? 'Show demo director actions' : 'Hide demo director actions'}
        onClick={() => setHidden(value => !value)}
        className="ml-auto flex min-h-8 shrink-0 items-center gap-1 rounded-md border border-dg-line px-2 font-mono text-[10px] tracking-widest text-dg-label transition-colors hover:border-dg-cyan/40 hover:text-dg-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dg-cyan">
        <svg aria-hidden="true" viewBox="0 0 12 12" className={`size-3 ${hidden ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 7.5 3-3 3 3" />
        </svg>
        {hidden ? 'SHOW' : 'HIDE'}
      </button>
    </section>
  );
}
