'use client';

// Pick a preset incident (or type one), send it to /api/analyze-chaos, and show what came
// back. onResult lets the page act on it (today only OUTAGE changes the sim).

import { useState } from 'react';
import type { ChaosResult } from '@/app/api/analyze-chaos/route';

const PRESETS = [
  {
    title: 'SoMa substation fire',
    desc: 'Power out across SoMa; traffic lights go dark',
    color: 'bg-red-400',
    text: 'Substation fire near 8th and Harrison, power is out across SoMa',
  },
  {
    title: 'Chase Center event exit',
    desc: '18,000 fans leave at once and flood ride requests',
    color: 'bg-amber-400',
    text: 'Warriors game just ended at Chase Center, 18,000 fans leaving at once',
  },
  {
    title: 'Cellular degradation',
    desc: 'Carrier trouble drops car-to-operator links',
    color: 'bg-violet-400',
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
    <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4 backdrop-blur-xl">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#a9b6cc]">Event injector</h2>

      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((p, i) => (
          <button key={p.title} onClick={() => pick(i)} aria-pressed={selected === i}
            className={`flex min-h-11 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
              selected === i ? 'border-cyan-400 bg-cyan-400/10' : 'border-white/10 hover:border-white/25'}`}>
            <span aria-hidden="true" className={`mt-1 size-2.5 shrink-0 rounded-sm ${p.color}`} />
            <span>
              <span className="block text-sm font-medium text-slate-100">{p.title}</span>
              <span className="block text-xs text-[#a9b6cc]">{p.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <label htmlFor="chaos-text" className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#a9b6cc]">
        Describe the incident
      </label>
      <div className="flex gap-2">
        <input id="chaos-text" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') analyze(); }}
          className="min-h-11 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400" />
        <button onClick={analyze} disabled={loading || !text.trim()}
          className="min-h-11 rounded-xl bg-cyan-400 px-4 font-mono text-xs font-semibold uppercase tracking-widest text-slate-950 disabled:opacity-50">
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>

      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {result && (
        <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm text-slate-200">{result.rationale}</p>
            <span className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold tracking-widest ${
              result.source === 'CLAUDE' ? 'bg-cyan-400/15 text-cyan-300' : 'bg-slate-700/60 text-slate-300'}`}>
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
