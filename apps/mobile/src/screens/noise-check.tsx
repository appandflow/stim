import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { createNoiseCheck } from 'react-native-stim-session';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/text';

const SIZES = [
  { bytes: 16 * 1024, count: 4000 },
  { bytes: 64 * 1024, count: 2000 },
  { bytes: 1024 * 1024, count: 200 },
];

/**
 * Development only, at stim://noise-check: measures the native session's decryption, header parsing and routing
 * of video messages to a VideoStream with no view.
 */
export function NoiseCheck() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const check = createNoiseCheck();
    const timeout = setTimeout(
      () =>
        setLines(
          SIZES.map(({ bytes, count }) => {
            const { megabytesPerSecond } = check.measureThroughput(bytes, count);
            return `${bytes / 1024} KiB x ${count}: ${megabytesPerSecond.toFixed(0)} MB/s`;
          }),
        ),
      0,
    );
    return () => clearTimeout(timeout);
  }, []);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text variant="headline">Noise throughput</Text>
      {lines.map((line) => (
        <Text key={line} variant="footnote" mono>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, gap: theme.space.md },
}));
