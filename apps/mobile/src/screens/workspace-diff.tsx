import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list';
import { Text } from '@/components/text';
import { useMacConnection } from '@/hooks/machines';
import { usePolledRequest } from '@/hooks/polled-request';
import type { WorkspacePatch } from '@/protocol/types';

function sectionName(section: WorkspacePatch['section']): string {
  return section === 'staged'
    ? t`Staged`
    : section === 'unstaged'
      ? t`Unstaged`
      : section === 'untracked'
        ? t`New file`
        : t`Unknown`;
}

function patchNote(patch: WorkspacePatch): string {
  if (patch.kind === 'binary') return t`Binary file: preview unavailable.`;
  if (patch.kind === 'too-large') return t`This patch exceeds the 256 KiB preview limit.`;
  if (patch.kind === 'unavailable') return patch.text;
  if (patch.kind !== 'text') return t`Unknown`;
  if (patch.section === 'untracked') return t`Empty new file.`;
  return t`No diff remains in this section. Refresh the file list if the file changed on the Mac.`;
}

export function WorkspaceDiff({ path, file, group }: { path: string; file?: string; group: 'changed' | 'untracked' }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const { connection, state, mac } = useMacConnection();
  const supported = state.kind === 'open' && state.features.includes('workspace-diff');
  const files = usePolledRequest(
    connection,
    'workspace.files',
    { workspace: path, group },
    { active: supported && focused && file === undefined },
  );
  const patch = usePolledRequest(
    connection,
    'workspace.diff',
    { workspace: path, path: file ?? '' },
    { active: supported && focused && file !== undefined },
  );
  const rows = files.data?.files ?? [];
  const lines = useMemo(
    () =>
      patch.data?.patches.flatMap((part, section) => {
        const texts = part.text.split('\n');
        if (texts.at(-1) === '') texts.pop();
        const firstHunk = texts.findIndex((text) => text.startsWith('@@'));
        return [
          { key: `${section}:header`, text: sectionName(part.section), kind: 'header' },
          ...(part.kind === 'text' && part.text
            ? texts.map((text, index) => ({
                key: `${section}:${index}`,
                text,
                kind:
                  part.section === 'untracked'
                    ? 'new'
                    : firstHunk === -1 || index < firstHunk
                      ? 'context'
                      : text.startsWith('+')
                        ? 'add'
                        : text.startsWith('-')
                          ? 'remove'
                          : text.startsWith('@@')
                            ? 'hunk'
                            : 'context',
              }))
            : [{ key: `${section}:note`, text: patchNote(part), kind: 'note' }]),
        ];
      }) ?? [],
    [patch.data],
  );
  const request = file === undefined ? files : patch;
  const title = file ?? (group === 'untracked' ? t`New files` : t`Changed files`);
  const note =
    state.kind !== 'open'
      ? t`Connect to the Mac to view changes.`
      : !supported
        ? t`Update Stim on the Mac to view workspace diffs.`
        : (request.error?.message ?? (!request.data ? t`Loading changes...` : null));
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title, headerTransparent: false, headerBlurEffect: undefined }} />
      {note ? (
        <View style={styles.note}>
          <Text selectable tone={request.error ? 'error' : 'secondary'}>
            {note}
          </Text>
          {request.error ? <Button title={t`Retry`} onPress={request.refetch} /> : null}
        </View>
      ) : file === undefined ? (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.path}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: insets.bottom + theme.space.xl }}
          ListHeaderComponent={
            files.data?.truncated ? (
              <Text tone="secondary" style={styles.note}>
                <Trans>
                  Showing up to 200 files within the preview size limit. More changes are available on the Mac.
                </Trans>
              </Text>
            ) : undefined
          }
          ListEmptyComponent={
            <Text tone="secondary" style={styles.note}>
              <Trans>No files remain in this group.</Trans>
            </Text>
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.path}
              subtitle={
                item.untracked
                  ? t`New file`
                  : [item.staged ? t`Staged` : null, item.unstaged ? t`Unstaged` : null]
                      .filter(Boolean)
                      .join(' \u00B7 ')
              }
              accessory="chevron"
              onPress={() =>
                router.push({ pathname: '/mac/[id]/diff', params: { id: mac?.id ?? '', path, file: item.path, group } })
              }
            />
          )}
        />
      ) : (
        <FlatList
          data={lines}
          keyExtractor={(item) => item.key}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: insets.bottom + theme.space.xl }}
          ListEmptyComponent={
            <Text tone="secondary" style={styles.note}>
              <Trans>No diff remains. Refresh the file list.</Trans>
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.line(item.kind)}>
              <Text
                selectable
                mono={item.kind !== 'header' && item.kind !== 'note'}
                variant="footnote"
                weight={item.kind === 'header' ? 'semibold' : undefined}
                tone={
                  item.kind === 'remove'
                    ? 'error'
                    : item.kind === 'add' || item.kind === 'new'
                      ? 'success'
                      : item.kind === 'hunk'
                        ? 'brand'
                        : 'default'
                }
              >
                {item.text || ' '}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  note: { padding: theme.space.lg, gap: theme.space.md },
  line: (kind: string) => ({
    paddingHorizontal: theme.space.md,
    paddingVertical: kind === 'header' ? theme.space.md : 2,
    backgroundColor: kind === 'header' ? theme.colors.surface : undefined,
  }),
}));
