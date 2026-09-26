/** A rectangle as `[x, y, width, height]`, the shape Reanimated animates as one value. */
export type Rect = [number, number, number, number];

/** Width over height of a frame, or null without one. */
export function aspectOf(frame: { width: number; height: number } | null | undefined): number | null {
  return frame && frame.width > 0 && frame.height > 0 ? frame.width / frame.height : null;
}

/** The largest rect of `aspect` (width over height) that fits in `box`, centered in it. */
export function fitRect(aspect: number, box: Rect): Rect {
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0 || aspect <= 0) return [x, y, 0, 0];
  const fitted = width / height > aspect ? [height * aspect, height] : [width, width / aspect];
  return [x + (width - fitted[0]) / 2, y + (height - fitted[1]) / 2, fitted[0], fitted[1]];
}

/**
 * The screen's rect `progress` of the way from `from` to `to`, then shrunk and moved down by an interactive
 * `drag` of `dismissDistance` points or more at most halfway.
 */
export function zoomRect(from: Rect, to: Rect, progress: number, drag: number, dismissDistance: number): Rect {
  'worklet';
  const lerp = (a: number, b: number) => a + (b - a) * progress;
  const width = lerp(from[2], to[2]);
  const height = lerp(from[3], to[3]);
  const pulled = Math.max(drag, 0);
  const scale = 1 - Math.min(pulled / dismissDistance, 1) * 0.5;
  const centerX = lerp(from[0], to[0]) + width / 2;
  const centerY = lerp(from[1], to[1]) + height / 2 + pulled;
  return [centerX - (width * scale) / 2, centerY - (height * scale) / 2, width * scale, height * scale];
}

/**
 * How far to move up a screen at `top` and `height` points so its bottom rests on `visibleBottom`, such as the
 * top of the keyboard, without its top rising above `minTop`: 0 when it already ends above `visibleBottom`.
 */
export function liftAbove(top: number, height: number, visibleBottom: number, minTop: number): number {
  'worklet';
  return Math.max(0, Math.min(top + height - visibleBottom, top - minTop));
}

/**
 * The offset, as a fraction of the view, that keeps a picture zoomed to `scale` covering its view: at most half
 * of what overflows on either side.
 */
export function clampOffset(offset: number, scale: number): number {
  'worklet';
  const limit = Math.max(scale - 1, 0) / 2;
  return Math.min(Math.max(offset, -limit), limit);
}

/**
 * The offset along one axis after zooming a picture from `scale` and `offset` to `nextScale`, as fractions of the
 * view, so the point that was under `focal` is under `nextFocal`. A picture at `scale` and `offset` starts at
 * `(1 - scale) / 2 + offset`.
 */
export function zoomOffset(
  scale: number,
  offset: number,
  nextScale: number,
  focal: number,
  nextFocal: number = focal,
): number {
  'worklet';
  const start = (1 - scale) / 2 + offset;
  const point = (focal - start) / scale;
  const nextStart = nextFocal - point * nextScale;
  return clampOffset(nextStart - (1 - nextScale) / 2, nextScale);
}
