import type { HomeView } from '@/hooks/home-filters';
import type { NotifyLevel, QuietHours } from '@/lib/notifications';
import type { OversightCategory } from '@/lib/oversight';
import type { Appearance, VideoQuality } from '@/hooks/settings';

export interface Option<T extends string> {
  value: T;
  label: string;
}

export const APPEARANCE_OPTIONS: Option<Appearance>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const HOME_VIEW_OPTIONS: Option<HomeView>[] = [
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'devices', label: 'Devices' },
  { value: 'machines', label: 'Machines' },
];

export const VIDEO_QUALITY_OPTIONS: Option<VideoQuality>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'dataSaver', label: 'Data saver' },
];

export const labelOf = <T extends string>(options: Option<T>[], value: T): string =>
  options.find((option) => option.value === value)?.label ?? options[0].label;

export const VIDEO_QUALITY_FOOTER = 'Data saver sends still frames instead of video.';

export const READ_ONLY_FOOTER =
  "A read-only machine can't be controlled from this phone. Tap it to see how to allow control.";

export const REPLAY_FOOTER = 'A Mac keeps the last 15 minutes of device screens. Turning this off deletes them.';

export const NOTIFY_CATEGORY_LABELS: Record<OversightCategory, string> = {
  started: 'Work started',
  stuck: 'Agent looks stuck',
  looping: 'Agent repeats the same failure',
  finished: 'Work finished or PR ready',
  machine: 'Machine in trouble',
  control: 'Someone takes over your device',
};

export const NOTIFY_LEVEL_OPTIONS: Option<NotifyLevel>[] = [
  { value: 'alert', label: 'Alert' },
  { value: 'silent', label: 'Silent' },
  { value: 'off', label: 'Off' },
];

export const STUCK_MINUTES_OPTIONS: Option<string>[] = [5, 10, 15, 30, 60].map((minutes) => ({
  value: String(minutes),
  label: `${minutes} min`,
}));

export const QUIET_HOURS_OPTIONS: Option<string>[] = [
  { value: 'off', label: 'Off' },
  { value: '1320-420', label: '10 PM to 7 AM' },
  { value: '1380-480', label: '11 PM to 8 AM' },
  { value: '0-480', label: 'Midnight to 8 AM' },
];

export const quietHoursValue = (quietHours: QuietHours | null): string =>
  quietHours ? `${quietHours.start}-${quietHours.end}` : 'off';

export function parseQuietHoursValue(value: string): QuietHours | null {
  const [start, end] = value.split('-').map(Number);
  return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end)
    ? { start, end }
    : null;
}

export const NOTIFICATIONS_FOOTER =
  'In the background, notifications arrive only if your Mac sends push notifications.';
