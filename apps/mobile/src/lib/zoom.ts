/** A rectangle as `[x, y, width, height]`, the shape Reanimated animates as one value. */
export type Rect = [number, number, number, number];

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
