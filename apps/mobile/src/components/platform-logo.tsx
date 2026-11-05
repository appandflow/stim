import { Image } from 'expo-image';

export type LogoPlatform = 'ios' | 'android' | 'web';

const LOGOS: Record<LogoPlatform, { viewBox: string; body: (color: string) => string }> = {
  ios: {
    viewBox: '0 0 24 26',
    body: (color) =>
      `<path fill="${color}" d="M16.4 1.5c.1 1.3-.4 2.6-1.2 3.5-.8.9-2 1.6-3.2 1.5-.2-1.2.4-2.5 1.2-3.4.8-.9 2.1-1.6 3.2-1.6zM20.6 18.6c-.6 1.3-.9 1.9-1.6 3-1 1.5-2.4 3.4-4.2 3.4-1.6 0-2-1-4.1-1-2.1 0-2.6 1-4.2 1-1.8 0-3.1-1.7-4.1-3.2C-.4 17.6-.7 12.6 1 10c1.2-1.8 3.1-2.9 4.9-2.9 1.8 0 3 1 4.5 1 1.5 0 2.4-1 4.5-1 1.6 0 3.3.9 4.5 2.4-4 2.2-3.3 7.8 1.2 9.1z"/>`,
  },
  android: {
    viewBox: '0 0 26 22',
    body: (color) =>
      `<path fill="${color}" d="M2 21a11 11 0 0 1 22 0z"/><path d="M6.5 5.5 4 1.5M19.5 5.5 22 1.5" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  web: {
    viewBox: '0 0 24 24',
    body: (color) =>
      `<g fill="none" stroke="${color}" stroke-width="2"><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4.5" ry="10"/><path d="M2 12h20"/></g>`,
  },
};

function uri(platform: LogoPlatform, color: string): string {
  const { viewBox, body } = LOGOS[platform];
  return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body(color)}</svg>`)}`;
}

/** The mark of a platform, drawn from SVG on both platforms since SF Symbols has no Android or web logo. */
export function PlatformLogo({ platform, size, color }: { platform: LogoPlatform; size: number; color: string }) {
  return <Image source={{ uri: uri(platform, color) }} style={{ width: size, height: size }} contentFit="contain" />;
}
