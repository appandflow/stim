type Layer = { nm?: string };

/** Keeps the Stim build animation's layers for one platform, matching Stim Desktop's `StimBuildAnimation`. */
export function buildAnimationLayers<T extends Layer>(layers: T[], platform: string): T[] {
  const item = ['ios', 'android', 'macos', 'web'].includes(platform) ? platform : 'cube';
  const screen = platform === 'ios' || platform === 'android' ? 'screen-rn' : null;
  return layers.filter(({ nm = '' }) => {
    if (nm.startsWith('item-')) return nm.startsWith(`item-${item}-`);
    if (nm.startsWith('screen-')) return nm === screen;
    return true;
  });
}
