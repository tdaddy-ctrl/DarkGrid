'use client';

// Pick a preset incident (or type one), send it to /api/analyze-chaos, and show what came
// back. onResult lets the page act on it (today only OUTAGE changes the sim).

import { useState } from 'react';
import type { ChaosResult } from '@/app/api/analyze-chaos/route';

const PRESETS = [
  {
    title: 'SoMa substation fire',
    desc: 'Power out across SoMa; traffic lights go dark',
    color: 'text-dg-red',
    text: 'Substation fire near 8th and Harrison, power is out across SoMa',
  },
  {
    title: 'Chase Center event exit',
    desc: '18,000 fans leave at once and flood ride requests',
    color: 'text-dg-amber',
    text: 'Warriors game just ended at Chase Center, 18,000 fans leaving at once',
  },
  {
    title: 'Cellular degradation',
    desc: 'Carrier trouble drops car-to-operator links',
    color: 'text-violet-400',
    text: 'Cell network degraded across the Mission, robotaxis losing their operator link',
  },
];

export default function ChaosInjectorPanel({ onResult }: { onResult?: (r: ChaosResult) => void }) {
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState(PRESETS[0].text);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ChaosResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (i: number) => { setSelected(i); setText(PRESETS[i].text); };

  const analyze = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analyze-chaos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data as ChaosResult);
      onResult?.(data as ChaosResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="dg-panel flex min-h-0 flex-col gap-2.5 overflow-y-auto p-4">
      <h2 className="dg-label flex items-center gap-2">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current text-dg-amber [animation:dg-breathe_2s_ease-in-out_infinite]" />
        Event injector
      </h2>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p, i) => (
          <button key={p.title} onClick={() => pick(i)} aria-pressed={selected === i} title={p.desc}
            className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all duration-200 hover:-translate-y-0.5 ${
              selected === i
                ? 'border-dg-cyan/80 bg-dg-cyan/[0.08] shadow-[0_0_0_1px_rgba(56,189,248,.45),0_0_26px_-6px_rgba(56,189,248,.75)]'
                : 'border-dg-line bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]'}`}>
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full bg-current shadow-[0_0_10px_currentColor] ${p.color}`} />
            <span className="text-sm font-medium text-slate-100">{p.title}</span>
          </button>
        ))}
      </div>

      <label htmlFor="chaos-text" className="dg-label">
        Describe the incident
      </label>
      <div className="flex gap-2">
        <input id="chaos-text" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') analyze(); }}
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-dg-line bg-black/40 px-3 text-sm text-slate-100 outline-none transition focus:border-dg-cyan/70 focus:shadow-[0_0_0_3px_rgba(56,189,248,.15)]" />
        <button onClick={analyze} disabled={loading || !text.trim()}
          className="min-h-11 rounded-xl bg-linear-to-b from-[#7dd3fc] to-dg-cyan px-5 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-slate-950 shadow-[0_0_20px_-6px_rgba(56,189,248,.8)] transition-all duration-200 enabled:hover:-translate-y-px enabled:hover:shadow-[0_0_28px_-4px_rgba(56,189,248,1)] disabled:opacity-50">
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>

      {error && <p role="alert" className="text-sm text-dg-red">{error}</p>}
      {result && (
        <div className="rounded-xl border border-dg-line bg-black/40 p-3 [animation:dg-rise_.3s_ease-out]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm text-slate-200">{result.rationale}</p>
            <span className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold tracking-widest ${
              result.source === 'CLAUDE' ? 'bg-dg-cyan/15 text-dg-cyan shadow-[0_0_12px_-3px_rgba(56,189,248,.7)]' : 'bg-white/[0.06] text-slate-300'}`}>
              {result.source}
            </span>
          </div>
          <pre className="max-h-40 overflow-auto font-mono text-xs leading-relaxed text-slate-300">
            {JSON.stringify({ event: result.event, policy: result.policy }, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}
