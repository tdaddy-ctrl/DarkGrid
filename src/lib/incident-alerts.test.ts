import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ambulance } from '@/types/sim';
import { createAlertTracker, createSoundPlayer } from './incident-alerts';

const ambulance = (status: Ambulance['status'], phase: NonNullable<Ambulance['mission']>['phase'] = 'TO_HOSPITAL', lat = 37): Ambulance => ({
  status, pos: { lat, lng: -122 }, headingDeg: 0, tripS: 30,
  mission: { origin: { lat, lng: -122 }, pickup: { lat, lng: -122 }, hospital: { lat, lng: -122 }, phase,
    pickupStartedAt: null, pickupCompleteAt: null },
});

describe('policy incident alerts', () => {
  it('keeps policies independent and emits STUCK once until actual movement', () => {
    const tracker = createAlertTracker();
    for (const policy of ['FIFO', 'DARKGRID'] as const) tracker.observe(policy, 0, ambulance('WAITING'), true);
    expect(tracker.observe('FIFO', 20, ambulance('STUCK'), true)).toEqual([{ policy: 'FIFO', kind: 'stuck' }]);
    expect(tracker.observe('FIFO', 21, ambulance('STUCK'), true)).toEqual([]);
    expect(tracker.observe('DARKGRID', 20, ambulance('EN_ROUTE'), true)).toEqual([]);
    tracker.observe('FIFO', 22, ambulance('EN_ROUTE'), true);
    expect(tracker.observe('FIFO', 23, ambulance('STUCK'), true)).toEqual([]);
    tracker.observe('FIFO', 24, ambulance('EN_ROUTE', 'TO_HOSPITAL', 37.0001), true);
    expect(tracker.observe('FIFO', 44, ambulance('STUCK', 'TO_HOSPITAL', 37.0001), true)).toHaveLength(1);
    expect(tracker.observe('DARKGRID', 44, ambulance('STUCK'), true)).toEqual([{ policy: 'DARKGRID', kind: 'stuck' }]);
  });

  it('excludes brief stops and pickup, and only announces final delivery once per policy', () => {
    const tracker = createAlertTracker();
    for (const policy of ['FIFO', 'DARKGRID'] as const) {
      tracker.observe(policy, 0, ambulance('WAITING'), true);
      expect(tracker.observe(policy, 1, ambulance('EN_ROUTE'), true)).toEqual([]);
      expect(tracker.observe(policy, 2, ambulance('STUCK', 'PICKING_UP'), true)).toEqual([]);
      expect(tracker.observe(policy, 3, ambulance('ARRIVED', 'PICKING_UP'), true)).toEqual([]);
      expect(tracker.observe(policy, 4, ambulance('ARRIVED', 'DELIVERED'), true)).toEqual([{ policy, kind: 'arrived' }]);
      expect(tracker.observe(policy, 5, ambulance('ARRIVED', 'DELIVERED'), true)).toEqual([]);
      expect(tracker.observe(policy, 6, ambulance('STUCK'), true)).toEqual([]);
    }
  });

  it('consumes events silently in replay and resets without replaying old events', () => {
    const tracker = createAlertTracker();
    tracker.observe('FIFO', 0, ambulance('WAITING'), true);
    expect(tracker.observe('FIFO', 20, ambulance('STUCK'), false)).toEqual([]);
    expect(tracker.observe('FIFO', 21, ambulance('STUCK'), true)).toEqual([]);
    expect(tracker.observe('FIFO', 50, ambulance('ARRIVED', 'DELIVERED'), false)).toEqual([]);
    expect(tracker.observe('FIFO', 51, ambulance('ARRIVED', 'DELIVERED'), true)).toEqual([]);
    expect(tracker.observe('FIFO', 10, ambulance('STUCK'), true)).toEqual([]);
    tracker.reset();
    expect(tracker.observe('FIFO', 0, ambulance('WAITING'), true)).toEqual([]);
    expect(tracker.observe('FIFO', 20, ambulance('STUCK'), true)).toHaveLength(1);
  });
});

function audioHarness(failure?: 'construct' | 'reject' | 'throw') {
  const clips: { src: string; audio: HTMLAudioElement }[] = [];
  const make = (src: string) => {
    if (failure === 'construct') throw new Error('Audio unavailable');
    const audio = { loop: true, volume: 1, onended: null, onerror: null,
      play: vi.fn(() => { if (failure === 'throw') throw new Error('blocked'); return failure === 'reject' ? Promise.reject(new Error('blocked')) : Promise.resolve(); }),
      pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    } as unknown as HTMLAudioElement;
    clips.push({ src, audio });
    return audio;
  };
  return { player: createSoundPlayer(make), clips };
}

afterEach(() => vi.useRealTimers());

describe('native MP3 player', () => {
  it('does nothing on creation, sequences click/alarm once, and releases ended clips', () => {
    vi.useFakeTimers();
    const { player, clips } = audioHarness();
    expect(clips).toHaveLength(0);
    player.blackout(); player.blackout();
    expect(clips.map(c => c.src)).toEqual(['/sounds/button-click.mp3']);
    clips[0].audio.onended?.call(clips[0].audio, new Event('ended'));
    expect(clips[0].audio.pause).toHaveBeenCalled();
    expect(clips[1].src).toBe('/sounds/blackout-alert.mp3');
    expect(clips[1].audio.loop).toBe(false);
    vi.runAllTimers();
    expect(clips[1].audio.pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces duplicate policy sounds and cancels pending alarm on mute or reset', () => {
    vi.useFakeTimers();
    const { player, clips } = audioHarness();
    player.play('ambulance-stuck'); player.play('ambulance-stuck');
    expect(clips).toHaveLength(1);
    player.blackout();
    const ended = clips[1].audio.onended;
    player.setMuted(true);
    ended?.call(clips[1].audio, new Event('ended'));
    player.play('ambulance-arrived');
    expect(clips).toHaveLength(2);
    expect(clips.every(c => vi.mocked(c.audio.pause).mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    player.setMuted(false); player.reset();
    expect(clips).toHaveLength(2); // Reset itself plays nothing.
    player.blackout();
    expect(clips).toHaveLength(3);
    player.reset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['construct', 'reject', 'throw'] as const)('contains audio %s failures', async failure => {
    vi.useFakeTimers();
    const { player } = audioHarness(failure);
    expect(() => player.blackout()).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    player.reset();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls through to the alarm if the click file is missing', () => {
    vi.useFakeTimers();
    const { player, clips } = audioHarness();
    player.blackout();
    clips[0].audio.onerror?.call(clips[0].audio, new Event('error'));
    expect(clips[1].src).toBe('/sounds/blackout-alert.mp3');
    player.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
