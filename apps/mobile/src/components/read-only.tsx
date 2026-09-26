import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

import { Chip } from '@/components/chip';
import { pairingScope, type ConnectionState, type StimConnection } from '@/lib/connection';
import { useColors } from '@/theme';

export const READ_ONLY_REASON = 'This phone is read-only';

export function grantCommand(deviceId: string | null): string {
  return `stim-server devices grant ${deviceId ?? '<id>'} --control`;
}

/** How to let this phone control devices, for a pairing the Mac made read-only. */
export function allowControlSteps(macName: string | undefined, deviceId: string | null): string {
  const where = macName ?? 'the Mac';
  const lookup = deviceId ? '' : " (`stim-server devices` lists this phone's id)";
  return `On ${where}, open Stim Desktop, Settings → Phones, and turn on Allow control for this phone. Or run \`${grantCommand(deviceId)}\`${lookup}. Then reconnect.`;
}

export function explainReadOnly(
  macName: string | undefined,
  state: ConnectionState,
  connection: StimConnection | null,
) {
  const deviceId = state.kind === 'open' ? state.deviceId : null;
  Alert.alert(READ_ONLY_REASON, allowControlSteps(macName, deviceId), [
    ...(deviceId
      ? [{ text: 'Copy command', onPress: () => void Clipboard.setStringAsync(grantCommand(deviceId)) }]
      : []),
    { text: 'Reconnect', onPress: () => connection?.reconnect() },
    { text: 'OK', style: 'cancel' as const },
  ]);
}

/** The pairing's scope as a chip: nothing while not connected, since only `hello` says. */
export function ScopeChip({ state }: { state: ConnectionState }) {
  const colors = useColors();
  const scope = pairingScope(state);
  if (!scope) return null;
  return scope === 'control' ? <Chip tint={colors.live}>Can control</Chip> : <Chip tint={colors.warn}>Read-only</Chip>;
}
