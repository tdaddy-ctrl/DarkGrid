import type { Ambulance, SimSnapshot } from '@/types/sim';

export type Policy = SimSnapshot['mode'];
export type AlertKind = 'stuck' | 'arrived';
export type PolicyAlert = { policy: Policy; kind: AlertKind };

// Observe live snapshots even during replay, silently consuming events that the user missed.
export function createAlertTracker() {
  const states = new Map<Policy, { t: number; stoppedAt?: Ambulance['pos']; arrived: boolean }>();
  return {
    reset: () => states.clear(),
    observe(policy: Policy, t: number, ambulance: Ambulance | null, notify: boolean): PolicyAlert[] {
      const previous = states.get(policy);
      if (!previous || t < previous.t) {
        states.set(policy, { t, arrived: ambulance?.status === 'ARRIVED',
          stoppedAt: ambulance?.status === 'STUCK' ? { ...ambulance.pos } : undefined });
        return [];
      }
      previous.t = t;
      if (!ambulance) return [];
      const phase = ambulance.mission?.phase;
      const delivered = ambulance.status === 'ARRIVED' && (!phase || phase === 'DELIVERED');
      const events: PolicyAlert[] = [];
      if (delivered && !previous.arrived) {
        previous.arrived = true;
        events.push({ policy, kind: 'arrived' });
      }
      // Re-arm only after physical movement (at least 0.5 m), not a status flicker.
      if (previous.stoppedAt && ambulance.status === 'EN_ROUTE' &&
        Math.hypot((ambulance.pos.lat - previous.stoppedAt.lat) * 110540,
          (ambulance.pos.lng - previous.stoppedAt.lng) * 111320 * Math.cos(ambulance.pos.lat * Math.PI / 180)) > 0.5) {
        previous.stoppedAt = undefined;
      }
      // STUCK already means 20 continuous simulated seconds stopped in the simulator.
      if (!previous.arrived && ambulance.status === 'STUCK' && phase !== 'PICKING_UP' && phase !== 'DELIVERED' && !previous.stoppedAt) {
        previous.stoppedAt = { ...ambulance.pos };
        events.push({ policy, kind: 'stuck' });
      }
      return notify ? events : [];
    },
  };
}

type Sound = 'button-click' | 'blackout-alert' | 'ambulance-stuck' | 'ambulance-arrived';

// No element or network request is created until an actual sound is requested.
export function createSoundPlayer(makeAudio = (src: string) => new Audio(src)) {
  const active = new Map<Sound, { audio: HTMLAudioElement; finish: () => void }>();
  let muted = false;
  let blackoutPlayed = false;
  let generation = 0;
  const stop = () => {
    generation++;
    for (const { finish } of [...active.values()]) finish();
  };
  const play = (name: Sound, next?: () => void) => {
    if (muted || active.has(name)) return;
    const current = generation;
    try {
      const audio = makeAudio(`/sounds/${name}.mp3`);
      audio.loop = false;
      audio.volume = 0.45;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        active.delete(name);
        audio.onended = audio.onerror = null;
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* Optional audio. */ }
        if (current === generation && !muted) next?.();
      };
      // Also release resources for stalled downloads or unusually long supplied clips.
      const deadline = setTimeout(finish, 15000);
      active.set(name, { audio, finish });
      audio.onended = audio.onerror = finish;
      try { void audio.play().catch(finish); } catch { finish(); }
    } catch { if (current === generation && !muted) next?.(); }
  };
  return {
    play,
    blackout() {
      if (blackoutPlayed) return;
      blackoutPlayed = true;
      play('button-click', () => play('blackout-alert'));
    },
    setMuted(value: boolean) { muted = value; if (value) stop(); },
    stop,
    reset() { stop(); blackoutPlayed = false; },
  };
}
