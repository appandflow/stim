import { Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, useColorScheme, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Banner } from '@/components/banner';
import { Button, IconButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { ListRow, ListSection } from '@/components/list';
import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { useSettings } from '@/hooks/settings';
import { text } from '@/design/tokens';

const noop = () => {};

function Components() {
  const { theme } = useUnistyles();
  const [loading, setLoading] = useState(false);
  return (
    <View style={styles.column}>
      <View style={styles.group}>
        {(Object.keys(text) as (keyof typeof text)[]).map((variant) => (
          <Text key={variant} variant={variant}>
            {variant}
          </Text>
        ))}
        <View style={styles.row}>
          {(['secondary', 'tertiary', 'brand', 'success', 'warning', 'error', 'info'] as const).map((tone) => (
            <Text key={tone} variant="footnote" tone={tone}>
              {tone}
            </Text>
          ))}
        </View>
        <Text variant="footnote" mono>
          mono :8081
        </Text>
      </View>

      <View style={styles.row}>
        <Button title="Primary" onPress={noop} />
        <Button title="Secondary" variant="secondary" onPress={noop} />
      </View>
      <View style={styles.row}>
        <Button title="Small" size="small" icon="plus" onPress={noop} />
        <Button
          title="Loading"
          size="small"
          variant="secondary"
          loading={loading}
          onPress={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1500);
          }}
        />
        <Button title="Disabled" size="small" disabled onPress={noop} />
        <Button title="Plain" variant="plain" size="small" onPress={noop} />
        <Button title="Forget" variant="destructive" size="small" onPress={noop} />
      </View>
      <View style={styles.row}>
        <IconButton icon="gearshape" accessibilityLabel="Settings" onPress={noop} />
        <IconButton icon="plus" tone="brand" accessibilityLabel="Add" onPress={noop} />
        <IconButton icon="xmark" tone="default" size="large" accessibilityLabel="Close" onPress={noop} />
      </View>

      <View style={styles.row}>
        <Pill>2.1 GB</Pill>
        <Pill tone="accent">merged</Pill>
        <Pill tone="success" tabular=":8081">
          {'Metro '}
        </Pill>
        <Pill tone="warning" dot>
          1 warning
        </Pill>
        <Pill tone="error" onPress={noop}>
          3 errors
        </Pill>
        <Pill tone="info" icon="cpu">
          EAS session
        </Pill>
        <StatusDot color={theme.colors.success} />
      </View>

      <Banner message="Connecting" variant="attached" />
      <Banner message="Connection refused. Pair this machine again." tone="error" variant="attached" />
      <Banner
        message="This phone is read-only: it cannot reload or stop workspaces."
        action={{ label: 'Allow control', onPress: noop }}
      />
      <Banner message="Screen updates delayed." tone="warning" />

      <ListSection title="Capacity" footer="Stim's share counts what live workspaces commit.">
        <ListRow title="Live workspaces" value="4" />
        <ListRow title="Memory pressure" value="warn" valueTone="warning" />
        <ListRow
          title="Mock Mac"
          subtitle="ws://127.0.0.1:7811"
          icon="laptopcomputer"
          accessory="chevron"
          onPress={noop}
        />
        <ListRow title="Scope" accessory={<Pill tone="success">Can control</Pill>} />
      </ListSection>

      <View style={styles.empty}>
        <EmptyState title="No workspaces" message="Start one with stim start." />
      </View>
    </View>
  );
}

/**
 * Every shared component, for review and screenshots. Development builds only. The header button switches the app's
 * Appearance setting, the same path Settings uses.
 */
export function Gallery() {
  const { setAppearance } = useSettings();
  const next = useColorScheme() === 'dark' ? 'light' : 'dark';
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen
        options={{
          title: 'Components',
          headerRight: () => (
            <Button
              title={next === 'dark' ? 'Dark' : 'Light'}
              variant="plain"
              size="small"
              onPress={() => setAppearance(next)}
            />
          ),
        }}
      />
      <Components />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, paddingBottom: theme.space.huge },
  column: { gap: theme.space.xl },
  group: { gap: theme.space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.md },
  empty: { height: 160, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.card },
}));
