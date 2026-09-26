import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, TextInput, View, type TextInputProps } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, IconButton } from '@/components/button';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { CLIENT, useMacs } from '@/hooks/mac-connection';
import { pair } from '@/lib/connection';
import { renameMac, saveMac } from '@/lib/macs';
import { manualPairing, parsePairingCode } from '@/lib/pairing';
import type { PairingPayload } from '@/protocol/types';

type Step =
  | { kind: 'scan' }
  | { kind: 'manual' }
  | { kind: 'connecting'; endpoint: string }
  | { kind: 'name'; id: string; name: string };

export function Pair() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { reload } = useMacs();
  const [step, setStep] = useState<Step>({ kind: 'scan' });
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const busy = useRef(false);

  const start = async (payload: PairingPayload, from: 'scan' | 'manual') => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setStep({ kind: 'connecting', endpoint: payload.endpoint });
    try {
      const deviceName = Constants.deviceName ?? 'Phone';
      const paired = await pair(payload.endpoint, payload.pairingToken, deviceName, CLIENT);
      const suggested = payload.name || paired.serverName;
      const mac = await saveMac({ name: suggested, endpoint: payload.endpoint }, paired.deviceToken);
      reload();
      setName(suggested);
      setStep({ kind: 'name', id: mac.id, name: suggested });
    } catch (e) {
      setError((e as Error).message);
      setStep({ kind: from });
    } finally {
      busy.current = false;
    }
  };

  const onScanned = (result: BarcodeScanningResult) => {
    if (busy.current || step.kind !== 'scan') return;
    const parsed = parsePairingCode(result.data);
    if (!parsed.ok) return setError(parsed.error);
    void start(parsed.payload, 'scan');
  };

  const onManual = () => {
    const parsed = manualPairing(endpoint, token);
    if (!parsed.ok) return setError(parsed.error);
    // iOS offers to save a password when a secure text field leaves the screen with text in it, so the
    // field is emptied, and that change reaches the native view, before the form is replaced.
    setToken('');
    requestAnimationFrame(() => void start(parsed.payload, 'manual'));
  };

  const onSave = async () => {
    if (step.kind !== 'name') return;
    if (name.trim() && name.trim() !== step.name) await renameMac(step.id, name.trim());
    reload();
    router.dismissTo('/');
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <IconButton icon="xmark" tone="brand" accessibilityLabel="Close" onPress={() => router.dismiss()} />
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {step.kind === 'scan' ? <Scanner onScanned={onScanned} /> : null}
        {step.kind === 'manual' ? (
          <View style={styles.form}>
            <Field
              mono
              label="Endpoint"
              value={endpoint}
              onChangeText={setEndpoint}
              placeholder="wss://my-mac.tail1234.ts.net:7443"
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
            />
            <Field
              mono
              secret
              label="Pairing token"
              value={token}
              onChangeText={setToken}
              placeholder="From Pair a phone in Stim Desktop"
              textContentType="oneTimeCode"
              autoComplete="off"
              importantForAutofill="no"
            />
            <Button title="Pair" onPress={onManual} />
          </View>
        ) : null}
        {step.kind === 'connecting' ? (
          <View style={styles.connecting}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text variant="footnote" tone="secondary" style={styles.centered}>
              Pairing with {step.endpoint}
            </Text>
          </View>
        ) : null}
        {step.kind === 'name' ? (
          <View style={styles.form}>
            <Text variant="title" weight="semibold">
              Paired
            </Text>
            <Field label="Name this machine" value={name} onChangeText={setName} placeholder={step.name} />
            <Button title="Save" onPress={onSave} />
          </View>
        ) : null}
        {error ? (
          <Text variant="callout" tone="error">
            {error}
          </Text>
        ) : null}
        {step.kind === 'scan' || step.kind === 'manual' ? (
          <Touch
            onPress={() => {
              setError(null);
              setStep(step.kind === 'scan' ? { kind: 'manual' } : { kind: 'scan' });
            }}
            hitSlop={8}
          >
            <Text variant="body" weight="medium" tone="brand" style={styles.centered}>
              {step.kind === 'scan' ? 'Enter the endpoint and token instead' : 'Scan a QR code instead'}
            </Text>
          </Touch>
        ) : null}
        <Text variant="footnote" tone="tertiary" style={styles.centered}>
          Stim Desktop shows the code under Pair a phone. The phone connects through Tailscale, so it works on any
          network where both devices are signed in to the same tailnet.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Scanner({ onScanned }: { onScanned: (result: BarcodeScanningResult) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View style={[styles.camera, styles.cameraPending]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.camera, styles.cameraMessage]}>
        <Text variant="footnote" tone="secondary" style={styles.centered}>
          Stim needs the camera to scan the pairing QR code.
        </Text>
        {permission.canAskAgain ? <Button title="Allow camera" onPress={requestPermission} /> : null}
      </View>
    );
  }
  return (
    <CameraView
      style={styles.camera}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={onScanned}
    />
  );
}

function Field({
  label,
  mono: monospaced = false,
  secret = false,
  ...input
}: {
  label: string;
  mono?: boolean;
  secret?: boolean;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  textContentType?: TextInputProps['textContentType'];
  autoComplete?: TextInputProps['autoComplete'];
  importantForAutofill?: TextInputProps['importantForAutofill'];
}) {
  const { theme } = useUnistyles();
  const [revealed, setRevealed] = useState(false);
  return (
    <View style={styles.field}>
      <Text variant="footnote" weight="medium" tone="secondary">
        {label}
      </Text>
      <View style={styles.inputRow}>
        <TextInput
          {...input}
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          secureTextEntry={secret && !revealed}
          placeholderTextColor={theme.colors.tertiary}
          style={styles.input(monospaced)}
        />
        {secret ? (
          <Touch
            onPress={() => setRevealed((r) => !r)}
            accessibilityLabel={revealed ? 'Hide token' : 'Show token'}
            hitSlop={8}
            style={styles.reveal}
          >
            <Icon name={revealed ? 'eye.slash' : 'eye'} size={20} color={theme.colors.secondary} />
          </Touch>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: theme.space.xxl, gap: theme.space.xl },
  camera: { width: '100%', aspectRatio: 1, borderRadius: theme.radius.card, overflow: 'hidden' },
  cameraPending: { backgroundColor: theme.media.screen },
  cameraMessage: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.lg,
    padding: theme.space.xxl,
    backgroundColor: theme.colors.raised,
  },
  form: { gap: theme.space.lg },
  field: { gap: theme.space.sm },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  input: (monospaced: boolean) => ({
    flex: 1,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.lg,
    fontSize: theme.typography.body.fontSize,
    color: theme.colors.text,
    fontFamily: monospaced ? theme.mono : undefined,
  }),
  reveal: { paddingHorizontal: theme.space.lg },
  connecting: { alignItems: 'center', gap: theme.space.lg, paddingVertical: 40 },
  centered: { textAlign: 'center' },
}));
