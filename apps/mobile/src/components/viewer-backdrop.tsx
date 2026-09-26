import { StyleSheet, View } from 'react-native';

import { useColors } from '@/theme';

export function ViewerBackdrop() {
  const colors = useColors();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: `${colors.screen}E6` }]} pointerEvents="none" />;
}
