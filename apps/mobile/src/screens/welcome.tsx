import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';

const WORDMARK = require('@/assets/images/wordmark.png');
const TAILSCALE_STORE = Platform.select({
  ios: 'https://apps.apple.com/app/tailscale/id1470499037',
  default: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
});

export function Welcome({ dismiss }: { dismiss: () => void }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.intro}>
          <Image
            source={WORDMARK}
            tintColor={theme.colors.primary}
            style={styles.wordmark}
            contentFit="contain"
            accessibilityLabel={t`Stim`}
          />
          <Text variant="title" accessibilityRole="header">
            <Trans>Watch your agents&apos; apps from your phone</Trans>
          </Text>
        </View>
        <View style={styles.requirements}>
          <Text variant="headline" accessibilityRole="header">
            <Trans>You need</Trans>
          </Text>
          <WelcomeStep number={1} title={t`Tailscale on this phone`}>
            <Button
              title={t`Get Tailscale`}
              variant="secondary"
              size="small"
              onPress={() => void Linking.openURL(TAILSCALE_STORE)}
              style={styles.stepButton}
            />
          </WelcomeStep>
          <WelcomeStep number={2} title={t`Stim Desktop on your Mac, with Serve to phones on`}>
            <Touch
              accessibilityRole="link"
              accessibilityLabel={t`stim.appandflow.com/desktop`}
              onPress={() => void Linking.openURL('https://stim.appandflow.com/desktop')}
              style={styles.link}
            >
              <Text tone="brand">stim.appandflow.com/desktop</Text>
            </Touch>
          </WelcomeStep>
          <WelcomeStep number={3} title={t`Both signed in to the same tailnet`} />
        </View>
        <View style={styles.actions}>
          <Button title={t`Pair with your Mac`} onPress={() => router.push('/pair')} />
          <Button title={t`Not now`} variant="plain" onPress={dismiss} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function WelcomeStep({ number, title, children }: { number: number; title: string; children?: ReactNode }) {
  return (
    <View style={styles.step}>
      <Text variant="headline" tone="brand">
        {number}.
      </Text>
      <View style={styles.stepBody}>
        <Text variant="body">{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { flexGrow: 1, padding: theme.space.xxxl, gap: theme.space.huge },
  intro: { gap: theme.space.xxl },
  wordmark: { width: 84, height: 40 },
  requirements: { gap: theme.space.xxl },
  step: { flexDirection: 'row', gap: theme.space.lg },
  stepBody: { flex: 1, gap: theme.space.md },
  stepButton: { alignSelf: 'flex-start' },
  link: { paddingVertical: theme.space.sm },
  actions: { gap: theme.space.xxl, marginTop: 'auto', paddingTop: theme.space.lg },
}));
