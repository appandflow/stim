import 'react-native-unistyles/mocks';

import { act, render } from '@testing-library/react-native';
import '@/design/unistyles';
import { WorkspaceDiff } from './workspace-diff';

let mockFocused = false;
let mockFeatures: string[] = ['workspace-diff'];
const mockRequest = jest.fn();
const mockPush = jest.fn();
const mockConnection = { request: mockRequest };

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useIsFocused: () => mockFocused,
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/hooks/machines', () => ({
  useMacConnection: () => ({
    connection: mockConnection,
    state: { kind: 'open', features: mockFeatures },
    mac: { id: 'fixture' },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/text', () => ({
  Text: jest.requireActual<typeof import('react-native')>('react-native').Text,
}));
jest.mock('@/components/touch', () => ({
  Touch: jest.requireActual<typeof import('react-native')>('react-native').Pressable,
}));

beforeEach(() => {
  mockFocused = false;
  mockFeatures = ['workspace-diff'];
  jest.clearAllMocks();
});

test('fetches the file list only while opened and never prefetches patches', async () => {
  mockRequest.mockResolvedValue({
    files: [{ path: 'source.txt', staged: true, unstaged: false, untracked: false }],
    truncated: false,
  });
  const screen = await render(<WorkspaceDiff path="/fixture" group="changed" />);
  expect(mockRequest).not.toHaveBeenCalled();
  mockFocused = true;
  await screen.rerender(<WorkspaceDiff path="/fixture" group="changed" />);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith('workspace.files', { workspace: '/fixture', group: 'changed' });
});

test('asks only for a selected patch and ignores its stale reply after the workspace changes', async () => {
  mockFocused = true;
  let oldReply!: (value: unknown) => void;
  mockRequest
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldReply = resolve;
        }),
    )
    .mockResolvedValueOnce({ path: 'other.txt', patches: [{ section: 'unstaged', kind: 'text', text: '+current' }] });
  const screen = await render(<WorkspaceDiff path="/fixture" file="source.txt" group="changed" />);
  await screen.rerender(<WorkspaceDiff path="/other" file="other.txt" group="changed" />);
  await act(async () =>
    oldReply({ path: 'source.txt', patches: [{ section: 'unstaged', kind: 'text', text: '+stale' }] }),
  );
  expect(mockRequest.mock.calls).toEqual([
    ['workspace.diff', { workspace: '/fixture', path: 'source.txt' }],
    ['workspace.diff', { workspace: '/other', path: 'other.txt' }],
  ]);
  expect(screen.getByText('+current')).toBeTruthy();
  expect(screen.queryByText('+stale')).toBeNull();
});

test('keeps older servers view-only without sending an unsupported request', async () => {
  mockFocused = true;
  mockFeatures = [];
  const screen = await render(<WorkspaceDiff path="/fixture" group="changed" />);
  expect(mockRequest).not.toHaveBeenCalled();
  expect(screen.getByText('Update Stim on the Mac to view workspace diffs.')).toBeTruthy();
});
