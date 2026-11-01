import { t } from '@lingui/core/macro';

import type { Tone } from '@/design/tone';
import { activityBadge } from '@/lib/format';
import { devicesOf } from '@/lib/workspaces';
import type { StatusPayload } from '@/protocol/types';

type Capacity = NonNullable<StatusPayload['capacity']>;

export interface LoadView {
  value: string;
  state: string;
  tone: Tone;
}

/** The 5-minute load per core, with the state Stim placed it in. */
export function loadView(load: NonNullable<Capacity['load']>): LoadView {
  const { loadPerCore } = load;
  const value = t`${loadPerCore} per core`;
  switch (load.state) {
    case 'free':
      return { value, state: t`Free`, tone: 'default' };
    case 'busy':
      return { value, state: t`Busy`, tone: 'warning' };
    case 'holding':
      return { value, state: t`Holding new builds`, tone: 'error' };
  }
}

export interface Meter {
  kind: 'devices' | 'ios' | 'android' | 'builds';
  label: string;
  value: string;
  full: boolean;
  /** Why the count is unknown, for a device meter that could not count. */
  reason: string | null;
}

/** The device, per-platform device and build slot meters; each is present only while its cap is set. */
export function slotMeters(capacity: Capacity): Meter[] {
  const meters: Meter[] = [];
  const { devices, builds, platformDevices } = capacity;
  if (devices) {
    const used = devices.inUse ?? '?';
    meters.push({
      kind: 'devices',
      label: t`Devices`,
      value: `${used} / ${devices.max}`,
      full: devices.inUse !== null && devices.inUse >= devices.max,
      reason: devices.inUse === null ? (devices.unknown ?? null) : null,
    });
  }
  for (const [kind, label, slots] of [
    ['ios', t`iOS simulators`, platformDevices?.ios],
    ['android', t`Android emulators`, platformDevices?.android],
  ] as const) {
    if (!slots) continue;
    meters.push({
      kind,
      label,
      value: `${slots.inUse ?? '?'} / ${slots.max}`,
      full: slots.inUse !== null && slots.inUse >= slots.max,
      reason: slots.inUse === null ? (slots.unknown ?? null) : null,
    });
  }
  if (builds) {
    meters.push({
      kind: 'builds',
      label: t`Builds`,
      value: `${builds.inUse} / ${builds.max}`,
      full: builds.inUse >= builds.max,
      reason: null,
    });
  }
  return meters;
}

export interface SlotHolderRow {
  key: string;
  platform: 'ios' | 'android' | null;
  title: string;
  subtitle: string;
}

/** The devices holding the device slots, with the idle time of the device each workspace records for the slot. */
export function deviceHolderRows(capacity: Capacity, status: StatusPayload, now: number): SlotHolderRow[] {
  return (capacity.devices?.holders ?? []).map((holder, index) => {
    const env = holder.workspace ? status.environments.find((e) => e.path === holder.workspace) : undefined;
    const device = env
      ? devicesOf(env).find((d) => d.platform === holder.platform && d.slot === (holder.slot ?? 'default'))
      : undefined;
    const idle = activityBadge(device?.activity, now)?.text ?? null;
    const slot = holder.slot && holder.slot !== 'default' ? holder.slot : null;
    return {
      key: `${holder.platform}\n${holder.workspace ?? ''}\n${holder.slot ?? ''}\n${holder.label}\n${index}`,
      platform: holder.platform,
      title: holder.label,
      subtitle: [slot, holder.booting ? t`Booting` : idle, holder.workspace ? null : t`Not recorded by a workspace`]
        .filter(Boolean)
        .join(' \u00B7 '),
    };
  });
}
