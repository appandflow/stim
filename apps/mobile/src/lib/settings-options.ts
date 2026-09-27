import type { HomeView } from '@/hooks/home-filters';
import type { QuietHours } from '@/lib/notifications';
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

export const HOME_FOOTER = 'Home opens on this view. Idle workspaces are those with nothing running.';

export const VIDEO_QUALITY_FOOTER =
  "Auto matches this phone's screen, up to 1600 pixels. High always asks for 1600 pixels. Both stream video at up to 60 fps. Data saver sends still frames at up to 10 fps and 640 pixels.";

export const READ_ONLY_FOOTER =
  "A read-only machine shows its status but can't run actions or control devices from this phone. Tap it to see how to allow control.";

export const NOTIFY_CATEGORY_LABELS: Record<OversightCategory, string> = {
  started: 'Work started',
  stuck: 'Agent looks stuck',
  looping: 'Agent repeats the same failure',
  finished: 'Work finished or PR ready',
  machine: 'Machine in trouble',
  control: 'Someone takes over your device',
};

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
  "Stim notifies when your attention changes the outcome, or when work you wait on starts or finishes. A single failed build, new log errors, a stopped app or a slow build stay in home's attention list. Each workspace notifies once per episode, and a later notification replaces the earlier one. Work started arrives silently. Quiet hours hold notifications, and a problem that still holds when they end notifies then. On iPhone, a Mac whose stim-server sends push notifications notifies while Stim is in the background or closed, as long as stim-server runs; they pass through Expo's push service and Apple. Only a Mac that pushes can tell when a pull request is ready or merged, or when someone takes over a device you control. Everything else, including a machine going offline and every notification on Android, arrives only while Stim is open or when you next open it: the connection to the Mac closes seconds after you leave the app.";
