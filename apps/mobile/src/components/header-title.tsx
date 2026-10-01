import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';

export function HeaderTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.headerTitle}>
      <Text variant="headline" numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={2}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="caption" tone="secondary" style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  headerTitle: { alignItems: 'center', maxWidth: 240 },
  subtitle: { marginTop: 1 },
}));
