import { Image } from 'expo-image';
import { Platform, Text } from 'react-native';

const ANDROID_GLYPHS = {
  plus: '+',
  laptopcomputer: '\u25AD',
  xmark: '\u2715',
  checkmark: '\u2713',
  'chevron.right': '\u203A',
  eye: '\u25C9',
  'eye.slash': '\u25CE',
  'rectangle.stack': '\u2261',
  'square.grid.2x2': '\u25A6',
  'arrow.triangle.branch': '\u2442',
} as const;

export type IconName = keyof typeof ANDROID_GLYPHS;

/** An SF Symbol on iOS; Android has no SF Symbols and gets a text glyph of the same size. */
export function Icon({ name, size, color }: { name: IconName; size: number; color: string }) {
  if (Platform.OS === 'ios') {
    return <Image source={`sf:${name}`} tintColor={color} style={{ width: size, height: size }} contentFit="contain" />;
  }
  return (
    <Text style={{ fontSize: size * 0.9, lineHeight: size, color, textAlign: 'center', width: size }}>
      {ANDROID_GLYPHS[name]}
    </Text>
  );
}
