import { t } from '@lingui/core/macro';
import * as Linking from 'expo-linking';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { LICENSES } from '@/lib/licenses';

export function License({ index }: { index: number }) {
  const entry = LICENSES[index];
  if (!entry) return null;
  const { url } = entry;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen options={{ title: entry.name }} />
      <Text variant="title">{entry.name}</Text>
      <Text variant="footnote" tone="secondary">
        {`${entry.version} - ${entry.license}`}
      </Text>
      {url ? <Button title={t`Open repository`} variant="secondary" onPress={() => void Linking.openURL(url)} /> : null}
      <Text variant="footnote" mono selectable>
        {entry.text ?? t`This package does not include a license file.`}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { backgroundColor: theme.colors.background },
  content: { padding: theme.space.xxl, gap: theme.space.xl },
}));
