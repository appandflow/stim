import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { useBuildPlans, useMacConnection } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { lastBuildSummary, nextBuild, planDetail } from '@/lib/format';
import { planKey, type PlanState } from '@/lib/plan-checks';
import { runningBuild } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState, Platform } from '@/protocol/types';
import { useColors } from '@/theme';

const PLATFORMS: Platform[] = ['ios', 'android'];

function usedPlatforms(env: EnvironmentState): Platform[] {
  return PLATFORMS.filter(
    (platform) =>
      env.lastBuilds?.[platform] ||
      env[platform] ||
      env.slots?.some((slot) => slot[platform]) ||
      env.remoteDevices?.some((remote) => remote.platform === platform),
  );
}

export function BuildCacheCard({ env }: { env: EnvironmentState }) {
  const used = usedPlatforms(env);
  const build = runningBuild(env);
  const { plan, recheck } = useBuildPlans(
    env.path,
    Object.fromEntries(used.map((platform) => [platform, planKey(env.lastBuilds?.[platform])])),
    build !== null,
  );
  return (
    <Card>
      <View style={styles.card}>
        {(used.length ? used : PLATFORMS).map((platform) => (
          <PlatformBuilds
            key={platform}
            env={env}
            platform={platform}
            plan={plan(platform)}
            build={build}
            recheck={recheck}
          />
        ))}
      </View>
    </Card>
  );
}

function PlatformBuilds({
  env,
  platform,
  plan,
  build,
  recheck,
}: {
  env: EnvironmentState;
  platform: Platform;
  plan: PlanState | undefined;
  build: BuildReport | null;
  recheck: ((platform: Platform) => void) | null;
}) {
  const colors = useColors();
  const router = useRouter();
  const macId = useMacConnection().mac?.id ?? '';
  const now = useNow(30_000);
  const last = env.lastBuilds?.[platform];
  const name = platform === 'ios' ? 'iOS' : 'Android';
  const disabled = !recheck || plan?.kind === 'checking';
  return (
    <View style={styles.platform}>
      <View style={styles.header}>
        <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
        <Pressable
          onPress={() => recheck?.(platform)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Check the next ${name} build again`}
          hitSlop={10}
        >
          <Icon name="arrow.clockwise" size={15} color={disabled ? colors.tertiary : colors.primary} />
        </Pressable>
      </View>
      <Text style={[styles.line, { color: last?.status === 'failed' ? colors.error : colors.secondary }]}>
        {last ? `Last: ${lastBuildSummary(last, now)}` : 'No build recorded'}
      </Text>
      {last?.missReason ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/mac/[id]/build-miss', params: { id: macId, path: env.path, platform } })
          }
          accessibilityRole="button"
          accessibilityLabel={`Why the last ${name} build missed the cache`}
          hitSlop={6}
          style={styles.reason}
        >
          <Text style={[styles.line, styles.reasonText, { color: colors.warn }]} numberOfLines={1}>
            {`Why: ${last.missReason.summary}`}
          </Text>
          <Text style={[styles.line, { color: colors.tertiary }]}>{'\u203A'}</Text>
        </Pressable>
      ) : null}
      {build ? (
        <Text style={[styles.line, { color: colors.tertiary }]}>
          {build.platform === platform ? 'Building now' : 'Next build: checked after the running build'}
        </Text>
      ) : (
        <NextBuild plan={plan} />
      )}
    </View>
  );
}

function NextBuild({ plan }: { plan: PlanState | undefined }) {
  const colors = useColors();
  if (plan?.kind === 'checking') {
    return (
      <View style={styles.checking}>
        <ActivityIndicator size="small" color={colors.tertiary} />
        <Text style={[styles.line, { color: colors.tertiary }]}>{'Checking next build\u2026'}</Text>
      </View>
    );
  }
  if (plan?.kind === 'failed') {
    return (
      <Text style={[styles.line, { color: colors.warn }]} selectable>
        {`Cannot plan: ${plan.message}`}
      </Text>
    );
  }
  if (plan?.kind !== 'done') return null;
  const detail = planDetail(plan.plan);
  return (
    <>
      <Text
        style={[styles.line, { color: plan.plan.refusal || plan.plan.cacheHit === false ? colors.warn : colors.live }]}
      >
        {`Next build: ${nextBuild(plan.plan)}`}
      </Text>
      {detail ? <Text style={[styles.line, { color: colors.tertiary }]}>{detail}</Text> : null}
      {plan.plan.refusal ? (
        <Text style={[styles.line, { color: colors.secondary }]} selectable>
          {`${plan.plan.refusal.message} ${plan.plan.refusal.remedy}`}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, gap: 12 },
  platform: { gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '600' },
  line: { fontSize: 13, lineHeight: 18 },
  checking: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reasonText: { flexShrink: 1 },
});
