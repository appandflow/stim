import 'react-native-unistyles/mocks';
import { render, waitFor } from '@testing-library/react-native';

import '@/design/unistyles';
import ArchiveReplayRoute from '@/app/mac/[id]/archived-replay';
import realArchive from '../../mock-server/fixtures/real-archive/archive.json';

let mockParams = { archive: realArchive.id, platform: 'ios', slot: 'default', at: '175' };
let mockNow = Date.parse(realArchive.removedAt);
const mockConnection = { request: jest.fn() };
const mockStream: jest.Mock = jest.fn(() => ({}));
const mockArchives = [realArchive];
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
}));
jest.mock('@/hooks/app-foreground', () => ({ useAppForeground: () => true }));
jest.mock('@/hooks/machines', () => ({
  useStatus: () => ({ archived: mockArchives }),
  useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open' } }),
}));
jest.mock('@/hooks/use-now', () => ({ useNow: () => mockNow }));
jest.mock('@/hooks/device-stream', () => ({ useDeviceStream: (...args: unknown[]) => mockStream(...args) }));
jest.mock('@/components/route-error-boundary', () => ({ RouteErrorBoundary: () => null }));
jest.mock('@/components/device-screen', () => ({
  DeviceScreen: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Recorded footage</Text>;
  },
}));
jest.mock('@/components/replay-bar', () => ({ ReplayBar: () => null }));

beforeEach(() => {
  mockConnection.request.mockReset();
  mockConnection.request.mockResolvedValue({
    spans: [{ start: 100, end: 200 }],
    markers: [],
    enabled: true,
    recording: false,
  });
  mockStream.mockClear();
  mockParams = { archive: realArchive.id, platform: 'ios', slot: 'default', at: '175' };
  mockNow = Date.parse(realArchive.removedAt);
});

test('opens a retained non-default slot and clamps a notification outside its closed footage', async () => {
  mockParams = { ...mockParams, platform: 'android', slot: 'tablet', at: '300' };
  await render(<ArchiveReplayRoute />);
  await waitFor(() =>
    expect(mockStream).toHaveBeenCalledWith(
      { archive: realArchive.id, platform: 'android', slot: 'tablet' },
      expect.objectContaining({ startAt: 200 }),
    ),
  );
});

test('labels elapsed retention while replaying footage still served by the server', async () => {
  mockNow = Date.parse(realArchive.expires.recordings) + 1;
  const screen = await render(<ArchiveReplayRoute />);
  expect(await screen.findByText('Recorded footage')).toBeTruthy();
  expect(screen.getByText('Expired')).toBeTruthy();
});
