import { t } from '@lingui/core/macro';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ScrollView } from '@/components/lists';
import { useMacs } from '@/hooks/machines';
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
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel={t`Machine name`}
        onSubmitEditing={save}
        returnKeyType="done"
        style={styles.input}
      />
      <Button title={t`Save`} onPress={save} />
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
