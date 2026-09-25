import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { listMacs, renameMac } from '@/lib/macs';
import { radius, useColors } from '@/theme';

export function Rename({ id }: { id: string }) {
  const colors = useColors();
  const router = useRouter();
  const [name, setName] = useState('');

  useEffect(() => {
    listMacs().then((macs) => setName(macs.find((m) => m.id === id)?.name ?? ''));
  }, [id]);

  const save = async () => {
    if (name.trim()) await renameMac(id, name.trim());
    router.back();
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel="Mac name"
        onSubmitEditing={save}
        returnKeyType="done"
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />
      <Pressable onPress={save} style={[styles.button, { backgroundColor: colors.primary }]} accessibilityRole="button">
        <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Save</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 14 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  button: { alignItems: 'center', paddingVertical: 13, borderRadius: radius.card },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
