import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BuildProgressBar } from '@/components/build-progress';
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
  const { plan, recheck } = useBuildPlans(
    env.path,
    Object.fromEntries(used.map((platform) => [platform, planKey(env.lastBuilds?.[platform])])),
    build !== null,
  );
  return (used.length ? used : PLATFORMS).map((platform) => (
    <Card key={platform}>
      <View style={styles.platform}>
        <PlatformBuild env={env} platform={platform} plan={plan(platform)} build={build} recheck={recheck} />
      </View>
    </Card>
  ));
}

function PlatformBuild({
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
  const building = build?.platform === platform;
  const disabled = !recheck || plan?.kind === 'checking';
  const openReason = (next: boolean) =>
    router.push({
      pathname: '/mac/[id]/build-miss',
      params: { id: macId, path: env.path, platform, ...(next ? { next: '1' } : {}) },
    });
  return (
    <>
      {building ? (
        <BuildProgressBar build={build} />
      ) : (
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
      )}
      {last ? (
        <Disclosure
          label={`Last ${name} build: ${lastBuildSummary(last, now)}`}
          hint={last.missReason ? 'Shows why it missed the cache' : null}
          onPress={() => openReason(false)}
        >
          <Text style={[styles.line, { color: last.status === 'failed' ? colors.error : colors.secondary }]}>
            {`Last: ${lastBuildSummary(last, now)}`}
          </Text>
        </Disclosure>
      ) : building ? null : (
        <Text style={[styles.line, { color: colors.secondary }]}>No build recorded</Text>
      )}
      {building ? null : build ? (
        <Text style={[styles.line, { color: colors.tertiary }]}>Next: checked after the running build</Text>
      ) : (
        <NextBuild plan={plan} name={name} openReason={() => openReason(true)} />
      )}
    </>
  );
}

function Disclosure({
  label,
  hint,
  onPress,
  children,
}: {
  label: string;
  hint: string | null;
  onPress: () => void;
  children: ReactNode;
}) {
  const colors = useColors();
  if (!hint) return <>{children}</>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={6}
      style={styles.row}
    >
      <View style={styles.grow}>{children}</View>
      <Text style={[styles.line, { color: colors.tertiary }]}>{'\u203A'}</Text>
    </Pressable>
  );
}

function NextBuild({ plan, name, openReason }: { plan: PlanState | undefined; name: string; openReason: () => void }) {
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
    return (
      <Text style={[styles.line, { color: colors.warn }]} selectable>
        {`Cannot plan: ${plan.message}`}
      </Text>
    );
  }
  if (plan?.kind !== 'done') return null;
  const detail = planDetail(plan.plan);
  const miss = plan.plan.missReason;
  const next = (
    <Text
      style={[styles.line, { color: plan.plan.refusal || plan.plan.cacheHit === false ? colors.warn : colors.live }]}
    >
      {`Next: ${nextBuild(plan.plan)}`}
    </Text>
  );
  return (
    <>
      {miss ? (
        <Disclosure
          label={`Next ${name} build: ${nextBuild(plan.plan)}`}
          hint="Shows the changed sources"
          onPress={openReason}
        >
          {next}
        </Disclosure>
      ) : (
        next
      )}
      {detail ? <Text style={[styles.detail, { color: colors.tertiary }]}>{detail}</Text> : null}
      {plan.plan.refusal ? (
        <Text style={[styles.line, { color: colors.secondary }]} selectable>
          {`${plan.plan.refusal.message} ${plan.plan.refusal.remedy}`}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  platform: { padding: 12, gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: 14, fontWeight: '600' },
  line: { fontSize: 13, lineHeight: 18 },
  detail: { fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grow: { flexShrink: 1, flexGrow: 1 },
});
