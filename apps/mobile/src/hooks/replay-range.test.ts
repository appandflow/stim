import { act, renderHook } from '@testing-library/react-native';

import type { ReplayRange } from '@/protocol/types';

import { useReplayRange } from './replay-range';

const mockAnswers: ((range: ReplayRange) => void)[] = [];
const mockConnection = {
  request: jest.fn(() => new Promise<ReplayRange>((resolve) => mockAnswers.push(resolve))),
};

jest.mock('@/hooks/machines', () => ({
  useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open' } }),
}));

const range = (end: number): ReplayRange => ({
  enabled: true,
  recording: true,
  spans: [{ start: 0, end }],
  markers: [],
});

beforeEach(() => {
  jest.useFakeTimers();
  mockAnswers.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

test('an answer to an older poll does not replace a newer one', async () => {
  const { result } = await renderHook(() => useReplayRange({ workspace: '/app', platform: 'ios', slot: 'default' }));
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(mockAnswers).toHaveLength(2);
  await act(async () => mockAnswers[1]!(range(2000)));
  expect(result.current?.spans).toEqual([{ start: 0, end: 2000 }]);
  await act(async () => mockAnswers[0]!(range(1000)));
  expect(result.current?.spans).toEqual([{ start: 0, end: 2000 }]);
});
