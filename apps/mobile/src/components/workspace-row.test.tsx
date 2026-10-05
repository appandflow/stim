import 'react-native-unistyles/mocks';

import { fireEvent, render } from '@testing-library/react-native';

import '@/design/unistyles';

import type { HomeItem } from '@/lib/home';
import { homeSections } from '@/lib/home-list';

import { WorkspaceGroupRow } from './workspace-row';

jest.mock('@/hooks/machines', () => ({ useMachinePresence: () => ({ online: true, cached: false }) }));
jest.mock('@/hooks/large-text', () => ({ useLargeText: () => false }));
jest.mock('@/components/build-progress', () => ({ PhaseBar: () => null }));
jest.mock('@/components/agent-sessions', () => ({ AgentSessionLine: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));

it('shows the branch and git state once while each app opens its original route and errors', async () => {
  const app = (folder: string, live: boolean): HomeItem => ({
    key: `mac\n/checkout/${folder}`,
    macId: 'mac',
    macName: 'MacBook',
    project: 'stim',
    title: 'feat/monorepo',
    inCheckout: folder,
    env: {
      path: `/checkout/${folder}`,
      live,
      phase: 'ready',
      memoryMb: 0,
      warnings: [],
      logs: { dir: '/logs', errorsSinceMarker: live ? 2 : 0 },
      worktree: {
        path: '/checkout',
        branch: 'feat/monorepo',
        git: { changed: 15, untracked: 0, upstream: 'origin/main', ahead: 0, behind: 0, mergedInto: null },
      },
    },
  });
  const mobile = app('apps/mobile', false);
  const desktop = app('apps/desktop', true);
  const workspace = homeSections([mobile, desktop])[0].data[0];
  const open = jest.fn();
  const screen = await render(
    <WorkspaceGroupRow workspace={workspace} now={Date.now()} folder showsMachine onOpen={open} />,
  );
  expect(screen.getAllByText('feat/monorepo')).toHaveLength(1);
  expect(screen.getAllByText('15 changed')).toHaveLength(1);
  expect(screen.getByText('Ready')).toBeTruthy();
  expect(screen.getByText('Running')).toBeTruthy();
  await fireEvent.press(screen.getByText('apps/mobile'));
  expect(open).toHaveBeenLastCalledWith(mobile, false);
  await fireEvent.press(screen.getByText('apps/desktop'));
  expect(open).toHaveBeenLastCalledWith(desktop, false);
  await fireEvent.press(screen.getByText('2 errors'));
  expect(open).toHaveBeenLastCalledWith(desktop, true);
});
