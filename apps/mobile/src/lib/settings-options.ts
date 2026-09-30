import { t } from '@lingui/core/macro';

import type { HomeView } from '@/hooks/home-filters';
import type { NotifyLevel, QuietHours } from '@/lib/notifications';
import type { OversightCategory } from '@/lib/oversight';
import type { Appearance, VideoQuality } from '@/hooks/settings';

export interface Option<T extends string> {
  value: T;
  label: string;
}

export const appearanceOptions = (): Option<Appearance>[] => [
  { value: 'system', label: t`System` },
  { value: 'light', label: t`Light` },
  { value: 'dark', label: t`Dark` },
];

export const homeViewOptions = (): Option<HomeView>[] => [
  { value: 'workspaces', label: t`Workspaces` },
  { value: 'devices', label: t`Devices` },
  { value: 'machines', label: t`Machines` },
];

export const videoQualityOptions = (): Option<VideoQuality>[] => [
  { value: 'auto', label: t`Auto` },
  { value: 'high', label: t`High` },
  { value: 'dataSaver', label: t`Data saver` },
];

export const labelOf = <T extends string>(options: Option<T>[], value: T): string =>
  options.find((option) => option.value === value)?.label ?? options[0].label;

export const videoQualityFooter = (): string => t`Data saver sends still frames instead of video.`;

export const readOnlyFooter = (): string =>
  t`A read-only machine can't be controlled from this phone. Tap it to see how to allow control.`;

export const replayFooter = (): string =>
  t`A Mac keeps the last 15 minutes of device screens. Turning this off deletes them.`;

export function notifyCategoryLabel(category: OversightCategory): string {
  switch (category) {
    case 'started':
      return t`Work started`;
    case 'stuck':
      return t`Agent looks stuck`;
    case 'looping':
      return t`Agent repeats the same failure`;
    case 'finished':
      return t`Work finished or PR ready`;
    case 'machine':
      return t`Machine in trouble`;
    case 'control':
      return t`Someone takes over your device`;
  }
}

export const notifyLevelOptions = (): Option<NotifyLevel>[] => [
  { value: 'alert', label: t`Alert` },
  { value: 'silent', label: t`Silent` },
  { value: 'off', label: t`Off` },
];

export const stuckMinutesOptions = (): Option<string>[] =>
  [5, 10, 15, 30, 60].map((minutes) => ({
    value: String(minutes),
    label: t`${minutes} min`,
  }));

export const quietHoursOptions = (): Option<string>[] => [
  { value: 'off', label: t`Off` },
  { value: '1320-420', label: t`10 PM to 7 AM` },
  { value: '1380-480', label: t`11 PM to 8 AM` },
  { value: '0-480', label: t`Midnight to 8 AM` },
];

export const quietHoursValue = (quietHours: QuietHours | null): string =>
  quietHours ? `${quietHours.start}-${quietHours.end}` : 'off';

export function parseQuietHoursValue(value: string): QuietHours | null {
  const [start, end] = value.split('-').map(Number);
  return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end)
    ? { start, end }
    : null;
}

export const notificationsFooter = (): string => t`Background notifications need an iPhone and a Mac that sends push.`;
