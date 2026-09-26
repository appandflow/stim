import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Touch } from '@/components/touch';
import { useMacs } from '@/hooks/mac-connection';
import { listMacs, renameMac } from '@/lib/macs';
import { radius, useColors } from '@/theme';

export function Rename({ id }: { id: string }) {
  const colors = useColors();
  const router = useRouter();
  const { reload } = useMacs();
  const [name, setName] = useState('');

  useEffect(() => {
    listMacs().then((macs) => setName(macs.find((m) => m.id === id)?.name ?? ''));
  }, [id]);

  const save = async () => {
    if (name.trim()) await renameMac(id, name.trim());
    reload();
    router.back();
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel="Machine name"
        onSubmitEditing={save}
        returnKeyType="done"
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />
      <Touch feedback="card" onPress={save} style={[styles.button, { backgroundColor: colors.primary }]}>
        <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Save</Text>
      </Touch>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 14 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  button: { alignItems: 'center', paddingVertical: 13, borderRadius: radius.card },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
