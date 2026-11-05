import type { ConnectionState } from '@/lib/connection';
import type { MachineUsage, StatusPayload } from '@/protocol/types';

export interface AttentionMachine {
  id: string;
  name: string;
  state: ConnectionState;
  missing: boolean;
  status: StatusPayload | null;
  usage: MachineUsage | null;
  /** The Mac's home folder, shown as `~` in issue messages. */
  home: string | null;
  /** When the connection last dropped; null while connected or before the first connection. */
  disconnectedAt: number | null;
  /** When a status cached before this launch was last known current; null once connected. */
  seenAt: number | null;
}
