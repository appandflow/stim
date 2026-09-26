import type { ConnectionState } from '@/lib/connection';
import type { UsageTone } from '@/lib/home';

export interface DrawerMachine {
  id: string;
  name: string;
  state: ConnectionState;
  missing: boolean;
  /** This machine's disk tone, from `machineStats`' `disk` entry; `'normal'` when there is no usage yet. */
  diskTone: UsageTone;
}

export type DrawerStatusTone = 'normal' | 'warn' | 'critical';

export interface DrawerStatus {
  text: string;
  tone: DrawerStatusTone;
  /** The machine to open when this status is tapped, for a low-disk row; null for every other status. */
  macId: string | null;
}

export const UPDATE_READY_TEXT = 'Update ready: restart to apply';

const unreachableText = (machine: DrawerMachine): string =>
  machine.state.kind === 'waiting' ? `Reconnecting to ${machine.name}…` : `Disconnected from ${machine.name}`;

/**
 * The drawer footer's one status line. Highest priority first: a paired machine that's disconnected or
 * reconnecting, a machine critically low on disk, a downloaded update waiting for a restart, a machine getting
 * low on disk, or else `normalText` (the app's version).
 */
export function drawerStatus(machines: DrawerMachine[], updateReady: boolean, normalText: string): DrawerStatus {
  const unreachable = machines.find(
    (m) => !m.missing && (m.state.kind === 'waiting' || m.state.kind === 'refused' || m.state.kind === 'closed'),
  );
  if (unreachable) return { text: unreachableText(unreachable), tone: 'warn', macId: null };

  const critical = machines.find((m) => m.diskTone === 'critical');
  if (critical) return { text: `${critical.name}: low disk`, tone: 'critical', macId: critical.id };

  if (updateReady) return { text: UPDATE_READY_TEXT, tone: 'normal', macId: null };

  const warn = machines.find((m) => m.diskTone === 'warn');
  if (warn) return { text: `${warn.name}: low disk`, tone: 'warn', macId: warn.id };

  return { text: normalText, tone: 'normal', macId: null };
}
