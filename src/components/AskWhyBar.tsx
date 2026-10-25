'use client';

// "Why is this card first?" Answers from the job's own numbers (w, p, breakdown); nothing is
// invented. Ask about a rank with "#3"; the default is #1, the job answered next.
// The mic uses the browser's speech recognition where it exists (Chrome, Safari).

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleHelp, Mic, Square } from 'lucide-react';
import type { Job } from '@/types/sim';

type Recognizer = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechWindow = { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const tag = (rank: number) => `#${String(rank).padStart(3, '0')}`;

export function explainJob(job: Job | undefined, rank: number): string {
  if (!job) return rank === 1 ? 'The queue is empty right now.' : `There is no ${tag(rank)} in the queue right now.`;
  if (job.kind === 'ZONE_POLICY') {
    const v = (label: string) => job.breakdown.find((b) => b.label === label)?.value ?? 0;
    return `${tag(rank)} is the zone policy. One approval turns ${v('dark signals')} dark signals into 4-way stops `
      + `and clears ${v('confirm requests cleared')} confirm requests at once. Only a human can approve it.`;
  }
  if (job.kind === 'FIFO') {
    return `${tag(rank)} is here only because it arrived first: first come, first served ignores impact. `
      + `It takes ${fmt(job.p)} s to handle.`;
  }
  const terms = job.breakdown.filter((b) => b.value !== 0).map((b) => `${b.label} ${fmt(b.value)}`);
  const batch = job.requestIds.length > 1 ? ` It answers ${job.requestIds.length} requests in one click.` : '';
  return `${tag(rank)} score ${fmt(job.w)}${terms.length ? ` = ${terms.join(' + ')}` : ''}. `
    + `Priority ${fmt(job.w)} / ${fmt(job.p)} s = ${(job.w / job.p).toFixed(2)} per s.${batch}`;
}

export default function AskWhyBar({ jobs, contextKey = 'live', active = true }: { jobs: Job[]; contextKey?: string; active?: boolean }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ text: string; context: string } | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Recognizer | null>(null);
  const currentRef = useRef({ jobs, contextKey });
  useEffect(() => { currentRef.current = { jobs, contextKey }; }, [jobs, contextKey]);
  useEffect(() => () => { recRef.current?.stop(); recRef.current = null; }, [contextKey, active]);

  const ask = (q: string) => {
    const current = currentRef.current;
    const rank = Number(q.match(/#?\s*(\d+)/)?.[1] ?? 1) || 1;
    setAnswer({ text: explainJob(current.jobs[rank - 1], rank), context: current.contextKey });
  };
  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as SpeechWindow;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setAnswer({ text: 'Voice input is not supported in this browser. Type your question instead.', context: contextKey }); return; }
    const rec = new Ctor();
    rec.lang = 'en-US'; rec.interimResults = false;
    rec.onresult = e => { const said = e.results[0]?.[0]?.transcript ?? ''; setQuestion(said); ask(said); };
    rec.onend = () => { recRef.current = null; setListening(false); };
    rec.onerror = () => { recRef.current = null; setListening(false); setAnswer({ text: 'Voice input could not start. You can type your question below.', context: currentRef.current.contextKey }); };
    recRef.current = rec;
    try { rec.start(); setListening(true); }
    catch { recRef.current = null; setListening(false); setAnswer({ text: 'Voice input could not start. You can type your question below.', context: contextKey }); }
  };
  return <section className="analysis-panel why-panel">
    <h2><CircleHelp />Ask why</h2>
    <p className="analysis-description">Understand the reasoning behind a request’s position in the queue.</p>
    <div className="why-example"><span>Try a question</span><button onClick={() => { setQuestion('Why is #1 first?'); ask('Why is #1 first?'); }}>Why is #1 first?<ArrowRight /></button></div>
    <form onSubmit={e => { e.preventDefault(); ask(question); }}>
      <label htmlFor="ask-why">Your question</label>
      <div className="analysis-input-row"><input id="ask-why" value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask about #1, #2, or another request" />
        <button type="button" className="icon-button mic-button" onClick={toggleMic} aria-label={listening ? 'Stop listening' : 'Ask by voice'} aria-pressed={listening}>{listening ? <Square /> : <Mic />}</button></div>
      <button className="action-button secondary" type="submit">Explain decision<ArrowRight /></button>
    </form>
    {answer?.context === contextKey && <p className="why-answer" aria-live="polite">{answer.text}</p>}
    <p className="analysis-footnote">Explanations come directly from the job’s priority, handling time, and impact breakdown.</p>
  </section>;
}
