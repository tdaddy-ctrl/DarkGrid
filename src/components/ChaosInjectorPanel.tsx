'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronRight, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import type { ChaosResult } from '@/app/api/analyze-chaos/route';

const PRESETS = [
  { title: 'Substation outage', text: 'Substation fire near 8th and Harrison, power is out across SoMa', live: true },
  { title: 'Road collision', text: 'Two vehicles crashed on the ambulance route. The wreck is blocking the road.', live: true },
  { title: 'Event exit', text: 'A crowd is leaving Chase Center and ride requests are surging', live: false },
  { title: 'Network disruption', text: 'Cell network degraded across the Mission, robotaxis losing their operator link', live: false },
];

export default function ChaosInjectorPanel({ onResult }: { onResult?: (r: ChaosResult) => void }) {
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState(PRESETS[0].text);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ChaosResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; requestRef.current?.abort(); }; }, []);

  const analyze = async () => {
    if (!text.trim() || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25_000);
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/analyze-chaos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!mountedRef.current || controller.signal.aborted) return;
      setResult(data as ChaosResult);
      onResult?.(data as ChaosResult);
    } catch (err) {
      if (mountedRef.current) setError(controller.signal.aborted ? 'Analysis timed out. Try again, or trigger a blackout from the City view.' : err instanceof Error ? err.message : 'Analysis failed. Please try again.');
    } finally {
      clearTimeout(timeout);
      requestRef.current = null;
      if (mountedRef.current) setLoading(false);
    }
  };
  return <section className="analysis-panel event-panel">
    <h2><Sparkles />Event analysis</h2>
    <p className="analysis-description">Describe an incident. Review the suggested response before approving any policy.</p>
    <div className="incident-presets" role="group" aria-label="Incident presets">{PRESETS.map((preset, i) => <button key={preset.title} disabled={loading} aria-pressed={selected === i} onClick={() => { setSelected(i); setText(preset.text); }}><span>{preset.title}</span><small>{preset.live ? 'Simulation' : 'Analysis only'}</small><ChevronRight /></button>)}</div>
    <form onSubmit={e => { e.preventDefault(); void analyze(); }}>
      <label htmlFor="chaos-text">Describe the incident</label>
      <textarea id="chaos-text" value={text} disabled={loading} onChange={e => setText(e.target.value)} maxLength={2000} rows={3} />
      <button className="action-button primary" disabled={loading || !text.trim()} type="submit"><Sparkles />{loading ? 'Analyzing incident…' : 'Analyze incident'}{!loading && <ArrowRight />}</button>
    </form>
    {error && <p className="analysis-error" role="alert">{error}</p>}
    {result && <div className="analysis-result"><div className="result-source"><span>{result.event.type === 'OUTAGE' ? <Zap /> : <Sparkles />}{result.event.type.replaceAll('_', ' ')}</span><span className="draft-source">{result.source === 'CLAUDE' ? 'Claude' : 'Offline rules'}</span></div><p>{result.rationale}</p><p className="analysis-result-note"><ShieldCheck />{result.event.type === 'OUTAGE' ? 'Blackout applies to a live run without an outage. Zone policy still needs human approval in Requests.' : result.event.type === 'COLLISION' ? 'On a live run, the collision is injected into both cities. Recovery must finish before the road reopens.' : 'Analysis only. This event does not change the current simulation.'}</p></div>}
  </section>;
}
