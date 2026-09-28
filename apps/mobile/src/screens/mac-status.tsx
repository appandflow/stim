import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { CollapsibleSection } from '@/components/collapsible-section';
import { ConnectionBanner } from '@/components/connection-banner';
import { Icon } from '@/components/icon';
import { ScrollView } from '@/components/lists';
import { connectionColor, describeState } from '@/components/mac-chip';
import { MachineStatsRow } from '@/components/machine-stats';
import { Pill } from '@/components/pill';
import { PlatformGlyph } from '@/components/platform-glyph';
import { explainReadOnly, ScopeChip } from '@/components/read-only';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { UsageCharts, useUsageHistory } from '@/components/usage-charts';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useMachineDetails } from '@/hooks/machine-details';
import { useMacById, useMachineStatus, useMachineUsage } from '@/hooks/mac-connection';
import { useNow } from '@/hooks/use-now';
import { pairingScope } from '@/lib/connection';
import { budgetRows, formatBytes, usageCharts, type BudgetRow } from '@/lib/home';
import {
  agoLabel,
  buildStats,
  machineReport,
  parseGcReport,
  rankedOwners,
  sizeLabel,
  type CategoryKey,
  type DeviceRow,
  type FreeRow,
  type RepositoryRow,
  type RuntimeRow,
  type SizedRow,
  type WorktreeRow,
} from '@/lib/machine-report';
import { tildeHome } from '@/lib/paths';
import { formatCpu, formatMemoryMb } from '@/lib/workspace-view';
import { attentionGroups, workspaceTitleAt, type AttentionGroup } from '@/lib/workspaces';
import type { DeviceLeaseState, MachineOwner, StatusPayload } from '@/protocol/types';

const MANAGE_NOTE = 'Read-only here. Free space and manage these on your Mac, in Stim Desktop or with stim.';

export function MacStatus({ id }: { id: string }) {
  const { theme } = useUnistyles();
  const { mac, connection, state, missing, home } = useMacById(id);
  const status = useMachineStatus(id);
  const usage = useMachineUsage(id);
  const [budgets, setBudgets] = useState<BudgetRow[] | null>(null);
  const [minFreeGb, setMinFreeGb] = useState<number | null>(null);
  const open = state.kind === 'open';
  const samples = useUsageHistory(connection, open, usage);
  const charts = useMemo(() => usageCharts(samples ?? [], usage), [samples, usage]);
  const details = useMachineDetails(connection, open);
  const now = useNow(60_000);
  const gc = useMemo(() => (details.kind === 'ready' ? parseGcReport(details.details.gc) : null), [details]);
  const report = useMemo(() => machineReport(status, gc, now), [status, gc, now]);
  const builds = details.kind === 'ready' ? buildStats(details.details.stats) : [];

  useEffect(() => {
    if (!connection || !open) return;
    let cancelled = false;
    connection.request('settings.get', {}).then(
      (settings) => {
        if (cancelled) return;
        setBudgets(budgetRows(settings));
        const entry = (Array.isArray(settings.settings) ? settings.settings : []).find(
          (item): item is { value: unknown } =>
            typeof item === 'object' && item !== null && item.key === 'budget.minFreeDiskGb',
        );
        setMinFreeGb(typeof entry?.value === 'number' && entry.value > 0 ? entry.value : null);
      },
      () => !cancelled && setBudgets([]),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open]);

  if (!mac) {
    return (
      <View style={styles.center}>
        <Text tone="secondary">This machine is not paired.</Text>
      </View>
    );
  }

  const attention = attentionGroups(status?.environments ?? []);
  const owners = rankedOwners(status?.machine?.owners ?? []);
  const gcSections = details.kind === 'ready' && gc !== null;
  const measured =
    details.kind === 'ready'
      ? agoLabel(details.details.measuredAt, now)
      : details.kind === 'loading' && open
        ? 'measuring'
        : null;

  return (
    <ScrollView contentContainerStyle={styles.container} style={{ backgroundColor: theme.colors.background }}>
      <View style={styles.titleRow}>
        <View>
          <Icon name="laptopcomputer" size={26} color={theme.colors.text} />
          <View style={[styles.dot, { backgroundColor: connectionColor(state, missing, theme.colors) }]} />
        </View>
        <View style={styles.titleText}>
          <Text variant="title" numberOfLines={1}>
            {mac.name}
          </Text>
          <Text tone="secondary" style={styles.subtitle} numberOfLines={1}>
            {open ? `stim ${state.server.stim} \u00B7 server ${state.server.version}` : describeState(state, missing)}
          </Text>
        </View>
        <ScopeChip state={state} />
      </View>
      <Text variant="caption" tone="tertiary" mono selectable>
        {mac.endpoint}
      </Text>
      <ConnectionBanner state={state} style={styles.banner} />
      {pairingScope(state) === 'read' ? (
        <Banner
          message="This phone is read-only: it cannot reload or stop workspaces, or control devices."
          action={{ label: 'Allow control', onPress: () => explainReadOnly(mac.name, state, connection) }}
        />
      ) : null}

      <View style={styles.block}>
        <Text variant="headline">Now</Text>
        {usage ? (
          <MachineStatsRow usage={usage} large />
        ) : open ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : null}
        {charts.length > 0 ? (
          <Card style={styles.padded}>
            <UsageCharts charts={charts} />
          </Card>
        ) : null}
        {status?.capacity ? (
          <Text variant="footnote" tone={status.capacity.overCapacity ? 'warning' : 'secondary'}>
            {`${status.capacity.liveCount} live ${status.capacity.liveCount === 1 ? 'workspace' : 'workspaces'} \u00B7 Stim holds ${(status.capacity.committedMb / 1024).toFixed(1)} of ${Math.round(status.capacity.totalMemoryMb / 1024)} GB${status.capacity.overCapacity ? ', over comfortable capacity' : ''}`}
          </Text>
        ) : null}
      </View>

      {status ? (
        <CollapsibleSection
          id="machine.owners"
          title="CPU and memory"
          rows={owners}
          rowKey={(owner) => `${owner.kind}\n${owner.workspace ?? ''}\n${owner.slot ?? ''}\n${owner.id ?? owner.name}`}
          renderRow={(owner) => <OwnerRow owner={owner} status={status} />}
          empty={
            status.machine === undefined || status.machine === null
              ? 'No simulator, emulator, dev server or build is running.'
              : 'Nothing Stim tracks is using CPU or memory.'
          }
          footer={
            owners.length ? (
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                {status.machine?.memorySource === 'footprint'
                  ? "Each process counts in one row. Memory is each process's footprint, as Activity Monitor shows it."
                  : 'Each process counts in one row. Resident memory counts shared memory once per process, so simulators read high.'}
              </Text>
            ) : null
          }
        />
      ) : null}

      <DiskHeadline
        report={report}
        usage={usage}
        minFreeGb={minFreeGb}
        measured={measured}
        detailsNote={
          details.kind === 'unsupported'
            ? 'Update stim-server on the Mac to see caches, runtimes and what Stim can free.'
            : details.kind === 'failed'
              ? `Disk details are unavailable: ${details.message}`
              : details.kind === 'ready' && details.details.gcError
                ? `stim gc did not answer: ${details.details.gcError}`
                : null
        }
      />

      {gcSections ? (
        <CollapsibleSection
          id="machine.free"
          title="Safe to free now"
          rows={report.free}
          rowKey={(row) => row.id}
          renderRow={(row) => <FreeItemRow row={row} home={home} />}
          trailing={<SizeText size={report.freeTotal} strong />}
          empty="stim gc found nothing to free."
          footer={
            report.free.length ? (
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                {MANAGE_NOTE}
              </Text>
            ) : null
          }
        />
      ) : null}

      {status ? (
        <CollapsibleSection
          id="machine.projects"
          title="Projects"
          rows={report.repositories}
          rowKey={(repository) => repository.path}
          renderRow={(repository) => <RepositoryRows repository={repository} home={home} />}
          empty="stim status reports no workspaces."
        />
      ) : null}

      {status ? (
        <CollapsibleSection
          id="machine.devices"
          title="Simulators and emulators"
          rows={report.devices}
          rowKey={(device) => device.id}
          renderRow={(device) => <DeviceItemRow device={device} />}
          note={
            <View style={styles.notes}>
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                {report.inventory
                  ? 'Stim acts only on devices this Stim home created. The others are listed so you can see their size; manage them in Xcode or Android Studio.'
                  : 'Stim-owned devices that stim status has measured. The Mac lists every simulator and emulator once stim-server serves machine details.'}
              </Text>
              {report.notices.map((notice) => (
                <Text key={notice} variant="footnote" tone="warning" style={styles.note}>
                  {notice}
                </Text>
              ))}
            </View>
          }
          empty="No simulator or emulator is listed."
        />
      ) : null}

      {status && status.deviceLeases.length > 0 ? (
        <CollapsibleSection
          id="machine.leases"
          title="Leased devices"
          rows={status.deviceLeases}
          rowKey={(lease) => `${lease.platform}\n${lease.id ?? lease.path}\n${lease.slot ?? ''}`}
          renderRow={(lease) => <LeaseRow lease={lease} status={status} now={now} />}
        />
      ) : null}

      {gcSections && report.inventory ? (
        <CollapsibleSection
          id="machine.runtimes"
          title="Runtimes and system images"
          rows={report.runtimes}
          rowKey={(runtime) => runtime.id}
          renderRow={(runtime) => <RuntimeItemRow runtime={runtime} />}
          trailing={<UnusedPill runtimes={report.runtimes} />}
          note={
            <Text variant="footnote" tone="tertiary" style={styles.note}>
              Stim never deletes these. Remove one no device uses from Xcode or Android Studio on your Mac.
            </Text>
          }
          empty="No simulator runtime or Android system image is installed."
        />
      ) : null}

      {gcSections ? (
        <CollapsibleSection
          id="machine.recordings"
          title="Recordings"
          rows={report.recordings}
          rowKey={(row) => row.id}
          renderRow={(row) => <SizedItemRow row={row} />}
          trailing={<SizeText size={sum(report.recordings)} />}
          empty="No device recordings are kept."
        />
      ) : null}

      {gcSections ? (
        <CollapsibleSection
          id="machine.caches"
          title="Caches"
          rows={report.caches}
          rowKey={(row) => row.id}
          renderRow={(row) => <SizedItemRow row={row} />}
          trailing={<SizeText size={sum(report.caches)} />}
          note={
            <Text variant="footnote" tone="tertiary" style={styles.note}>
              Shared caches builds refill. Empty one on your Mac with stim gc --delete --cache.
            </Text>
          }
          empty="No shared cache was found."
        />
      ) : null}

      {builds.length > 0 ? (
        <View style={styles.block}>
          <Text variant="headline">Native builds</Text>
          <Card>
            {builds.map((row, index) => (
              <View key={row.platform} style={[styles.row, index > 0 && styles.separated]}>
                <PlatformGlyph platform={row.platform} size={16} color={theme.colors.secondary} />
                <View style={styles.grow}>
                  <Text variant="callout">{row.platform === 'ios' ? 'iOS' : 'Android'}</Text>
                  <Text variant="footnote" tone="secondary">
                    {[
                      `${row.runs} runs`,
                      row.failed ? `${row.failed} failed` : null,
                      row.hitRate === null ? null : `${Math.round(row.hitRate * 100)}% cache hits`,
                    ]
                      .filter(Boolean)
                      .join(' \u00B7 ')}
                  </Text>
                </View>
                {row.timeSavedMs ? (
                  <Text variant="callout" weight="medium" style={styles.tabular}>
                    {`${hours(row.timeSavedMs)} saved`}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {budgets && budgets.length > 0 ? (
        <View style={styles.block}>
          <Text variant="headline">Budgets</Text>
          <Card>
            {budgets.map((row, index) => (
              <View key={row.label} style={[styles.row, index > 0 && styles.separated]}>
                <Text variant="callout" tone="secondary" style={styles.grow}>
                  {row.label}
                </Text>
                <Text variant="callout" weight="medium">
                  {row.value}
                </Text>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {attention.length > 0 ? (
        <CollapsibleSection
          id="machine.attention"
          title="Needs attention"
          rows={attention}
          rowKey={(group) => group.path}
          renderRow={(group) => <AttentionRows group={group} home={home} status={status} />}
        />
      ) : null}
    </ScrollView>
  );
}

const sum = (rows: SizedRow[]) => ({
  bytes: rows.reduce((total, row) => total + (row.bytes ?? 0), 0),
  complete: rows.every((row) => row.bytes !== null),
});

const hours = (ms: number) => {
  const h = ms / 3_600_000;
  return h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(ms / 60_000)} min`;
};

function SizeText({ size, strong }: { size: Parameters<typeof sizeLabel>[0]; strong?: boolean }) {
  const known = size !== null && (typeof size === 'number' ? size > 0 : size.bytes > 0);
  return (
    <Text
      variant="callout"
      weight={strong ? 'semibold' : 'medium'}
      tone={known ? 'default' : 'tertiary'}
      style={styles.tabular}
    >
      {sizeLabel(size)}
    </Text>
  );
}

const CATEGORY_COLORS: Record<CategoryKey, (colors: Theme['colors']) => string> = {
  stimDevices: (c) => c.primary,
  stimOutputs: (c) => withAlpha(c.accent, 0.55),
  nodeModules: (c) => c.info,
  otherDevices: (c) => c.warning,
  runtimes: (c) => withAlpha(c.error, 0.75),
};

function DiskHeadline({
  report,
  usage,
  minFreeGb,
  measured,
  detailsNote,
}: {
  report: ReturnType<typeof machineReport>;
  usage: ReturnType<typeof useMachineUsage>;
  minFreeGb: number | null;
  measured: string | null;
  detailsNote: string | null;
}) {
  const { theme } = useUnistyles();
  const lowest = usage?.volumes.reduce<(typeof usage.volumes)[number] | null>(
    (min, volume) => (min === null || volume.freeBytes < min.freeBytes ? volume : min),
    null,
  );
  const budget = minFreeGb === null ? null : minFreeGb * 1e9;
  const under = lowest && budget !== null ? lowest.freeBytes < budget : false;
  const shown = report.categories.filter((category) => category.total.bytes > 0);
  const whole = Math.max(
    1,
    shown.reduce((total, category) => total + category.total.bytes, 0),
  );
  return (
    <View style={styles.block}>
      <View style={styles.headerRow}>
        <Text variant="headline" style={styles.grow}>
          Disk
        </Text>
        {measured ? (
          <Text variant="footnote" tone="tertiary">
            {measured === 'measuring' ? 'Measuring\u2026' : `Measured ${measured}`}
          </Text>
        ) : null}
      </View>
      <Card style={styles.padded}>
        <View style={styles.headline}>
          <Text variant="title" tone={under ? 'warning' : 'default'} style={styles.tabular}>
            {lowest ? formatBytes(lowest.freeBytes) : '\u2014'}
          </Text>
          <View style={styles.grow}>
            <Text variant="footnote" tone="secondary">
              {lowest ? `free on ${lowest.mount} of ${formatBytes(lowest.totalBytes)}` : 'free'}
            </Text>
            <Text variant="caption" tone={under ? 'warning' : 'tertiary'}>
              {budget === null
                ? 'No Stim disk budget set'
                : under
                  ? `Under the ${formatBytes(budget)} Stim budget`
                  : `Stim budget ${formatBytes(budget)} free`}
            </Text>
          </View>
        </View>
        {shown.length ? (
          <View style={styles.bar} accessibilityLabel="Disk use by category">
            {shown.map((category) => (
              <View
                key={category.key}
                style={{
                  flex: category.total.bytes / whole,
                  backgroundColor: CATEGORY_COLORS[category.key](theme.colors),
                }}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.legend}>
          {report.categories.map((category) => (
            <View key={category.key} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: CATEGORY_COLORS[category.key](theme.colors) }]} />
              <Text variant="footnote" tone="secondary" style={styles.grow}>
                {category.title}
              </Text>
              <SizeText size={category.total} />
            </View>
          ))}
        </View>
      </Card>
      {detailsNote ? (
        <Text variant="footnote" tone="tertiary" style={styles.note}>
          {detailsNote}
        </Text>
      ) : null}
    </View>
  );
}

function RowLayout({
  leading,
  title,
  subtitle,
  chip,
  trailing,
  indent,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  chip?: ReactNode;
  trailing?: ReactNode;
  indent?: boolean;
}) {
  return (
    <View style={[styles.row, indent && styles.indent]}>
      {leading}
      <View style={styles.grow}>
        <Text variant="callout" numberOfLines={1} ellipsizeMode="middle">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {chip ? <View style={styles.chip}>{chip}</View> : null}
      </View>
      {trailing}
    </View>
  );
}

function OwnerRow({ owner, status }: { owner: MachineOwner; status: StatusPayload }) {
  const { theme } = useUnistyles();
  const count = `${owner.processes} ${owner.processes === 1 ? 'process' : 'processes'}`;
  const where = owner.workspace
    ? `${workspaceTitleAt(owner.workspace, status)}${owner.slot ? ` \u00B7 ${owner.slot}` : ''}`
    : owner.kind === 'simulator' || owner.kind === 'emulator'
      ? "Not Stim's"
      : owner.kind === 'server'
        ? 'Stim'
        : 'Shared by the machine';
  const glyph = owner.kind === 'simulator' ? 'ios' : owner.kind === 'emulator' ? 'android' : null;
  return (
    <RowLayout
      leading={
        glyph ? (
          <PlatformGlyph
            platform={glyph}
            size={16}
            color={owner.owned ? theme.colors.primary : theme.colors.tertiary}
          />
        ) : (
          <Icon name="gearshape" size={16} color={owner.owned ? theme.colors.primary : theme.colors.tertiary} />
        )
      }
      title={owner.name}
      subtitle={`${where} \u00B7 ${count}`}
      trailing={
        <View style={styles.figures}>
          <Text variant="callout" weight="medium" style={styles.tabular}>
            {formatMemoryMb(owner.memoryMb)}
          </Text>
          <Text variant="footnote" tone="secondary" style={styles.tabular}>
            {`${formatCpu(owner.cpuPercent)} CPU`}
          </Text>
        </View>
      }
    />
  );
}

function FreeItemRow({ row, home }: { row: FreeRow; home: string | null | undefined }) {
  return (
    <RowLayout
      title={row.title}
      subtitle={tildeHome(row.detail, home)}
      chip={<Pill>{row.command}</Pill>}
      trailing={<SizeText size={row.bytes} />}
    />
  );
}

function worktreeLine(row: WorktreeRow): string | null {
  const parts = [
    row.inCheckout,
    row.nodeModules ? `node_modules ${sizeLabel(row.nodeModules)}` : null,
    row.devices ? `${row.deviceCount === 1 ? 'device' : `${row.deviceCount} devices`} ${sizeLabel(row.devices)}` : null,
    row.outputs ? `outputs ${sizeLabel(row.outputs)}` : null,
    row.logs ? `logs ${sizeLabel(row.logs)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' \u00B7 ') : null;
}

function WorktreeItem({ row, indent }: { row: WorktreeRow; indent: boolean }) {
  return (
    <RowLayout
      indent={indent}
      title={row.title}
      subtitle={worktreeLine(row)}
      chip={row.lifecycle ? <Pill tone={row.lifecycle.tone}>{row.lifecycle.label}</Pill> : null}
      trailing={<SizeText size={row.total} strong />}
    />
  );
}

function RepositoryRows({ repository, home }: { repository: RepositoryRow; home: string | null | undefined }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const only = repository.worktrees.length === 1 ? repository.worktrees[0] : null;
  if (only) return <WorktreeItem row={only} indent={false} />;
  return (
    <View>
      <Touch
        feedback="row"
        onPress={() => setExpanded(!expanded)}
        accessibilityLabel={`${repository.name}, ${repository.worktrees.length} worktrees`}
        accessibilityState={{ expanded }}
        style={styles.row}
      >
        <View style={styles.chevron(expanded)}>
          <Icon name="chevron.right" size={11} color={theme.colors.tertiary} />
        </View>
        <View style={styles.grow}>
          <Text variant="callout" weight="semibold" numberOfLines={1}>
            {repository.name}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1} ellipsizeMode="middle">
            {`${repository.worktrees.length} worktrees \u00B7 ${tildeHome(repository.path, home)}`}
          </Text>
        </View>
        <SizeText size={repository.total} strong />
      </Touch>
      {expanded
        ? repository.worktrees.map((row) => (
            <View key={row.path} style={styles.separated}>
              <WorktreeItem row={row} indent />
            </View>
          ))
        : null}
    </View>
  );
}

function DeviceItemRow({ device }: { device: DeviceRow }) {
  const { theme } = useUnistyles();
  return (
    <RowLayout
      leading={
        <PlatformGlyph
          platform={device.kind}
          size={16}
          color={device.stim ? theme.colors.primary : theme.colors.tertiary}
        />
      }
      title={device.name}
      subtitle={device.subtitle || null}
      chip={<Pill tone={device.owner.tone}>{device.owner.label}</Pill>}
      trailing={<SizeText size={device.bytes} />}
    />
  );
}

function LeaseRow({ lease, status, now }: { lease: DeviceLeaseState; status: StatusPayload; now: number }) {
  const until = lease.expiresAt ? Date.parse(lease.expiresAt) - now : null;
  const holder = status.environments.find(
    (env) => env.path === lease.holder || env.physicalDevices?.some((device) => device.id === lease.id),
  );
  return (
    <RowLayout
      leading={
        lease.platform === 'ios' || lease.platform === 'android' ? (
          <PlatformGlyph platform={lease.platform} size={16} />
        ) : null
      }
      title={lease.deviceName ?? lease.id ?? 'Device'}
      subtitle={[
        holder ? workspaceTitleAt(holder.path, status) : 'Held outside a listed workspace',
        lease.slot && lease.slot !== 'default' ? lease.slot : null,
      ]
        .filter(Boolean)
        .join(' \u00B7 ')}
      trailing={
        lease.expired ? (
          <Pill tone="warning">Expired</Pill>
        ) : until !== null && until > 0 ? (
          <Text variant="footnote" tone="secondary">
            {`${Math.max(1, Math.round(until / 60_000))} min left`}
          </Text>
        ) : null
      }
    />
  );
}

function RuntimeItemRow({ runtime }: { runtime: RuntimeRow }) {
  return (
    <RowLayout
      title={runtime.title}
      subtitle={runtime.detail}
      chip={
        runtime.unused ? (
          <Pill tone="warning">Unused</Pill>
        ) : (
          <Pill>{runtime.deviceCount === 1 ? '1 device' : `${runtime.deviceCount} devices`}</Pill>
        )
      }
      trailing={<SizeText size={runtime.bytes} />}
    />
  );
}

function UnusedPill({ runtimes }: { runtimes: RuntimeRow[] }) {
  const unused = runtimes.filter((runtime) => runtime.unused);
  if (!unused.length) return null;
  return <Pill tone="warning">{`${unused.length} unused`}</Pill>;
}

function SizedItemRow({ row }: { row: SizedRow }) {
  return <RowLayout title={row.title} subtitle={row.detail} trailing={<SizeText size={row.bytes} />} />;
}

function AttentionRows({
  group,
  home,
  status,
}: {
  group: AttentionGroup;
  home: string | null | undefined;
  status: StatusPayload | null;
}) {
  return (
    <View style={[styles.row, styles.group]}>
      <View style={styles.groupHeader}>
        <Text variant="callout" weight="semibold" style={styles.grow} numberOfLines={1} ellipsizeMode="middle">
          {workspaceTitleAt(group.path, status)}
        </Text>
        <Text variant="caption" tone={group.live ? 'success' : 'tertiary'}>
          {group.live ? 'live' : 'idle'}
        </Text>
      </View>
      {group.items.map((item, index) => (
        <View key={index} style={styles.issue(item.severity === 'error')}>
          <Text variant="footnote" tone={item.severity === 'error' ? 'error' : 'warning'}>
            {tildeHome(item.message, home)}
          </Text>
          {item.remedy && item.command ? (
            <View style={styles.remedy}>
              <Text variant="caption" mono style={styles.grow} selectable numberOfLines={2}>
                {item.remedy}
              </Text>
              <Button
                variant="plain"
                size="small"
                title="Copy"
                accessibilityLabel="Copy command"
                onPress={() => void Clipboard.setStringAsync(item.command ?? '')}
              />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, paddingTop: theme.space.xxxl, gap: theme.space.xxl, paddingBottom: 48 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg },
  banner: { marginHorizontal: -theme.space.xxl },
  dot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 11,
    height: 11,
    borderRadius: theme.radius.round,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  titleText: { flex: 1 },
  subtitle: { marginTop: theme.space.xxs },
  block: { gap: theme.space.sm },
  headerRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.md },
  padded: { padding: theme.space.lg, gap: theme.space.lg },
  headline: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md },
  bar: {
    flexDirection: 'row',
    height: 12,
    gap: 2,
    borderRadius: theme.radius.small,
    overflow: 'hidden',
  },
  legend: { gap: theme.space.xs },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  swatch: { width: 9, height: 9, borderRadius: 2 },
  notes: { gap: theme.space.xs },
  note: { paddingHorizontal: theme.space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  separated: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.separator },
  indent: { paddingLeft: theme.space.huge },
  grow: { flex: 1 },
  chip: { flexDirection: 'row', marginTop: theme.space.xs },
  figures: { alignItems: 'flex-end' },
  tabular: { fontVariant: ['tabular-nums'] },
  chevron: (open: boolean) => ({ width: 12, transform: [{ rotate: open ? '90deg' : '0deg' }] }),
  group: { flexDirection: 'column', alignItems: 'stretch', gap: theme.space.sm },
  groupHeader: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.lg },
  issue: (error: boolean) => ({
    padding: theme.space.md,
    borderRadius: theme.radius.control,
    gap: theme.space.sm,
    backgroundColor: withAlpha(error ? theme.colors.error : theme.colors.warning, theme.opacity.subtle),
  }),
  remedy: { flexDirection: 'row', alignItems: 'center', gap: theme.space.lg },
}));
