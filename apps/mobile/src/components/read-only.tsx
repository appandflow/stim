import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

import { Pill } from '@/components/pill';
import { pairingScope, type ConnectionState, type StimConnection } from '@/lib/connection';

export function readOnlyReason(): string {
  return t`This phone is read-only`;
}

export function grantCommand(deviceId: string | null): string {
  return `stim-server devices grant ${deviceId ?? '<id>'} --control`;
}

/** How to let this phone control devices, for a pairing the Mac made read-only. */
export function allowControlSteps(macName: string | undefined, deviceId: string | null): string {
  const where = macName ?? t`the Mac`;
  const lookup = deviceId ? '' : t` (\`stim-server devices\` lists this phone's id)`;
  const command = grantCommand(deviceId);
  return t`On ${where}, open Stim Desktop, Settings \u2192 Phones, and turn on Allow control for this phone. Or run \`${command}\`${lookup}. Then reconnect.`;
}

export function explainReadOnly(
  macName: string | undefined,
  state: ConnectionState,
  connection: StimConnection | null,
) {
  const deviceId = state.kind === 'open' ? state.deviceId : null;
  Alert.alert(readOnlyReason(), allowControlSteps(macName, deviceId), [
    ...(deviceId
      ? [{ text: t`Copy command`, onPress: () => void Clipboard.setStringAsync(grantCommand(deviceId)) }]
      : []),
    { text: t`Reconnect`, onPress: () => connection?.reconnect() },
    { text: t`OK`, style: 'cancel' as const },
  ]);
}

/** The pairing's scope as a pill: nothing while not connected, since only `hello` says. */
export function ScopeChip({ state }: { state: ConnectionState }) {
  const scope = pairingScope(state);
  if (!scope) return null;
  return scope === 'control' ? (
    <Pill tone="success">
      <Trans>Can control</Trans>
    </Pill>
  ) : (
    <Pill tone="warning">
      <Trans>Read-only</Trans>
    </Pill>
  );
}
