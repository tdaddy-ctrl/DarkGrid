import type { HistoryFrame } from '../types/sim';

/** Bounded history ordered by simulation seconds. Use the exported functions. */
class HistoryBuffer {
  private frames: HistoryFrame[] = [];

  constructor(private readonly maxFrames: number) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError('maxFrames must be a positive safe integer');
    }
  }

  push(frame: HistoryFrame): void {
    if (!Number.isFinite(frame.t)) throw new RangeError('Frame timestamp must be finite');
    // Clone before changing the buffer so a failed clone leaves history intact.
    const copy = structuredClone(frame);
    const index = this.upperBound(frame.t);
    if (index > 0 && this.frames[index - 1].t === frame.t) {
      this.frames[index - 1] = copy;
    } else {
      this.frames.splice(index, 0, copy);
      if (this.frames.length > this.maxFrames) this.frames.shift();
    }
  }

  frameAt(t: number): HistoryFrame | null {
    if (Number.isNaN(t)) throw new RangeError('Lookup timestamp must not be NaN');
    const index = this.upperBound(t) - 1;
    return index < 0 ? null : structuredClone(this.frames[index]);
  }

  range(): { start: number; end: number } | null {
    if (!this.frames.length) return null;
    return { start: this.frames[0].t, end: this.frames[this.frames.length - 1].t };
  }

  /** First index whose timestamp is greater than t. */
  private upperBound(t: number): number {
    let low = 0, high = this.frames.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (this.frames[mid].t <= t) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}

export type History = HistoryBuffer;

/** A schedules recording every HISTORY_EVERY_S; the buffer does not sample itself. */
export function createHistory(maxFrames = 450): History {
  return new HistoryBuffer(maxFrames);
}

/** Store an owned copy; duplicate timestamps replace, oldest timestamps evict. */
export function push(h: History, frame: HistoryFrame): void {
  h.push(frame);
}

/** Greatest stored timestamp <= t, without interpolation; returns an owned copy. */
export function frameAt(h: History, t: number): HistoryFrame | null {
  return h.frameAt(t);
}

export function range(h: History): { start: number; end: number } | null {
  return h.range();
}
