'use client';

// "Why is this card first?" Answers from the job's own numbers (w, p, breakdown); nothing is
// invented. Ask about a rank with "#3"; the default is #1, the job answered next.
// The mic uses the browser's speech recognition where it exists (Chrome, Safari).

import { useRef, useState } from 'react';
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

const BARS = 24;

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

export default function AskWhyBar({ jobs }: { jobs: Job[] }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<Recognizer | null>(null);

  const ask = (q: string) => {
    const rank = Number(q.match(/#?\s*(\d+)/)?.[1] ?? 1) || 1;
    setAnswer(explainJob(jobs[rank - 1], rank));
  };

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as SpeechWindow;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { setAnswer('Voice input is not supported in this browser. Type the question instead.'); return; }
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? '';
      setQuestion(said);
      ask(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4 backdrop-blur-xl">
      <style>{'@keyframes dg-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}'}</style>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#a9b6cc]">Ask why</h2>

      <div className="flex items-center gap-3">
        <button onClick={toggleMic} aria-label={listening ? 'Stop listening' : 'Ask by voice'} aria-pressed={listening}
          className={`grid size-11 shrink-0 place-items-center rounded-full border transition-colors ${
            listening ? 'border-cyan-400 bg-cyan-400/20 text-cyan-300' : 'border-white/15 text-slate-200 hover:border-white/30'}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <div aria-hidden="true" className="flex h-8 flex-1 items-center gap-[3px]">
          {Array.from({ length: BARS }, (_, i) => (
            <span key={i}
              className={`h-full flex-1 origin-center rounded-full motion-reduce:[animation:none] ${listening ? 'bg-cyan-400' : 'bg-slate-600'}`}
              style={{
                transform: 'scaleY(.25)',
                animation: listening ? `dg-wave ${0.7 + (i % 5) * 0.12}s ease-in-out ${(i * 0.05).toFixed(2)}s infinite` : undefined,
              }} />
          ))}
        </div>
      </div>

      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <label htmlFor="ask-why" className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#a9b6cc]">
          Your question
        </label>
        <div className="flex gap-2">
          <input id="ask-why" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Why is #1 first?"
            className="min-h-11 flex-1 rounded-xl border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400" />
          <button type="submit"
            className="min-h-11 rounded-xl border border-cyan-400/60 px-4 font-mono text-xs font-semibold uppercase tracking-widest text-cyan-300 hover:bg-cyan-400/10">
            Ask
          </button>
        </div>
      </form>

      {answer && <p aria-live="polite" className="rounded-xl border border-white/10 bg-slate-950/60 p-3 font-mono text-sm leading-relaxed text-slate-200">{answer}</p>}
    </section>
  );
}
