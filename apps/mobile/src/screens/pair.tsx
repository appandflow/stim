import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CLIENT } from '@/hooks/mac-connection';
import { pair } from '@/lib/connection';
import { renameMac, saveMac } from '@/lib/macs';
import { manualPairing, parsePairingCode } from '@/lib/pairing';
import type { PairingPayload } from '@/protocol/types';
import { mono, radius, useColors, type Colors } from '@/theme';

type Step =
  | { kind: 'scan' }
  | { kind: 'manual' }
  | { kind: 'connecting'; endpoint: string }
  | { kind: 'name'; id: string; name: string };

export function Pair() {
  const colors = useColors();
  const router = useRouter();
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
    void start(parsed.payload, 'manual');
  };

  const onSave = async () => {
    if (step.kind !== 'name') return;
    if (name.trim() && name.trim() !== step.name) await renameMac(step.id, name.trim());
    router.dismiss();
    router.push({ pathname: '/mac/[id]', params: { id: step.id } });
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {step.kind === 'scan' ? <Scanner colors={colors} onScanned={onScanned} /> : null}
        {step.kind === 'manual' ? (
          <View style={styles.form}>
            <Field
              colors={colors}
              mono
              label="Endpoint"
              value={endpoint}
              onChangeText={setEndpoint}
              placeholder="wss://my-mac.tail1234.ts.net:7443"
            />
            <Field
              colors={colors}
              mono
              label="Pairing token"
              value={token}
              onChangeText={setToken}
              placeholder="From Pair a phone in Stim Desktop"
            />
            <Button colors={colors} title="Pair" onPress={onManual} />
          </View>
        ) : null}
        {step.kind === 'connecting' ? (
          <View style={styles.connecting}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.hint, { color: colors.secondary }]}>Pairing with {step.endpoint}</Text>
          </View>
        ) : null}
        {step.kind === 'name' ? (
          <View style={styles.form}>
            <Text style={[styles.title, { color: colors.text }]}>Paired</Text>
            <Field colors={colors} label="Name this Mac" value={name} onChangeText={setName} placeholder={step.name} />
            <Button colors={colors} title="Save" onPress={onSave} />
          </View>
        ) : null}
        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
        {step.kind === 'scan' || step.kind === 'manual' ? (
          <Pressable
            onPress={() => {
              setError(null);
              setStep(step.kind === 'scan' ? { kind: 'manual' } : { kind: 'scan' });
            }}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={[styles.link, { color: colors.primary }]}>
              {step.kind === 'scan' ? 'Enter the endpoint and token instead' : 'Scan a QR code instead'}
            </Text>
          </Pressable>
        ) : null}
        <Text style={[styles.hint, { color: colors.tertiary }]}>
          Stim Desktop shows the code under Pair a phone. The phone connects through Tailscale, so it works on any
          network where both devices are signed in to the same tailnet.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Scanner({ colors, onScanned }: { colors: Colors; onScanned: (result: BarcodeScanningResult) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission) return <View style={[styles.camera, { backgroundColor: colors.screen }]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.camera, styles.cameraMessage, { backgroundColor: colors.raised }]}>
        <Text style={[styles.hint, { color: colors.secondary }]}>
          Stim needs the camera to scan the pairing QR code.
        </Text>
        {permission.canAskAgain ? <Button colors={colors} title="Allow camera" onPress={requestPermission} /> : null}
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
  colors,
  label,
  mono: monospaced = false,
  ...input
}: {
  colors: Colors;
  label: string;
  mono?: boolean;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.secondary }]}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.tertiary}
        style={[
          styles.input,
          { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border },
          monospaced && { fontFamily: mono },
        ]}
      />
    </View>
  );
}

function Button({ colors, title, onPress }: { colors: Colors; title: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.button, { backgroundColor: colors.primary }]}
      accessibilityRole="button"
    >
      <Text style={[styles.buttonText, { color: colors.onPrimary }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 18 },
  camera: { width: '100%', aspectRatio: 1, borderRadius: radius.card, overflow: 'hidden' },
  cameraMessage: { alignItems: 'center', justifyContent: 'center', gap: 14, padding: 20 },
  form: { gap: 14 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  button: { alignItems: 'center', paddingVertical: 13, paddingHorizontal: 20, borderRadius: radius.card },
  buttonText: { fontSize: 16, fontWeight: '600' },
  connecting: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  title: { fontSize: 22, fontWeight: '600' },
  error: { fontSize: 14 },
  link: { fontSize: 15, fontWeight: '500', textAlign: 'center' },
  hint: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
