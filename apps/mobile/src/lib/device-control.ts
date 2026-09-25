import type { DeviceActivity } from '@/protocol/types';

export interface Size {
  width: number;
  height: number;
}

/**
 * Where a touch at (`x`, `y`) in a view of `box` size lands on a frame of `frame` size drawn with
 * `contentFit="contain"`, as fractions of the frame, origin top-left. Outside the frame it returns null, unless
 * `clamp` pins it to the nearest edge, as a drag that leaves the picture should.
 */
export function framePoint(
  x: number,
  y: number,
  box: Size,
  frame: Size,
  clamp: boolean,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  const fx = (x - (box.width - width) / 2) / width;
  const fy = (y - (box.height - height) / 2) / height;
  if (clamp) return { x: Math.min(Math.max(fx, 0), 1), y: Math.min(Math.max(fy, 0), 1) };
  return fx < 0 || fx > 1 || fy < 0 || fy > 1 ? null : { x: fx, y: fy };
}

const REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
};

/**
 * What the phone keyboard typed, as the printable ASCII `input.text` takes: smart punctuation becomes its
 * ASCII form and other characters are dropped.
 */
export function asciiText(text: string): string {
  let out = '';
  for (const char of text) {
    const replaced = REPLACEMENTS[char] ?? char;
    for (const c of replaced) {
      const code = c.charCodeAt(0);
      if ((code >= 0x20 && code <= 0x7e) || c === '\n') out += c;
    }
  }
  return out;
}

/**
 * What to type on the device when the phone's text field changes from `previous` to `next`, both as the
 * ASCII the device receives: a Delete (`\b`) for each character removed after their common prefix, then the
 * characters added.
 */
export function keyboardDelta(previous: string, next: string): string {
  const before = asciiText(previous);
  const after = asciiText(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  return '\b'.repeat(before.length - common) + after.slice(common);
}

/**
 * Who drives the device according to status, or null when nothing does or the only driver is the lease this
 * phone's own control session holds (the lease's `grantedAt` is the driver's `since`).
 */
export function otherDriver(activity: DeviceActivity | undefined, ownLeaseSince: string | null): string | null {
  if (activity?.state !== 'driven' || !activity.driver) return null;
  const { tool, since } = activity.driver;
  if (tool === 'stim device lock' && ownLeaseSince !== null && since === ownLeaseSince) return null;
  return tool;
}
