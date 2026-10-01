import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState, type Ref } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, TextInput, View, type TextInputProps } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import {
  Transformer,
  TransformerTextInput,
  type TransformerTextInputInstance,
} from 'react-native-transformer-text-input';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button, IconButton } from '@/components/button';
import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { CLIENT, useMacs } from '@/hooks/machines';
import { pair } from '@/lib/connection';
import { renameMac, saveMac } from '@/lib/macs';
import { manualPairing, parsePairingCode } from '@/lib/pairing';
import type { PairingPayload } from '@/protocol/types';

const FALLBACK_DEVICE_NAME = 'Phone';

const tokenTransformer = new Transformer(({ value, selection }) => {
  'worklet';
  const invalid = /[^A-Za-z0-9_-]/g;
  const cleaned = value.replace(invalid, '');
  if (cleaned === value) return null;
  const caret = value.slice(0, selection.end).replace(invalid, '').length;
  return { value: cleaned, selection: { start: caret, end: caret } };
});

type Step =
  | { kind: 'scan' }
  | { kind: 'manual' }
  | { kind: 'connecting'; endpoint: string }
  | { kind: 'name'; id: string; name: string };

async function pairAndSave(payload: PairingPayload): Promise<{ id: string; name: string }> {
  const paired = await pair(
    payload.endpoint,
    payload.pairingToken,
    Constants.deviceName ?? FALLBACK_DEVICE_NAME,
    CLIENT,
  );
  const name = payload.name || paired.serverName;
  const mac = await saveMac({ name, endpoint: payload.endpoint }, paired.deviceToken);
  return { id: mac.id, name };
}

export function Pair() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { reload } = useMacs();
  const [step, setStep] = useState<Step>({ kind: 'scan' });
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const tokenInput = useRef<TransformerTextInputInstance>(null);
  const [name, setName] = useState('');
  const busy = useRef(false);
  const connectingTo = step.kind === 'connecting' ? step.endpoint : '';

  const start = async (payload: PairingPayload, from: 'scan' | 'manual') => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setStep({ kind: 'connecting', endpoint: payload.endpoint });
    try {
      const saved = await pairAndSave(payload);
      reload();
      setName(saved.name);
      setStep({ kind: 'name', ...saved });
    } catch (e) {
      setError((e as Error).message);
      setStep({ kind: from });
    }
    busy.current = false;
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
    tokenInput.current?.clear();
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
            <IconButton icon="xmark" tone="default" accessibilityLabel={t`Close`} onPress={() => router.dismiss()} />
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {step.kind === 'scan' ? <Scanner onScanned={onScanned} /> : null}
        {step.kind === 'manual' ? (
          <View style={styles.form}>
            <Field
              mono
              label={t`Endpoint`}
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
              label={t`Pairing token`}
              tokenRef={tokenInput}
              value={token}
              onChangeText={setToken}
              placeholder={t`From Pair a phone in Stim Desktop`}
              textContentType="oneTimeCode"
              autoComplete="off"
              importantForAutofill="no"
            />
            <Button title={t`Pair`} onPress={onManual} />
          </View>
        ) : null}
        {step.kind === 'connecting' ? (
          <View style={styles.connecting}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text variant="footnote" tone="secondary" style={styles.centered}>
              <Trans>Pairing with {connectingTo}</Trans>
            </Text>
          </View>
        ) : null}
        {step.kind === 'name' ? (
          <View style={styles.form}>
            <Text variant="title" weight="semibold">
              <Trans>Paired</Trans>
            </Text>
            <Field label={t`Name this machine`} value={name} onChangeText={setName} placeholder={step.name} />
            <Button title={t`Save`} onPress={onSave} />
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
              {step.kind === 'scan' ? t`Enter the endpoint and token instead` : t`Scan a QR code instead`}
            </Text>
          </Touch>
        ) : null}
        <Text variant="footnote" tone="tertiary" style={styles.centered}>
          <Trans>
            Stim Desktop shows the code under Pair a phone. The phone connects through Tailscale, so it works on any
            network where both devices are signed in to the same tailnet.
          </Trans>
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
        <View style={styles.cameraBody}>
          <Text variant="footnote" tone="secondary" style={styles.centered}>
            <Trans>Stim needs the camera to scan the pairing QR code.</Trans>
          </Text>
          {permission.canAskAgain ? <Button title={t`Allow camera`} onPress={requestPermission} /> : null}
        </View>
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
  tokenRef,
  value,
  ...input
}: {
  label: string;
  mono?: boolean;
  secret?: boolean;
  tokenRef?: Ref<TransformerTextInputInstance>;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  textContentType?: TextInputProps['textContentType'];
  autoComplete?: 'off';
  importantForAutofill?: TextInputProps['importantForAutofill'];
}) {
  const { theme } = useUnistyles();
  const [revealed, setRevealed] = useState(false);
  const shared = {
    accessibilityLabel: label,
    autoCapitalize: 'none',
    autoCorrect: false,
    spellCheck: false,
    placeholderTextColor: theme.colors.tertiary,
    style: styles.input(monospaced),
  } satisfies TextInputProps;
  return (
    <View style={styles.field}>
      <Text variant="footnote" weight="medium" tone="secondary">
        {label}
      </Text>
      <View style={styles.inputRow}>
        {tokenRef ? (
          <TransformerTextInput
            {...input}
            defaultValue={value}
            ref={tokenRef}
            transformer={tokenTransformer}
            {...shared}
            secureTextEntry={secret && !revealed}
          />
        ) : (
          <TextInput {...input} value={value} {...shared} secureTextEntry={secret && !revealed} />
        )}
        {secret ? (
          <Touch
            onPress={() => setRevealed((r) => !r)}
            accessibilityLabel={revealed ? t`Hide token` : t`Show token`}
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
  cameraMessage: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.raised },
  cameraBody: { alignSelf: 'stretch', gap: theme.space.lg, paddingHorizontal: theme.space.xxl },
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
