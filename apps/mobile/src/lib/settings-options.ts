import type { HomeView } from '@/hooks/home-filters';
import type { NotifyEvent } from '@/lib/attention';
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

export const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
  'build-failed': 'Build failed',
  'log-errors': 'New log errors',
  disk: 'Disk below the floor',
  offline: 'Machine offline or refused',
  'app-stopped': 'App stopped',
  'slow-build': 'Build far over its usual time',
};

export const AGENT_ONLY_LABEL = 'Only workspaces an agent drives';

export const NOTIFICATIONS_FOOTER =
  "Each problem notifies once. On iPhone, a Mac whose stim-server sends push notifications notifies while Stim is in the background or closed, as long as stim-server runs; they pass through Expo's push service and Apple. Everything else, including a machine going offline and every notification on Android, arrives only while Stim is open: the connection to the Mac closes seconds after you leave the app. The agent filter skips workspaces with no device an agent drives right now.";
