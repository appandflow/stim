import { Host } from '@expo/ui';
import { Rectangle } from '@expo/ui/swift-ui';
import { foregroundStyle, ignoreSafeArea } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

export function ViewerBackdrop() {
  return (
    <Host style={StyleSheet.absoluteFill} colorScheme="dark" pointerEvents="none">
      <Rectangle modifiers={[foregroundStyle({ type: 'material', material: 'thin' }), ignoreSafeArea()]} />
    </Host>
  );
}
