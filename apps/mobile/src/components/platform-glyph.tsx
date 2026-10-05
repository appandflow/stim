import { Image } from 'expo-image';
import { Platform as OS } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';

const APPLE_PATH =
  'M16.4 1.5c.1 1.3-.4 2.6-1.2 3.5-.8.9-2 1.6-3.2 1.5-.2-1.2.4-2.5 1.2-3.4.8-.9 2.1-1.6 3.2-1.6zM20.6 18.6c-.6 1.3-.9 1.9-1.6 3-1 1.5-2.4 3.4-4.2 3.4-1.6 0-2-1-4.1-1-2.1 0-2.6 1-4.2 1-1.8 0-3.1-1.7-4.1-3.2C-.4 17.6-.7 12.6 1 10c1.2-1.8 3.1-2.9 4.9-2.9 1.8 0 3 1 4.5 1 1.5 0 2.4-1 4.5-1 1.6 0 3.3.9 4.5 2.4-4 2.2-3.3 7.8 1.2 9.1z';

function appleSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 26"><path fill="${color}" d="${APPLE_PATH}"/></svg>`;
}

function androidSvg(color: string, background: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 22"><path fill="${color}" d="M2 21a11 11 0 0 1 22 0z"/><path d="M6.5 5.5 4 1.5M19.5 5.5 22 1.5" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/><circle cx="8.5" cy="14.5" r="1.4" fill="${background}"/><circle cx="17.5" cy="14.5" r="1.4" fill="${background}"/></svg>`;
}

const svgUri = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;

export function PlatformGlyph({
  platform,
  size,
  color,
  background,
}: {
  platform: string;
  size: number;
  color?: string;
  background?: string;
}) {
  const { theme } = useUnistyles();
  const tint = color ?? theme.colors.text;
  if (platform === 'ios') {
    const style = { width: size * (24 / 26), height: size };
    return OS.OS === 'ios' ? (
      <Image source="sf:apple.logo" tintColor={tint} style={style} contentFit="contain" />
    ) : (
      <Image source={{ uri: svgUri(appleSvg(tint)) }} style={style} contentFit="contain" />
    );
  }
  if (platform !== 'android') return <Icon name="gearshape" size={size} color={tint} />;
  return (
    <Image
      source={{ uri: svgUri(androidSvg(tint, background ?? theme.colors.surface)) }}
      style={{ width: size * (26 / 22), height: size }}
      contentFit="contain"
    />
  );
}
