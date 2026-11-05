import type { TouchPhase } from './protocol.ts';

/** The touch fields a grab replays when it lets go for its holder. */
export interface GrabTouch {
  phase: TouchPhase;
  x: number;
  y: number;
}

export interface GrabHolder {
  id: string;
  name: string;
}

/** How long a holder can go without input before its grab ends: long enough for a long-press. */
export const GRAB_IDLE_MS = 10_000;

/**
 * Who holds a device's one pointer. A `down` takes it, the holder's `up` releases it, and while it is held every touch
 * from anyone else is dropped. The holder's later touches after a forced release are dropped too.
 */
export class PointerGrab<H extends GrabHolder, T extends GrabTouch> {
  private held: { holder: H; last: T } | null = null;

  get holder(): H | null {
    return this.held?.holder ?? null;
  }

  /** Whether `touch` from `who` reaches the device; `busy` names the holder that turned a `down` away. */
  admit(who: H, touch: T): { admit: true } | { admit: false; busy?: string } {
    const held = this.held;
    if (touch.phase === 'down') {
      if (held && held.holder.id !== who.id) return { admit: false, busy: held.holder.name };
      this.held = { holder: who, last: touch };
      return { admit: true };
    }
    if (!held || held.holder.id !== who.id) return { admit: false };
    if (touch.phase === 'up') this.held = null;
    else held.last = touch;
    return { admit: true };
  }

  /** The `up` that lifts the pointer for `id` when it holds it (its socket closed), else null. */
  release(id: string): { holder: H; up: T } | null {
    const held = this.held;
    if (!held || held.holder.id !== id) return null;
    return this.lift(held);
  }

  /** The `up` that lifts the pointer for a holder that went quiet, or null when nobody holds it. */
  expire(): { holder: H; up: T } | null {
    return this.held ? this.lift(this.held) : null;
  }

  private lift(held: { holder: H; last: T }): { holder: H; up: T } {
    this.held = null;
    return { holder: held.holder, up: { ...held.last, phase: 'up' } };
  }
}
