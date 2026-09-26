import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { useMacs } from '@/hooks/mac-connection';
import { listMacs, renameMac } from '@/lib/macs';

export function Rename({ id }: { id: string }) {
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
    <View style={styles.container}>
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel="Machine name"
        onSubmitEditing={save}
        returnKeyType="done"
        style={styles.input}
      />
      <Button title="Save" onPress={save} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, padding: theme.space.xxl, gap: theme.space.lg, backgroundColor: theme.colors.background },
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
