import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import * as Clipboard from 'expo-clipboard';
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Collapsible, DisclosureChevron } from '@/components/collapsible';
import { CollapsibleSection } from '@/components/collapsible-section';
import { ConnectionBanner } from '@/components/connection-banner';
import { Icon } from '@/components/icon';
import { connectionColor, describeState } from '@/components/mac-chip';
import { MachineStatsRow } from '@/components/machine-stats';
import { Pill } from '@/components/pill';
import { PlatformGlyph } from '@/components/platform-glyph';
import { explainReadOnly, ScopeChip } from '@/components/read-only';
import { SheetScreen } from '@/components/sheet-screen';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { UsageCharts, useUsageHistory } from '@/components/usage-charts';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';
import { useMachineDetails } from '@/hooks/machine-details';
import { useMacById, useMachineStatus, useMachineUsage } from '@/hooks/machines';
import { useNow } from '@/hooks/use-now';
import { formatBytes, formatMemoryMb } from '@/intl/format';
import { machineReadiness } from '@/lib/build-machines';
import { pairingScope } from '@/lib/connection';
import { budgetRows, usageCharts, type BudgetRow } from '@/lib/home';
import {
  agoLabel,
  buildStats,
  machineReport,
  parseGcReport,
  rankedOwners,
  sizeLabel,
  type BuildStatsRow,
  type CategoryKey,
  type DeviceRow,
  type FreeRow,
  type RepositoryRow,
  type RuntimeRow,
  type SizedRow,
  type WorktreeRow,
} from '@/lib/machine-report';
import { tildeHome } from '@/lib/paths';
import { formatCpu } from '@/lib/workspace-view';
import { workspaceTitleAt } from '@/lib/workspace-names';
import { attentionGroups, type AttentionGroup } from '@/lib/workspaces';
import type { DeviceLeaseState, MachineOwner, StatusPayload } from '@/protocol/types';

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
  const focused = useIsFocused();
  const details = useMachineDetails(connection, open && focused);
  const now = useNow(60_000);
  const gc = useMemo(() => (details.kind === 'ready' ? parseGcReport(details.details.gc) : null), [details]);
  const report = useMemo(() => machineReport(status, gc, now), [status, gc, now]);
  const builds = details.kind === 'ready' ? buildStats(details.details.stats) : [];
  const machines = details.kind === 'ready' ? (details.details.buildMachines ?? []).map(machineReadiness) : [];
  const machinesError = details.kind === 'ready' ? details.details.buildMachinesError : undefined;
  const machinesPending = details.kind === 'ready' ? (details.details.buildMachinesPending ?? false) : false;

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
        <Text tone="secondary">
          <Trans>This machine is not paired.</Trans>
        </Text>
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
    <SheetScreen
      title={mac.name}
      titleLines={1}
      subtitle={open ? serverLine(state.server.stim, state.server.version) : describeState(state, missing)}
      leading={
        <View>
          <Icon name="laptopcomputer" size={26} color={theme.colors.text} />
          <View style={[styles.dot, { backgroundColor: connectionColor(state, missing, theme.colors) }]} />
        </View>
      }
      accessory={<ScopeChip state={state} />}
      gap="xxl"
    >
      <Text variant="caption" tone="tertiary" mono selectable>
        {mac.endpoint}
      </Text>
      <ConnectionBanner state={state} style={styles.banner} />
      {pairingScope(state) === 'read' ? (
        <Banner
          message={t`This phone is read-only: it cannot reload or stop workspaces, or control devices.`}
          action={{ label: t`Allow control`, onPress: () => explainReadOnly(mac.name, state, connection) }}
        />
      ) : null}

      <View style={styles.block}>
        <Text variant="headline">
          <Trans>Now</Trans>
        </Text>
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
            {capacityLine(status.capacity)}
          </Text>
        ) : null}
      </View>

      {status ? (
        <CollapsibleSection
          id="machine.owners"
          title={t`CPU and memory`}
          rows={owners}
          rowKey={(owner) => `${owner.kind}\n${owner.workspace ?? ''}\n${owner.slot ?? ''}\n${owner.id ?? owner.name}`}
          renderRow={(owner) => <OwnerRow owner={owner} status={status} />}
          empty={
            status.machine === undefined || status.machine === null
              ? t`No simulator, emulator, dev server or build is running.`
              : t`Nothing Stim tracks is using CPU or memory.`
          }
          footer={
            owners.length ? (
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                {status.machine?.memorySource === 'footprint'
                  ? t`Each process counts in one row. Memory is each process's footprint, as Activity Monitor shows it.`
                  : t`Each process counts in one row. Resident memory counts shared memory once per process, so simulators read high.`}
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
        detailsNote={detailsNote(details)}
      />

      {gcSections ? (
        <CollapsibleSection
          id="machine.free"
          title={t`Safe to free now`}
          rows={report.free}
          rowKey={(row) => row.id}
          renderRow={(row) => <FreeItemRow row={row} home={home} />}
          trailing={<SizeText size={report.freeTotal} strong />}
          empty={t`stim gc found nothing to free.`}
          footer={
            report.free.length ? (
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                <Trans>Read-only here. Free space and manage these on your Mac, in Stim Desktop or with stim.</Trans>
              </Text>
            ) : null
          }
        />
      ) : null}

      {status ? (
        <CollapsibleSection
          id="machine.projects"
          title={t`Projects`}
          rows={report.repositories}
          rowKey={(repository) => repository.path}
          renderRow={(repository) => <RepositoryRows repository={repository} home={home} />}
          empty={t`stim status reports no workspaces.`}
        />
      ) : null}

      {status ? (
        <CollapsibleSection
          id="machine.devices"
          title={t`Simulators and emulators`}
          rows={report.devices}
          rowKey={(device) => device.id}
          renderRow={(device) => <DeviceItemRow device={device} />}
          note={
            <View style={styles.notes}>
              <Text variant="footnote" tone="tertiary" style={styles.note}>
                {report.inventory
                  ? t`Stim acts only on devices this Stim home created. The others are listed so you can see their size; manage them in Xcode or Android Studio.`
                  : t`Stim-owned devices that stim status has measured. The Mac lists every simulator and emulator once stim-server serves machine details.`}
              </Text>
              {report.notices.map((notice) => (
                <Text key={notice} variant="footnote" tone="warning" style={styles.note}>
                  {notice}
                </Text>
              ))}
            </View>
          }
          empty={t`No simulator or emulator is listed.`}
        />
      ) : null}

      {status && status.deviceLeases.length > 0 ? (
        <CollapsibleSection
          id="machine.leases"
          title={t`Leased devices`}
          rows={status.deviceLeases}
          rowKey={(lease) => `${lease.platform}\n${lease.id ?? lease.path}\n${lease.slot ?? ''}`}
          renderRow={(lease) => <LeaseRow lease={lease} status={status} now={now} />}
        />
      ) : null}

      {gcSections && report.inventory ? (
        <CollapsibleSection
          id="machine.runtimes"
          title={t`Runtimes and system images`}
          rows={report.runtimes}
          rowKey={(runtime) => runtime.id}
          renderRow={(runtime) => <RuntimeItemRow runtime={runtime} />}
          trailing={<UnusedPill runtimes={report.runtimes} />}
          note={
            <Text variant="footnote" tone="tertiary" style={styles.note}>
              <Trans>
                Stim never deletes these. Remove one no device uses from Xcode or Android Studio on your Mac.
              </Trans>
            </Text>
          }
          empty={t`No simulator runtime or Android system image is installed.`}
        />
      ) : null}

      {gcSections ? (
        <CollapsibleSection
          id="machine.recordings"
          title={t`Recordings`}
          rows={report.recordings}
          rowKey={(row) => row.id}
          renderRow={(row) => <SizedItemRow row={row} />}
          trailing={<SizeText size={sum(report.recordings)} />}
          empty={t`No device recordings are kept.`}
        />
      ) : null}

      {gcSections ? (
        <CollapsibleSection
          id="machine.caches"
          title={t`Caches`}
          rows={report.caches}
          rowKey={(row) => row.id}
          renderRow={(row) => <SizedItemRow row={row} />}
          trailing={<SizeText size={sum(report.caches)} />}
          note={
            <Text variant="footnote" tone="tertiary" style={styles.note}>
              <Trans>Shared caches builds refill. Empty one on your Mac with stim gc --delete --cache.</Trans>
            </Text>
          }
          empty={t`No shared cache was found.`}
        />
      ) : null}

      {builds.length > 0 ? (
        <View style={styles.block}>
          <Text variant="headline">
            <Trans>Native builds</Trans>
          </Text>
          <Card>
            {builds.map((row, index) => (
              <View key={row.platform} style={[styles.row, index > 0 && styles.separated]}>
                <PlatformGlyph platform={row.platform} size={16} color={theme.colors.secondary} />
                <View style={styles.grow}>
                  <Text variant="callout">{row.platform === 'ios' ? 'iOS' : t`Android`}</Text>
                  <Text variant="footnote" tone="secondary">
                    {buildLine(row)}
                  </Text>
                </View>
                {row.timeSavedMs ? (
                  <Text variant="callout" weight="medium" style={styles.tabular}>
                    {savedLabel(row.timeSavedMs)}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {machines.length > 0 || machinesError || machinesPending ? (
        <View style={styles.block}>
          <Text variant="headline">
            <Trans>Build machines</Trans>
          </Text>
          {machinesPending && machines.length === 0 && !machinesError ? (
            <View style={styles.legendRow}>
              <ActivityIndicator size="small" color={theme.colors.secondary} />
              <Text variant="footnote" tone="secondary">
                <Trans>Checking build machines\u2026</Trans>
              </Text>
            </View>
          ) : null}
          {machinesError ? (
            <Text variant="footnote" tone="secondary">
              <Trans>Cannot check build machines: {machinesError}</Trans>
            </Text>
          ) : null}
          {machines.length > 0 ? (
            <Card>
              {machines.map((machine, index) => (
                <View key={machine.id} style={[styles.row, index > 0 && styles.separated]}>
                  <Icon name="desktopcomputer" size={16} color={theme.colors.secondary} />
                  <View style={styles.grow}>
                    <Text variant="callout" numberOfLines={1}>
                      {machine.name}
                    </Text>
                    <Text variant="footnote" tone={machine.tone}>
                      {machineLine(machine.title, machine.remedy)}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          ) : null}
        </View>
      ) : null}

      {budgets && budgets.length > 0 ? (
        <View style={styles.block}>
          <Text variant="headline">
            <Trans>Budgets</Trans>
          </Text>
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
          title={t`Needs attention`}
          rows={attention}
          rowKey={(group) => group.path}
          renderRow={(group) => <AttentionRows group={group} home={home} status={status} />}
        />
      ) : null}
    </SheetScreen>
  );
}

const sum = (rows: SizedRow[]) => ({
  bytes: rows.reduce((total, row) => total + (row.bytes ?? 0), 0),
  complete: rows.every((row) => row.bytes !== null),
});

const hours = (ms: number) => {
  const h = ms / 3_600_000;
  if (h >= 10) {
    const whole = Math.round(h);
    return t`${whole} h`;
  }
  if (h >= 1) {
    const tenths = h.toFixed(1);
    return t`${tenths} h`;
  }
  const minutes = Math.round(ms / 60_000);
  return t`${minutes} min`;
};

function serverLine(stim: string, version: string): string {
  return t`stim ${stim} \u00B7 server ${version}`;
}

function capacityLine(capacity: NonNullable<StatusPayload['capacity']>): string {
  const live = plural(capacity.liveCount, { one: '# live workspace', other: '# live workspaces' });
  const held = (capacity.committedMb / 1024).toFixed(1);
  const total = Math.round(capacity.totalMemoryMb / 1024);
  const over = capacity.overCapacity ? t`, over comfortable capacity` : '';
  return t`${live} \u00B7 Stim holds ${held} of ${total} GB${over}`;
}

function detailsNote(details: ReturnType<typeof useMachineDetails>): string | null {
  if (details.kind === 'unsupported')
    return t`Update stim-server on the Mac to see caches, runtimes and what Stim can free.`;
  if (details.kind === 'failed') {
    const { message } = details;
    return t`Disk details are unavailable: ${message}`;
  }
  if (details.kind === 'ready' && details.details.gcError) {
    const { gcError } = details.details;
    return t`stim gc did not answer: ${gcError}`;
  }
  return null;
}

function buildLine(row: BuildStatsRow): string {
  const { runs, failed } = row;
  const percent = row.hitRate === null ? 0 : Math.round(row.hitRate * 100);
  return [
    plural(runs, { one: '# run', other: '# runs' }),
    row.failed ? t`${failed} failed` : null,
    row.hitRate === null ? null : t`${percent}% cache hits`,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');
}

function savedLabel(ms: number): string {
  const duration = hours(ms);
  return t`${duration} saved`;
}

function machineLine(title: string, remedy: string | null): string {
  return remedy ? t`${title} \u2014 ${remedy}` : title;
}

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
  const mount = lowest?.mount ?? '';
  const totalSize = lowest ? formatBytes(lowest.totalBytes) : '';
  const budget = minFreeGb === null ? null : minFreeGb * 1e9;
  const budgetSize = budget === null ? '' : formatBytes(budget);
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
          <Trans>Disk</Trans>
        </Text>
        {measured ? (
          <Text variant="footnote" tone="tertiary">
            {measured === 'measuring' ? t`Measuring\u2026` : t`Measured ${measured}`}
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
              {lowest ? t`free on ${mount} of ${totalSize}` : t`free`}
            </Text>
            <Text variant="caption" tone={under ? 'warning' : 'tertiary'}>
              {budget === null
                ? t`No Stim disk budget set`
                : under
                  ? t`Under the ${budgetSize} Stim budget`
                  : t`Stim budget ${budgetSize} free`}
            </Text>
          </View>
        </View>
        {shown.length ? (
          <View style={styles.bar} accessibilityLabel={t`Disk use by category`}>
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
  const count = plural(owner.processes, { one: '# process', other: '# processes' });
  const cpu = formatCpu(owner.cpuPercent);
  const where = owner.workspace
    ? `${workspaceTitleAt(owner.workspace, status)}${owner.slot ? ` \u00B7 ${owner.slot}` : ''}`
    : owner.kind === 'simulator' || owner.kind === 'emulator'
      ? t`Not Stim's`
      : owner.kind === 'server'
        ? t`Stim`
        : t`Shared by the machine`;
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
            {t`${cpu} CPU`}
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
  const nodeModules = sizeLabel(row.nodeModules);
  const deviceSize = sizeLabel(row.devices);
  const devices = plural(row.deviceCount, { one: `device ${deviceSize}`, other: `# devices ${deviceSize}` });
  const outputs = sizeLabel(row.outputs);
  const logs = sizeLabel(row.logs);
  const parts = [
    row.inCheckout,
    row.nodeModules ? t`node_modules ${nodeModules}` : null,
    row.devices ? devices : null,
    row.outputs ? t`outputs ${outputs}` : null,
    row.logs ? t`logs ${logs}` : null,
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
  const [expanded, setExpanded] = useState(false);
  const { name } = repository;
  const count = repository.worktrees.length;
  const worktrees = plural(count, { one: '# worktree', other: '# worktrees' });
  const location = tildeHome(repository.path, home);
  const only = repository.worktrees.length === 1 ? repository.worktrees[0] : null;
  if (only) return <WorktreeItem row={only} indent={false} />;
  return (
    <View>
      <Touch
        feedback="row"
        onPress={() => setExpanded(!expanded)}
        accessibilityLabel={t`${name}, ${worktrees}`}
        accessibilityState={{ expanded }}
        style={styles.row}
      >
        <View style={styles.chevron}>
          <DisclosureChevron open={expanded} size={11} />
        </View>
        <View style={styles.grow}>
          <Text variant="callout" weight="semibold" numberOfLines={1}>
            {repository.name}
          </Text>
          <Text variant="footnote" tone="secondary" numberOfLines={1} ellipsizeMode="middle">
            {t`${worktrees} \u00B7 ${location}`}
          </Text>
        </View>
        <SizeText size={repository.total} strong />
      </Touch>
      <Collapsible open={expanded}>
        {repository.worktrees.map((row) => (
          <View key={row.path} style={styles.separated}>
            <WorktreeItem row={row} indent />
          </View>
        ))}
      </Collapsible>
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
  const minutesLeft = until === null ? 0 : Math.max(1, Math.round(until / 60_000));
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
      title={lease.deviceName ?? lease.id ?? t`Device`}
      subtitle={[
        holder ? workspaceTitleAt(holder.path, status) : t`Held outside a listed workspace`,
        lease.slot && lease.slot !== 'default' ? lease.slot : null,
      ]
        .filter(Boolean)
        .join(' \u00B7 ')}
      trailing={
        lease.expired ? (
          <Pill tone="warning">
            <Trans>Expired</Trans>
          </Pill>
        ) : until !== null && until > 0 ? (
          <Text variant="footnote" tone="secondary">
            {t`${minutesLeft} min left`}
          </Text>
        ) : null
      }
    />
  );
}

function RuntimeItemRow({ runtime }: { runtime: RuntimeRow }) {
  const devices = plural(runtime.deviceCount, { one: '1 device', other: '# devices' });
  return (
    <RowLayout
      title={runtime.title}
      subtitle={runtime.detail}
      chip={
        runtime.unused ? (
          <Pill tone="warning">
            <Trans>Unused</Trans>
          </Pill>
        ) : (
          <Pill>{devices}</Pill>
        )
      }
      trailing={<SizeText size={runtime.bytes} />}
    />
  );
}

function UnusedPill({ runtimes }: { runtimes: RuntimeRow[] }) {
  const unused = runtimes.filter((runtime) => runtime.unused);
  const count = unused.length;
  if (!count) return null;
  return <Pill tone="warning">{t`${count} unused`}</Pill>;
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
          {group.live ? t`live` : t`idle`}
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
                title={t`Copy`}
                accessibilityLabel={t`Copy command`}
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
  chevron: { width: 12 },
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
