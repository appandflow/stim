import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ScrollView } from '@/components/lists';
import { Text } from '@/components/text';
import { useMacs } from '@/hooks/machines';
import { RequestError } from '@/lib/connection';
import { listMacs, renameMac } from '@/lib/macs';

export function Rename({ id, on }: { id: string; on?: string }) {
  const router = useRouter();
  const { reload, connections } = useMacs();
  const machineMode = on === 'machine';
  const link = connections.find((entry) => entry.mac.id === id);
  const state = link?.state;
  const connected = state?.kind === 'open' && !!state.deviceId;
  const machine = state?.kind === 'open' ? state.server.name : (link?.mac.name ?? '');
  const deviceId = state?.kind === 'open' ? state.deviceId : '';
  const [saving, setSaving] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(machineMode && state?.kind === 'open' ? (state.deviceName ?? '') : '');

  useEffect(() => {
    if (machineMode) return;
    listMacs().then((macs) => setName(macs.find((m) => m.id === id)?.name ?? ''));
  }, [id, machineMode]);

  const save = async () => {
    if (machineMode) {
      if (!connected || !link?.connection || !deviceId || saving || unsupported || !name.trim()) return;
      setSaving(true);
      setError('');
      try {
        await link.connection.request('device.rename', { id: deviceId, name: name.trim() });
        link.connection.reconnect();
        router.back();
      } catch (error) {
        if (error instanceof RequestError && error.error.code === 'unknown-method') setUnsupported(true);
        else if (error instanceof Error) setError(error.message);
      }
      setSaving(false);
      return;
    }
    if (name.trim()) await renameMac(id, name.trim());
    reload();
    router.back();
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {machineMode ? <Stack.Screen options={{ title: t`Rename This Phone` }} /> : null}
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel={machineMode ? t`Name on the machine` : t`Name on this phone`}
        onSubmitEditing={save}
        returnKeyType="done"
        style={styles.input}
      />
      {error ? <Text tone="error">{error}</Text> : null}
      <Text variant="footnote" tone="secondary">
        {machineMode ? (
          !connected ? (
            <Trans>This phone must be connected to the machine to rename itself there.</Trans>
          ) : unsupported ? (
            <Trans>
              {machine} runs a Stim that cannot rename this phone yet. Update Stim there, or on {machine} run stim
              pairings rename {deviceId} &lt;name&gt;.
            </Trans>
          ) : (
            <Trans>
              This changes how {machine} lists this phone. The name this phone shows for the machine stays the same.
            </Trans>
          )
        ) : (
          <Trans>
            This changes only the name this phone shows for the machine. The name on the machine and its record of this
            phone stay the same.
          </Trans>
        )}
      </Text>
      <Button
        title={t`Save`}
        onPress={save}
        disabled={machineMode && (!connected || saving || unsupported || !name.trim())}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, gap: theme.space.lg },
  input: {
    fontSize: theme.typography.body.fontSize,
    borderWidth: 1,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
}));
