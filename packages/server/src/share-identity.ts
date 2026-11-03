import { createHash, timingSafeEqual } from 'node:crypto';

export type ShareAccess = 'view' | 'control';

/** Palette indexes viewers get; 0 is the host's and 1 the agent's. */
const VIEWER_COLORS = [2, 3, 4, 5, 6, 7] as const;
const MAX_NAME_CODE_POINTS = 24;
const NO_DIGEST = Buffer.alloc(32);
/** The labels the server gives the share owner (`Host`), the agent (`Agent`, `Agent \u00b7 <command>`) and unnamed viewers. */
const RESERVED_NAME = /^(?:host|agent(?: ?\u00b7.*)?|guest ?\d+)$/iu;

export function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * The access `given` earns: the control password's, or the view password's. Both digests are always compared, so the
 * time taken does not say which password, or whether a view password exists, was closer.
 */
export function accessFor(given: string, control: Buffer, view: Buffer | null): ShareAccess | null {
  const hash = digest(given);
  const isControl = timingSafeEqual(hash, control);
  const isView = timingSafeEqual(hash, view ?? NO_DIGEST) && view !== null;
  return isControl ? 'control' : isView ? 'view' : null;
}

/**
 * A viewer's chosen name as other viewers see it: NFC, without control or format characters (bidi overrides included),
 * whitespace collapsed and trimmed, cut to 24 code points. Null when nothing usable is left, or when the name is one
 * the server assigns to the host, the agent or an unnamed viewer, so a viewer never passes for them; it is then shown
 * as `Guest N`.
 */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const capped = [...name].slice(0, MAX_NAME_CODE_POINTS).join('').trim();
  if (!capped || RESERVED_NAME.test(capped.normalize('NFKC'))) return null;
  return capped;
}

/** `Guest N`, N the lowest number no name in `taken` uses. */
export function guestName(taken: Iterable<string>): string {
  const used = new Set(taken);
  let number = 1;
  while (used.has(`Guest ${number}`)) number++;
  return `Guest ${number}`;
}

/** The lowest viewer color no name in `taken` uses; with every one used, the first. */
export function viewerColor(taken: Iterable<number>): number {
  const used = new Set(taken);
  return VIEWER_COLORS.find((color) => !used.has(color)) ?? VIEWER_COLORS[0];
}
