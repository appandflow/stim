import { useWindowDimensions } from 'react-native';

const LARGE_FONT_SCALE = 1.3;

export function useLargeText(): boolean {
  return useWindowDimensions().fontScale > LARGE_FONT_SCALE;
}
