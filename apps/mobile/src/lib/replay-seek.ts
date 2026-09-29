import type { ReplayRate } from '@/protocol/types';

export interface Seek {
  at: number;
  rate: ReplayRate;
}

/** The shortest time between two `frames.seek` requests of one stream. */
export const SEEK_INTERVAL_MS = 50;

/**
 * The `frames.seek` requests of one stream: at most one is out at a time, at most one waits, and a newer seek
 * replaces the one waiting. Each seek makes stim-server resend the frames from the keyframe before it, so a drag
 * sends the finger's latest time at most every `SEEK_INTERVAL_MS` instead of one seek per touch event.
 */
export class SeekQueue {
  private sending: Seek | null = null;
  private waiting: Seek | null = null;
  private sentAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Nothing is out or waiting, so the frames that arrive belong to the position shown. */
  get settled(): boolean {
    return this.sending === null && this.waiting === null;
  }

  /** Makes `seek` the one waiting, in place of any older one; `next` sends it. */
  ask(seek: Seek): void {
    this.waiting = seek;
  }

  /** The waiting seek when it can go out now: the subscription is open, nothing is out, and the interval passed. */
  next(now: number, open: boolean): Seek | null {
    const seek = this.waiting;
    if (!open || this.sending || !seek || now - this.sentAt < SEEK_INTERVAL_MS) return null;
    this.sending = seek;
    this.waiting = null;
    this.sentAt = now;
    return seek;
  }

  /** How long until the waiting seek may go out, when only the interval holds it back. */
  delay(now: number, open: boolean): number | null {
    if (!open || this.sending || !this.waiting) return null;
    const delay = this.sentAt + SEEK_INTERVAL_MS - now;
    return delay > 0 ? delay : null;
  }

  /**
   * `seek` was answered or refused. Returns whether its answer should be shown: it was the seek out, and no newer
   * one waits. The answer to a seek dropped by `clear` is never shown.
   */
  finish(seek: Seek): boolean {
    if (this.sending !== seek) return false;
    this.sending = null;
    return this.waiting === null;
  }

  /** The subscription was replaced with a seek out: it goes to the new one unless a newer seek waits. */
  interrupt(): void {
    if (this.waiting === null) this.waiting = this.sending;
    this.sending = null;
    this.sentAt = -Infinity;
  }

  /**
   * Sends the waiting seek to the subscription `open` names when it can go out, or once the interval passes; `open`
   * is null while no subscription is open.
   */
  pump(open: () => string | null, send: (subscription: string, seek: Seek) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const subscription = open();
    const now = Date.now();
    const seek = this.next(now, subscription !== null);
    if (seek && subscription !== null) return send(subscription, seek);
    const delay = this.delay(now, subscription !== null);
    if (delay !== null) this.timer = setTimeout(() => this.pump(open, send), delay);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sending = null;
    this.waiting = null;
    this.sentAt = -Infinity;
  }
}

/** How far a finger moves along the track before a touch is a drag instead of a tap. */
export const DRAG_SLOP = 6;

/**
 * A finger on the replay track. It becomes a drag once it moves `DRAG_SLOP` from where it went down, and the drag
 * remembers whether the replay played then, so lifting the finger can play on.
 */
export type Scrub = { x: number; drag: null } | { x: number; drag: { resume: boolean } };

export function scrubStart(x: number): Scrub {
  return { x, drag: null };
}

/** The scrub after the finger moved to `x`, `playing` being whether the replay plays now. */
export function scrubMove(scrub: Scrub, x: number, playing: boolean): Scrub {
  if (scrub.drag) return scrub;
  if (Math.abs(x - scrub.x) < DRAG_SLOP) return scrub;
  return { x: scrub.x, drag: { resume: playing } };
}

/**
 * The rate to seek at when the finger lifts: a drag plays on when the replay played as the drag began, and a tap
 * keeps the replay playing or paused. Every seek while the finger moves pauses.
 */
export function scrubEndRate(scrub: Scrub, playing: boolean, speed: 1 | 2): ReplayRate {
  const plays = scrub.drag ? scrub.drag.resume : playing;
  return plays ? speed : 0;
}
