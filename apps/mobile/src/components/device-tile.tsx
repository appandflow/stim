import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { STAT_ICON } from '@/components/machine-stats';
import { Pill, StatusDot } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useFrame, useMacConnection } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { useAgentActions } from '@/hooks/workspace-logs';
import { formatBytes } from '@/lib/home';
import { tildeHome } from '@/lib/paths';
import { agentRow, currentPhaseLabel, deviceTitle, formatCpu, formatMemoryMb, type Usage } from '@/lib/workspace-view';
import { platformName, runningBuild, type DeviceRef } from '@/lib/workspaces';
import type { BuildReport, EnvironmentState } from '@/protocol/types';

const SCREEN_HEIGHT = 480;
const SCREEN_PADDING = 12;

export function DeviceTile({
  env,
  device,
  warnings,
  usage,
}: {
  env: EnvironmentState;
  device: DeviceRef;
  warnings: string[];
  usage: Usage | null;
}) {
  const { theme } = useUnistyles();
  const { home, mac } = useMacConnection();
  const workspace = env.path;
  const [screenWidth, setScreenWidth] = useState(0);
  const streams = device.running && device.owned && !device.physical;
  const { frame, error, delayed } = useFrame(workspace, device.platform, device.slot, streams);
  const thumbnail = useRef<ViewInstance>(null);
  const target = { macId: mac?.id ?? '', workspace, platform: device.platform, slot: device.slot };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const build = device.platform === 'web' ? null : runningBuild(env, device);
  const appClosed = device.running && device.app?.state === 'stopped';
  const lastBuild = device.platform === 'web' ? undefined : env.lastBuilds?.[device.platform];
  const noApp = device.running && !device.app && lastBuild?.status === 'failed';
  const title = deviceTitle(device);
  const dot = !device.running
    ? theme.colors.tertiary
    : build
      ? theme.colors.primary
      : appClosed
        ? theme.colors.error
        : noApp
          ? theme.colors.tertiary
          : theme.colors.success;
  const notes = warnings.map((warning) => (
    <Text key={warning} variant="caption" tone="warning" style={styles.note}>
      {tildeHome(warning, home)}
    </Text>
  ));
  const header = (
    <View style={styles.header}>
      <StatusDot color={dot} filled={device.running} />
      <Text variant="callout" weight="semibold" numberOfLines={1} style={styles.name}>
        {title.name}
      </Text>
      <Text variant="caption" tone="tertiary" numberOfLines={1} ellipsizeMode="middle" style={styles.shrink}>
        {title.detail}
      </Text>
      <View style={styles.spacer} />
      {usage ? <UsageStats usage={usage} /> : null}
    </View>
  );
  if (!device.running) {
    return (
      <Card>
        {header}
        <Text variant="footnote" tone="tertiary" style={styles.stateLine}>
          {device.platform === 'web' ? 'Closed' : `Not running \u00B7 ${device.state}`}
        </Text>
        {notes.length ? <View style={styles.notes}>{notes}</View> : null}
      </Card>
    );
  }
  const pills = [
    device.page?.error ? (
      <Pill key="page" tone="warning">
        Page failed to load
      </Pill>
    ) : null,
    streams && frame?.posture ? <Pill key="posture">{frame.posture === 'folded' ? 'Folded' : 'Unfolded'}</Pill> : null,
    streams && delayed ? (
      <Pill key="delayed" tone="warning">
        Screen updates delayed
      </Pill>
    ) : null,
  ].filter(Boolean);
  const fallbackAspect = device.platform === 'web' ? 1.6 : device.platform === 'ios' ? 0.46 : 0.45;
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : fallbackAspect;
  const imageHeight = Math.min(SCREEN_HEIGHT - SCREEN_PADDING * 2, (screenWidth - SCREEN_PADDING * 2) / aspect);
  const placeholder = build ? (
    <BuildPlaceholder name={platformName(build.platform)} build={build} />
  ) : noApp ? (
    <Placeholder title="No app installed" subtitle="Fix the build and run it again" />
  ) : !streams ? (
    <Placeholder title="No live screen" subtitle="Frames are only served for devices Stim owns." />
  ) : null;
  return (
    <Card>
      {header}
      {pills.length ? <View style={styles.badges}>{pills}</View> : null}
      {device.page?.error ? (
        <Text variant="caption" tone="warning" style={styles.note} numberOfLines={2}>
          {device.page.error}
        </Text>
      ) : null}
      {notes.length ? <View style={styles.notes}>{notes}</View> : null}
      {placeholder ?? (
        <View
          onLayout={(event) => setScreenWidth(event.nativeEvent.layout.width)}
          style={[styles.screen, frame && screenWidth > 0 && { height: imageHeight + SCREEN_PADDING * 2 }]}
        >
          {frame ? (
            <Touch
              ref={thumbnail}
              onPress={() => mac && openDeviceViewer(thumbnail.current, target, frame)}
              accessibilityLabel={`Open the live screen of ${device.name}${appClosed ? ', app closed' : ''}`}
            >
              <Image
                source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
                style={[
                  { height: Math.max(imageHeight, 0), aspectRatio: aspect, borderRadius: theme.radius.small },
                  zoomedAway ? styles.away : appClosed ? styles.dimmed : null,
                ]}
                contentFit="contain"
                transition={0}
                accessibilityLabel={`Latest frame of ${device.name}`}
              />
              {appClosed && !zoomedAway ? (
                <View style={styles.closed} pointerEvents="none">
                  <Text variant="footnote" weight="semibold" style={styles.closedText}>
                    App closed
                  </Text>
                </View>
              ) : null}
            </Touch>
          ) : (
            <Text variant="footnote" style={styles.waiting}>
              {error ?? 'Waiting for frames'}
            </Text>
          )}
        </View>
      )}
      {streams && device.id ? <AgentRow env={env} device={device} deviceId={device.id} /> : null}
    </Card>
  );
}

function UsageStats({ usage }: { usage: Usage }) {
  const { theme } = useUnistyles();
  const parts = [
    usage.cpuPercent === null ? null : { kind: 'cpu' as const, value: formatCpu(usage.cpuPercent) },
    usage.memoryMb === null ? null : { kind: 'memory' as const, value: formatMemoryMb(usage.memoryMb) },
    usage.diskBytes === null ? null : { kind: 'disk' as const, value: formatBytes(usage.diskBytes) },
  ].filter((part) => part !== null);
  return (
    <View style={styles.usage}>
      {parts.map((part) => (
        <View key={part.kind} style={styles.usageItem}>
          <Icon name={STAT_ICON[part.kind]} size={11} color={theme.colors.secondary} />
          <Text variant="caption" tone="secondary" style={styles.tabular} numberOfLines={1}>
            {part.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Placeholder({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <View style={styles.placeholder}>
      <Text variant="callout" tone="secondary" style={styles.center}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="caption" tone="tertiary" style={styles.center}>
          {subtitle}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

function BuildPlaceholder({ name, build }: { name: string; build: BuildReport }) {
  const { phase, counts } = currentPhaseLabel(build);
  return (
    <Placeholder title={`Waiting for the ${name} build`} subtitle={[phase, counts].filter(Boolean).join(' \u00B7 ')} />
  );
}

export function WarmingPlaceholder({ subtitle }: { subtitle: string | null }) {
  return (
    <Card>
      <View style={styles.warming}>
        <Placeholder title="Warming the workspace" subtitle={subtitle ?? undefined} />
      </View>
    </Card>
  );
}

function AgentRow({ env, device, deviceId }: { env: EnvironmentState; device: DeviceRef; deviceId: string }) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const macId = useMacConnection().mac?.id ?? '';
  const now = useNow(15_000);
  const [latest] = useAgentActions(env.path, device.slot, deviceId, 1);
  const row = agentRow(device.activity, latest ? { ts: latest.record.ts, msg: latest.record.msg } : null, now);
  return (
    <Touch
      feedback="row"
      onPress={() =>
        router.push({
          pathname: '/mac/[id]/agent',
          params: { id: macId, path: env.path, platform: device.platform, slot: device.slot, device: deviceId },
        })
      }
      accessibilityLabel={`${row.tool ?? 'No agent'}, ${row.text}`}
      accessibilityHint="Shows the agent actions on this device"
      style={styles.agent}
    >
      <Text variant="footnote" weight="semibold" tone={row.tool ? 'brand' : 'tertiary'}>
        {row.tool ?? 'No agent'}
      </Text>
      <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.agentText}>
        {row.text}
      </Text>
      <Icon name="chevron.right" size={12} color={theme.colors.tertiary} />
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md + 2,
  },
  name: { flexShrink: 0, maxWidth: '45%' },
  shrink: { flexShrink: 1 },
  spacer: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  usage: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md, flexShrink: 0 },
  usageItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  stateLine: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.md },
  note: { paddingHorizontal: theme.space.lg },
  notes: { gap: theme.space.xs, paddingBottom: theme.space.md },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.md,
  },
  screen: {
    height: SCREEN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.media.screen,
    padding: SCREEN_PADDING,
  },
  waiting: { textAlign: 'center', color: theme.media.textTertiary },
  away: { opacity: 0 },
  dimmed: { opacity: 0.35 },
  closed: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  closedText: {
    color: theme.media.text,
    backgroundColor: theme.media.badge,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
  },
  placeholder: {
    marginHorizontal: theme.space.lg,
    marginBottom: theme.space.lg,
    height: 120,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    paddingHorizontal: theme.space.lg,
  },
  warming: { paddingTop: theme.space.lg },
  center: { textAlign: 'center' },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md + 3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  agentText: { flex: 1 },
}));
