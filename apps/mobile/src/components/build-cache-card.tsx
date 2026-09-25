import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { useBuildPlan, type PlanState } from '@/hooks/mac-connection';
import { lastBuildSummary, planExpectation, planSummary } from '@/lib/format';
import type { EnvironmentState, Platform } from '@/protocol/types';
import { useColors } from '@/theme';

const PLATFORMS: Platform[] = ['ios', 'android'];

function platformsOf(env: EnvironmentState): Platform[] {
  const used = PLATFORMS.filter(
    (platform) =>
      env.lastBuilds?.[platform] ||
      env[platform] ||
      env.slots?.some((slot) => slot[platform]) ||
      env.remoteDevices?.some((remote) => remote.platform === platform),
  );
  return used.length ? used : PLATFORMS;
}

export function BuildCacheCard({ env }: { env: EnvironmentState }) {
  const { plans, check } = useBuildPlan(
    env.path,
    PLATFORMS.map((platform) => env.lastBuilds?.[platform]?.startedAt ?? '').join('\n'),
  );
  return (
    <Card>
      <View style={styles.card}>
        {platformsOf(env).map((platform) => (
          <PlatformBuilds key={platform} env={env} platform={platform} plan={plans[platform]} check={check} />
        ))}
      </View>
    </Card>
  );
}

function PlatformBuilds({
  env,
  platform,
  plan,
  check,
}: {
  env: EnvironmentState;
  platform: Platform;
  plan: PlanState | undefined;
  check: (platform: Platform) => void;
}) {
  const colors = useColors();
  const last = env.lastBuilds?.[platform];
  const name = platform === 'ios' ? 'iOS' : 'Android';
  return (
    <View style={styles.platform}>
      <View style={styles.header}>
        <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
        <Pressable
          onPress={() => check(platform)}
          disabled={plan?.kind === 'checking'}
          accessibilityRole="button"
          accessibilityLabel={`Check the next ${name} build`}
          hitSlop={6}
        >
          <Text style={[styles.action, { color: plan?.kind === 'checking' ? colors.tertiary : colors.primary }]}>
            Check next build
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.line, { color: last?.status === 'failed' ? colors.error : colors.secondary }]}>
        {last ? `Last: ${lastBuildSummary(last)}` : 'No build recorded'}
      </Text>
      {plan?.kind === 'checking' ? <ActivityIndicator style={styles.spinner} color={colors.primary} /> : null}
      {plan?.kind === 'failed' ? (
        <Text style={[styles.line, { color: colors.warn }]} selectable>
          {`Cannot plan: ${plan.message}`}
        </Text>
      ) : null}
      {plan?.kind === 'done' ? (
        <>
          <Text
            style={[
              styles.line,
              { color: plan.plan.refusal || plan.plan.cacheHit === false ? colors.warn : colors.live },
            ]}
          >
            {`Next: ${planSummary(plan.plan)}`}
          </Text>
          {planExpectation(plan.plan) ? (
            <Text style={[styles.line, { color: colors.secondary }]}>{planExpectation(plan.plan)}</Text>
          ) : null}
          {plan.plan.refusal ? (
            <Text style={[styles.line, { color: colors.secondary }]} selectable>
              {`${plan.plan.refusal.message} ${plan.plan.refusal.remedy}`}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, gap: 12 },
  platform: { gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '600' },
  action: { fontSize: 13, fontWeight: '600' },
  line: { fontSize: 13, lineHeight: 18 },
  spinner: { alignSelf: 'flex-start' },
});
