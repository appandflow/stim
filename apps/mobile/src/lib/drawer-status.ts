import { t } from '@lingui/core/macro';

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

const lowDisk = (name: string) => t`${name}: low disk`;

const unreachableText = (machine: DrawerMachine): string => {
  const { name } = machine;
  return machine.state.kind === 'waiting' ? t`Reconnecting to ${name}\u2026` : t`Disconnected from ${name}`;
};

/**
 * The drawer footer's one status line. Highest priority first: a paired machine that's disconnected or
 * reconnecting, a machine critically low on disk, a machine getting
 * low on disk, or else `normalText` (the app's version).
 */
export function drawerStatus(machines: DrawerMachine[], normalText: string): DrawerStatus {
  const unreachable = machines.find(
    (m) => !m.missing && (m.state.kind === 'waiting' || m.state.kind === 'refused' || m.state.kind === 'closed'),
  );
  if (unreachable) return { text: unreachableText(unreachable), tone: 'warn', macId: null };

  const critical = machines.find((m) => m.diskTone === 'critical');
  if (critical) return { text: lowDisk(critical.name), tone: 'critical', macId: critical.id };

  const warn = machines.find((m) => m.diskTone === 'warn');
  if (warn) return { text: lowDisk(warn.name), tone: 'warn', macId: warn.id };

  return { text: normalText, tone: 'normal', macId: null };
}
