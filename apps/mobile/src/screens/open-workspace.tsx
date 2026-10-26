import { t } from '@lingui/core/macro';
import { Redirect, Stack, useRouter } from 'expo-router';
import { parseWorkspaceLink, WORKSPACE_LINK_ORIGIN } from '@stim-cli/core/workspace-link';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { useMacs } from '@/hooks/machines';
import { resolveWorkspaceLink } from '@/lib/workspace-links';

export function OpenWorkspace({ query }: { query: string }) {
  const router = useRouter();
  const { macs, connections } = useMacs();
  const link = parseWorkspaceLink(`${WORKSPACE_LINK_ORIGIN}/open?${query}`);
  const resolved = link ? (macs ? resolveWorkspaceLink(link, connections) : { kind: 'pending' as const }) : null;
  if (resolved?.kind === 'ready') {
    const params = { id: resolved.macId, path: resolved.path, ...(resolved.slot ? { slot: resolved.slot } : {}) };
    return resolved.platform ? (
      <Redirect href={{ pathname: '/mac/[id]/device', params: { ...params, platform: resolved.platform } }} />
    ) : (
      <Redirect
        href={{
          pathname: '/mac/[id]/workspace',
          params,
        }}
      />
    );
  }
  const message = !resolved
    ? t`This workspace link is incomplete or unsupported.`
    : resolved.kind === 'pending'
      ? t`Waiting for the paired Mac's workspace list.`
      : resolved.kind === 'offline'
        ? t`The Mac is not connected. Connect to it and try the link again.`
        : resolved.kind === 'unsupported'
          ? t`Update Stim and its server to open shared workspace links.`
          : resolved.kind === 'stale'
            ? t`The Mac no longer lists this workspace. Ask for a new link.`
            : t`Pair or reconnect the Mac to open this workspace.`;
  return (
    <>
      <Stack.Screen options={{ title: t`Open Workspace` }} />
      <EmptyState title={t`Open Workspace`} message={message}>
        {resolved?.kind === 'unknown-machine' ? (
          <Button title={t`Pair a Mac`} onPress={() => router.push('/pair')} />
        ) : null}
        {resolved?.kind === 'offline' ? (
          <Button
            title={t`Reconnect`}
            onPress={() => connections.find(({ mac }) => mac.id === resolved.macId)?.connection?.retryNow()}
          />
        ) : null}
        <Button title={t`Back to Workspaces`} variant="secondary" onPress={() => router.replace('/')} />
      </EmptyState>
    </>
  );
}
