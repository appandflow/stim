export function canTilt(
  bounds: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: (0.5 - (clientY - bounds.top) / bounds.height) * 12,
    y: ((clientX - bounds.left) / bounds.width - 0.5) * 12,
  };
}
