'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAlertTracker, createSoundPlayer, type AlertKind, type Policy } from '@/lib/incident-alerts';
import type { SimSnapshot } from '@/types/sim';

export function useIncidentAlerts() {
  const [muted, setMuted] = useState(false);
  const [alerts, setAlerts] = useState<Partial<Record<Policy, { kind: AlertKind; id: number }>>>({});
  const [player] = useState(createSoundPlayer);
  const [tracker] = useState(createAlertTracker);
  const sequence = useRef(0);
  const timers = useRef(new Map<Policy, ReturnType<typeof setTimeout>>());
  const replaying = useRef(false);

  const clear = useCallback(() => {
    player.stop();
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setAlerts({});
  }, [player]);

  useEffect(() => {
    const currentTimers = timers.current;
    return () => {
      player.reset();
      tracker.reset();
      for (const timer of currentTimers.values()) clearTimeout(timer);
      currentTimers.clear();
    };
  }, [player, tracker]);

  const observe = useCallback((fifo: SimSnapshot, darkgrid: SimSnapshot, isLive: boolean) => {
    if (!isLive && !replaying.current) clear();
    // The first sample on returning live is a silent baseline, so replay never backfills alerts.
    const notify = isLive && !replaying.current;
    replaying.current = !isLive;
    const events = [tracker.observe('FIFO', fifo.t, fifo.ambulance, notify),
      tracker.observe('DARKGRID', darkgrid.t, darkgrid.ambulance, notify)].flat();
    for (const { policy, kind } of events) {
      const id = ++sequence.current;
      setAlerts(previous => ({ ...previous, [policy]: { kind, id } }));
      clearTimeout(timers.current.get(policy));
      timers.current.set(policy, setTimeout(() => {
        setAlerts(previous => ({ ...previous, [policy]: undefined }));
        timers.current.delete(policy);
      }, 1800));
    }
    // Coalesce simultaneous policy events into one playback per sound.
    for (const kind of new Set(events.map(event => event.kind))) player.play(`ambulance-${kind}`);
  }, [clear, player, tracker]);

  return { alerts, observe, blackout: player.blackout, muted,
    toggleMuted: () => { player.setMuted(!muted); setMuted(!muted); } };
}
