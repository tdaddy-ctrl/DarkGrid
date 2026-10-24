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
    <section className="dg-panel flex flex-col gap-3 p-4">
      <h2 className="dg-label flex items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${listening ? 'text-dg-cyan [animation:dg-breathe_1.2s_ease-in-out_infinite]' : 'text-slate-500'}`} />
        Ask why
      </h2>

      <div className="flex items-center gap-3">
        <button onClick={toggleMic} aria-label={listening ? 'Stop listening' : 'Ask by voice'} aria-pressed={listening}
          className={`grid size-11 shrink-0 place-items-center rounded-full border transition-colors ${
            listening
              ? 'border-dg-cyan bg-dg-cyan/20 text-dg-cyan shadow-[0_0_24px_-4px_rgba(34,211,238,.9)]'
              : 'border-dg-line bg-white/[0.03] text-slate-200 hover:border-white/25 hover:bg-white/[0.07]'}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <div aria-hidden="true" className="flex h-8 flex-1 items-center gap-[3px]">
          {Array.from({ length: BARS }, (_, i) => (
            <span key={i} className="h-full flex-1 origin-center rounded-full transition-opacity duration-300"
              style={{
                // A cyan-to-violet spectrum; at rest the bars hold a low, uneven profile.
                background: `linear-gradient(180deg, hsl(${187 + (i / (BARS - 1)) * 70} 90% 70%), hsl(${187 + (i / (BARS - 1)) * 70} 85% 45%))`,
                opacity: listening ? 1 : 0.35,
                transform: `scaleY(${(0.18 + 0.14 * Math.abs(Math.sin(i * 1.7))).toFixed(2)})`,
                animation: listening ? `dg-wave ${0.7 + (i % 5) * 0.12}s ease-in-out ${(i * 0.05).toFixed(2)}s infinite` : undefined,
              }} />
          ))}
        </div>
      </div>

      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <label htmlFor="ask-why" className="dg-label">
          Your question
        </label>
        <div className="flex gap-2">
          <input id="ask-why" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Why is #1 first?"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-dg-line bg-black/40 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-dg-cyan/70 focus:shadow-[0_0_0_3px_rgba(34,211,238,.15)]" />
          <button type="submit"
            className="min-h-11 rounded-xl border border-dg-cyan/60 bg-linear-to-b from-dg-cyan/20 to-dg-cyan/5 px-5 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-dg-cyan transition-all duration-200 hover:-translate-y-px hover:border-dg-cyan hover:shadow-[0_0_24px_-6px_rgba(34,211,238,.9)]">
            Ask
          </button>
        </div>
      </form>

      {answer && <p key={answer} aria-live="polite" className="rounded-xl border border-dg-line bg-black/40 p-3 font-mono text-sm leading-relaxed text-slate-200 [animation:dg-rise_.3s_ease-out]">{answer}</p>}
    </section>
  );
}
