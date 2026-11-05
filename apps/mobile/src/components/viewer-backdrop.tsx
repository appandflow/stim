import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { withAlpha } from '@/design/color';

export function ViewerBackdrop() {
  return <View style={styles.backdrop} pointerEvents="none" />;
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha(theme.media.screen, theme.opacity.backdrop),
  },
}));
