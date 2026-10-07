import 'react-native-unistyles/mocks';
import { render } from '@testing-library/react-native';

import '@/design/unistyles';
import ArchiveReplayRoute from '@/app/mac/[id]/archived-replay';
import realArchive from '../../mock-server/fixtures/real-archive/archive.json';

let mockParams = { archive: realArchive.id, platform: 'ios', slot: 'default', at: '175' };
let mockNow = Date.parse(realArchive.removedAt);
const mockRange: jest.Mock = jest.fn(() => ({ data: { spans: [{ start: 100, end: 200 }], markers: [] }, error: null }));
const mockStream: jest.Mock = jest.fn(() => ({}));
const mockArchives = [realArchive];
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
}));
jest.mock('@/hooks/app-foreground', () => ({ useAppForeground: () => true }));
jest.mock('@/hooks/machines', () => ({ useStatus: () => ({ archived: mockArchives }) }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => mockNow }));
jest.mock('@/hooks/replay-range', () => ({ useReplayRangeState: (...args: unknown[]) => mockRange(...args) }));
jest.mock('@/hooks/device-stream', () => ({ useDeviceStream: (...args: unknown[]) => mockStream(...args) }));
jest.mock('@/components/route-error-boundary', () => ({ RouteErrorBoundary: () => null }));
jest.mock('@/components/device-screen', () => ({ DeviceScreen: () => null }));
jest.mock('@/components/replay-bar', () => ({ ReplayBar: () => null }));

beforeEach(() => {
  mockRange.mockClear();
  mockStream.mockClear();
  mockParams = { archive: realArchive.id, platform: 'ios', slot: 'default', at: '175' };
  mockNow = Date.parse(realArchive.removedAt);
});

test('preserves notification replay time and archive target, with the default slot for old deep links', async () => {
  await render(<ArchiveReplayRoute />);
  expect(mockRange).toHaveBeenCalledWith({ archive: realArchive.id, platform: 'ios', slot: 'default' }, true);
  expect(mockStream).toHaveBeenCalledWith(
    { archive: realArchive.id, platform: 'ios', slot: 'default' },
    expect.objectContaining({ startAt: 175 }),
  );
});

test('opens a retained non-default slot and clamps a notification outside its closed footage', async () => {
  mockParams = { ...mockParams, platform: 'android', slot: 'tablet', at: '300' };
  await render(<ArchiveReplayRoute />);
  expect(mockStream).toHaveBeenCalledWith(
    { archive: realArchive.id, platform: 'android', slot: 'tablet' },
    expect.objectContaining({ startAt: 200 }),
  );
});

test('shows expiry and makes no frame request after recording retention ends', async () => {
  mockNow = Date.parse(realArchive.expires.recordings) + 1;
  const screen = await render(<ArchiveReplayRoute />);
  expect(screen.getByText('Expired')).toBeTruthy();
  expect(mockRange).toHaveBeenCalledWith({ archive: realArchive.id, platform: 'ios', slot: 'default' }, false);
  expect(mockStream).not.toHaveBeenCalled();
});
