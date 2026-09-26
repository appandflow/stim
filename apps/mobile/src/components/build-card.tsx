import { useRouter } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { Text } from '@/components/text';
import { useBuildPlans, useMacConnection } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { lastBuildSummary, nextBuild } from '@/lib/format';
import { planKey, type PlanState } from '@/lib/plan-checks';
import { runningBuild } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState, Platform } from '@/protocol/types';

const PLATFORMS: Platform[] = ['ios', 'android'];

function usedPlatforms(env: EnvironmentState, build: BuildReport | null): Platform[] {
  return PLATFORMS.filter(
    (platform) =>
      build?.platform === platform ||
      env.lastBuilds?.[platform] ||
      env[platform] ||
      env.slots?.some((slot) => slot[platform]) ||
      env.remoteDevices?.some((remote) => remote.platform === platform),
  );
}

export function BuildCards({ env }: { env: EnvironmentState }) {
  const build = runningBuild(env);
  const used = usedPlatforms(env, build);
  const plan = useBuildPlans(
    env.path,
    Object.fromEntries(used.map((platform) => [platform, planKey(env.lastBuilds?.[platform])])),
    build !== null,
  );
  return (used.length ? used : PLATFORMS).map((platform) => (
    <PlatformCard key={platform} env={env} platform={platform} plan={plan(platform)} build={build} />
  ));
}

function PlatformCard({
  env,
  platform,
  plan,
  build,
}: {
  env: EnvironmentState;
  platform: Platform;
  plan: PlanState | undefined;
  build: BuildReport | null;
}) {
  const router = useRouter();
  const macId = useMacConnection().mac?.id ?? '';
  const now = useNow(30_000);
  const last = env.lastBuilds?.[platform];
  const name = platform === 'ios' ? 'iOS' : 'Android';
  const building = build?.platform === platform;
  return (
    <Card
      onPress={() => router.push({ pathname: '/mac/[id]/build', params: { id: macId, path: env.path, platform } })}
      accessibilityHint={`Shows the details of the ${name} builds`}
    >
      <View style={styles.platform}>
        {building ? (
          <BuildProgressBar build={build} />
        ) : (
          <View style={styles.header}>
            <Text variant="callout" weight="semibold">
              {name}
            </Text>
            <Text variant="callout" weight="semibold" tone="tertiary">
              {'\u203A'}
            </Text>
          </View>
        )}
        {last ? (
          <Text variant="footnote" tone={last.status === 'failed' ? 'error' : 'secondary'}>
            {`Last: ${lastBuildSummary(last, now)}`}
          </Text>
        ) : building ? null : (
          <Text variant="footnote" tone="secondary">
            No build recorded
          </Text>
        )}
        {building ? null : build ? (
          <Text variant="footnote" tone="tertiary">
            Next: checked after the running build
          </Text>
        ) : (
          <NextBuild plan={plan} />
        )}
      </View>
    </Card>
  );
}

function NextBuild({ plan }: { plan: PlanState | undefined }) {
  const { theme } = useUnistyles();
  if (plan?.kind === 'checking') {
    return (
      <View style={styles.row}>
        <ActivityIndicator size="small" color={theme.colors.tertiary} />
        <Text variant="footnote" tone="tertiary">
          {'Checking next build\u2026'}
        </Text>
      </View>
    );
  }
  if (plan?.kind === 'failed') {
    return <Text variant="footnote" tone="warning">{`Cannot plan: ${plan.message}`}</Text>;
  }
  if (plan?.kind !== 'done') return null;
  return (
    <Text variant="footnote" tone={plan.plan.refusal || plan.plan.cacheHit === false ? 'warning' : 'success'}>
      {`Next: ${nextBuild(plan.plan)}`}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  platform: { padding: theme.space.lg, gap: theme.space.xs },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
}));
