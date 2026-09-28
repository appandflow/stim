import { act, renderHook } from '@testing-library/react-native';

import { useDeviceStream } from './device-stream';

const mockAnswers: ((result: { subscription: string; video?: 'h264' }) => void)[] = [];
const mockConnection = {
  subscribe: jest.fn((_method: string, _params: unknown, _event: unknown, answered: (typeof mockAnswers)[number]) => {
    mockAnswers.push(answered);
    return () => {};
  }),
};

jest.mock('@/hooks/mac-connection', () => ({ useMacConnection: () => ({ connection: mockConnection }) }));
jest.mock('../../modules/stim-video/src', () => ({ pushAccessUnit: () => {} }));

const TARGET = { workspace: '/app', platform: 'ios' as const, slot: 'default' };
const OPTIONS = { enabled: true, fps: 30, maxEdge: 720, video: ['h264' as const] };

beforeEach(() => {
  mockAnswers.length = 0;
});

test.each([
  [{ subscription: 's1', video: 'h264' as const }, true],
  [{ subscription: 's1' }, false],
])('reports whether the server granted the H.264 a replay needs', async (answer, replayable) => {
  const { result } = await renderHook(() => useDeviceStream(TARGET, OPTIONS));
  expect(result.current.replayable).toBeNull();
  expect(mockAnswers).toHaveLength(1);
  await act(async () => mockAnswers[0]!(answer));
  expect(result.current.replayable).toBe(replayable);
});
