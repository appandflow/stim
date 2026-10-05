import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { View, type ViewInstance } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Card } from '@/components/card';
import { HostLabel } from '@/components/host-label';
import { Icon } from '@/components/icon';
import { StatRow } from '@/components/stat-row';
import { Pill } from '@/components/pill';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { openDeviceViewer, useZoomedAway, zoomKey } from '@/hooks/device-zoom';
import { useNow } from '@/hooks/use-now';
import { useFrame } from '@/hooks/frames';
import { useMacConnection } from '@/hooks/machines';
import { useAgentActions } from '@/hooks/workspace-logs';
import { formatDuration } from '@/intl/format';
import { tildeHome } from '@/lib/paths';
import { agentRow, appPresence, deviceTitle, usageLabel, usageParts, type Usage } from '@/lib/workspace-view';
import { platformName, runningBuild, streamsFrames, unservedReason, type DeviceRef } from '@/lib/workspaces';
import type { EnvironmentState } from '@/protocol/types';

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
  const { home, mac, state: link } = useMacConnection();
  const workspace = env.path;
  const [screenWidth, setScreenWidth] = useState(0);
  const now = useNow(30_000);
  const streams = device.running && streamsFrames(device, link.kind === 'open' ? link.features : null);
  const { frame, error, delayed, delayedReason } = useFrame(workspace, device.platform, device.slot, streams, {
    physical: device.physical,
  });
  const thumbnail = useRef<ViewInstance>(null);
  const target = {
    macId: mac?.id ?? '',
    workspace,
    platform: device.platform,
    slot: device.slot,
    physical: device.physical,
  };
  const zoomedAway = useZoomedAway(zoomKey(target));
  const build = device.platform === 'web' ? null : runningBuild(env, device);
  const app = appPresence(env, device);
  const appClosed = app === 'closed';
  const noApp = app === 'none';
  const title = deviceTitle(device);
  const notes = warnings.map((warning) => (
    <Text key={warning} variant="caption" tone="warning" style={styles.note}>
      {tildeHome(warning, home)}
    </Text>
  ));
  const leaseLeft = device.leaseExpiresAt ? formatDuration(Math.max(0, Date.parse(device.leaseExpiresAt) - now)) : '';
  const leasePills = device.physical
    ? [
        <Pill key="physical">
          <Trans>Physical</Trans>
        </Pill>,
        device.leaseExpiresAt ? <Pill key="lease">{t`Leased \u00B7 ${leaseLeft} left`}</Pill> : null,
      ]
    : [];
  const { name: deviceName, state: deviceState } = device;
  const header = (
    <View style={styles.header}>
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
        {device.host ? (
          <View style={styles.stateLine}>
            <HostLabel host={device.host} />
          </View>
        ) : null}
        <Text variant="footnote" tone="tertiary" style={styles.stateLine}>
          {device.platform === 'web' ? t`Closed` : t`Not running \u00B7 ${deviceState}`}
        </Text>
        {leasePills.length ? <View style={styles.badges}>{leasePills}</View> : null}
        {notes.length ? <View style={styles.notes}>{notes}</View> : null}
      </Card>
    );
  }
  const pills = [
    ...leasePills,
    appClosed && !frame ? (
      <Pill key="closed" tone="error">
        <Trans>App closed</Trans>
      </Pill>
    ) : null,
    device.page?.error ? (
      <Pill key="page" tone="warning">
        <Trans>Page failed to load</Trans>
      </Pill>
    ) : null,
    streams && frame?.posture ? (
      <Pill key="posture">{frame.posture === 'folded' ? t`Folded` : t`Unfolded`}</Pill>
    ) : null,
    streams && delayed ? (
      <Pill key="delayed" tone="warning">
        {delayedReason ? t`Screen paused` : t`Screen updates delayed`}
      </Pill>
    ) : null,
  ].filter(Boolean);
  const fallbackAspect =
    device.platform === 'web' || device.platform === 'macos' ? 1.6 : device.platform === 'ios' ? 0.46 : 0.45;
  const aspect = frame && frame.height > 0 ? frame.width / frame.height : fallbackAspect;
  const imageHeight = Math.min(SCREEN_HEIGHT - SCREEN_PADDING * 2, (screenWidth - SCREEN_PADDING * 2) / aspect);
  const buildName = build ? platformName(build.platform) : '';
  const placeholder = build ? (
    <Placeholder title={t`Waiting for the ${buildName} build`} />
  ) : noApp ? (
    <Placeholder title={t`No app installed`} subtitle={t`Fix the build and run it again`} />
  ) : !streams ? (
    <Placeholder title={t`No live screen`} subtitle={unservedReason(device)} />
  ) : null;
  return (
    <Card>
      {header}
      {device.host ? (
        <View style={styles.stateLine}>
          <HostLabel host={device.host} />
        </View>
      ) : null}
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
              accessibilityLabel={
                appClosed
                  ? t`Open the live screen of ${deviceName}, app closed`
                  : t`Open the live screen of ${deviceName}`
              }
            >
              <Image
                source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
                style={[
                  { height: Math.max(imageHeight, 0), aspectRatio: aspect, borderRadius: theme.radius.small },
                  zoomedAway ? styles.away : appClosed ? styles.dimmed : null,
                ]}
                contentFit="contain"
                transition={0}
                accessibilityLabel={t`Latest frame of ${deviceName}`}
              />
              {appClosed && !zoomedAway ? (
                <View style={styles.closed} pointerEvents="none">
                  <Text variant="footnote" weight="semibold" style={styles.closedText}>
                    <Trans>App closed</Trans>
                  </Text>
                </View>
              ) : null}
            </Touch>
          ) : (
            <Text variant="footnote" style={styles.waiting}>
              {error ?? t`Waiting for frames`}
            </Text>
          )}
        </View>
      )}
      {streams && device.id && !device.physical ? <AgentRow env={env} device={device} deviceId={device.id} /> : null}
    </Card>
  );
}

function UsageStats({ usage }: { usage: Usage }) {
  return <StatRow accessible accessibilityLabel={usageLabel(usage)} stats={usageParts(usage)} valueTone="secondary" />;
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

export function WarmingPlaceholder({ subtitle }: { subtitle: string | null }) {
  return (
    <Card>
      <View style={styles.warming}>
        <Placeholder title={t`Warming the workspace`} subtitle={subtitle ?? undefined} />
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
  const tool = row.tool ?? t`No agent`;
  const { text } = row;
  return (
    <Touch
      feedback="row"
      onPress={() =>
        router.push({
          pathname: '/mac/[id]/agent',
          params: { id: macId, path: env.path, platform: device.platform, slot: device.slot, device: deviceId },
        })
      }
      accessibilityLabel={t`${tool}, ${text}`}
      accessibilityHint={t`Shows the agent actions on this device`}
      style={styles.agent}
    >
      {row.tool ? <Icon name="cursorarrow.rays" size={13} color={theme.colors.primary} /> : null}
      <Text variant="footnote" weight="semibold" tone={row.tool ? 'brand' : 'tertiary'}>
        {tool}
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
