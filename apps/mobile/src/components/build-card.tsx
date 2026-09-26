import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
import { Card } from '@/components/card';
import { useBuildPlans, useMacConnection } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { lastBuildSummary, nextBuild } from '@/lib/format';
import { planKey, type PlanState } from '@/lib/plan-checks';
import { runningBuild } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState, Platform } from '@/protocol/types';
import { useColors } from '@/theme';

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
  const colors = useColors();
  const router = useRouter();
  const macId = useMacConnection().mac?.id ?? '';
  const now = useNow(30_000);
  const last = env.lastBuilds?.[platform];
  const name = platform === 'ios' ? 'iOS' : 'Android';
  const building = build?.platform === platform;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/mac/[id]/build', params: { id: macId, path: env.path, platform } })}
      accessibilityRole="button"
      accessibilityHint={`Shows the details of the ${name} builds`}
    >
      {({ pressed }) => (
        <Card style={pressed && styles.pressed}>
          <View style={styles.platform}>
            {building ? (
              <BuildProgressBar build={build} />
            ) : (
              <View style={styles.header}>
                <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
                <Text style={[styles.name, { color: colors.tertiary }]}>{'\u203A'}</Text>
              </View>
            )}
            {last ? (
              <Text style={[styles.line, { color: last.status === 'failed' ? colors.error : colors.secondary }]}>
                {`Last: ${lastBuildSummary(last, now)}`}
              </Text>
            ) : building ? null : (
              <Text style={[styles.line, { color: colors.secondary }]}>No build recorded</Text>
            )}
            {building ? null : build ? (
              <Text style={[styles.line, { color: colors.tertiary }]}>Next: checked after the running build</Text>
            ) : (
              <NextBuild plan={plan} />
            )}
          </View>
        </Card>
      )}
    </Pressable>
  );
}

function NextBuild({ plan }: { plan: PlanState | undefined }) {
  const colors = useColors();
  if (plan?.kind === 'checking') {
    return (
      <View style={styles.row}>
        <ActivityIndicator size="small" color={colors.tertiary} />
        <Text style={[styles.line, { color: colors.tertiary }]}>{'Checking next build\u2026'}</Text>
      </View>
    );
  }
  if (plan?.kind === 'failed') {
    return <Text style={[styles.line, { color: colors.warn }]}>{`Cannot plan: ${plan.message}`}</Text>;
  }
  if (plan?.kind !== 'done') return null;
  return (
    <Text
      style={[styles.line, { color: plan.plan.refusal || plan.plan.cacheHit === false ? colors.warn : colors.live }]}
    >
      {`Next: ${nextBuild(plan.plan)}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  platform: { padding: 12, gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '600' },
  line: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pressed: { opacity: 0.6 },
});
