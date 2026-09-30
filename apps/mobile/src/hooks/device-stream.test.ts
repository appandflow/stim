import { act, renderHook } from '@testing-library/react-native';

import { useDeviceStream } from './device-stream';

const mockAnswers: ((result: { subscription: string; video?: 'h264' }) => void)[] = [];
const mockPackets: ((packet: {
  capturedAt: number;
  keyframe: boolean;
  width: number;
  height: number;
  accessUnit: Uint8Array;
}) => void)[] = [];
const frame = (capturedAt: number, keyframe = false) => ({
  capturedAt,
  keyframe,
  width: 390,
  height: 844,
  accessUnit: new Uint8Array(1),
});
const mockRequests: { method: string; params: { at?: number }; resolve: (result: unknown) => void }[] = [];
const mockConnection = {
  request: jest.fn(
    (method: string, params: { at?: number }) =>
      new Promise((resolve) => {
        mockRequests.push({ method, params, resolve });
      }),
  ),
  subscribe: jest.fn(
    (
      _method: string,
      _params: unknown,
      _event: unknown,
      answered: (typeof mockAnswers)[number],
      packet: (typeof mockPackets)[number],
    ) => {
      mockAnswers.push(answered);
      mockPackets.push(packet);
      return () => {};
    },
  ),
};

jest.mock('@/hooks/machines', () => ({ useMacConnection: () => ({ connection: mockConnection }) }));
jest.mock('../../modules/stim-video/src', () => ({ pushAccessUnit: () => {} }));

const TARGET = { workspace: '/app', platform: 'ios' as const, slot: 'default' };
const OPTIONS = { enabled: true, fps: 30, maxEdge: 720, video: ['h264' as const] };

beforeEach(() => {
  mockAnswers.length = 0;
  mockPackets.length = 0;
  mockRequests.length = 0;
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

test('sends one seek at a time, only the latest waiting, and ignores the answer to an older one', async () => {
  jest.useFakeTimers();
  try {
    const { result } = await renderHook(() => useDeviceStream(TARGET, OPTIONS));
    await act(async () => mockAnswers[0]!({ subscription: 's1', video: 'h264' }));
    await act(async () => {
      result.current.seek(1000, 0);
      result.current.seek(2000, 0);
      result.current.seek(3000, 1);
    });
    expect(mockRequests.map((request) => request.params.at)).toEqual([1000]);
    expect(result.current.seeking).toBe(true);
    await act(async () => mockRequests[0]!.resolve({ at: 1000 }));
    expect(result.current.playhead.getState().at).toBeNull();
    await act(async () => jest.advanceTimersByTime(100));
    expect(mockRequests.map((request) => request.params.at)).toEqual([1000, 3000]);
    await act(async () => mockRequests[1]!.resolve({ at: 2990 }));
    expect(result.current.replay).toEqual({ rate: 1, ended: false });
    expect(result.current.playhead.getState().at).toBe(2990);
    expect(result.current.seeking).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('resends a seek that was out when the connection resubscribed, and keeps seeking after the late answer', async () => {
  const { result } = await renderHook(() => useDeviceStream(TARGET, OPTIONS));
  await act(async () => mockAnswers[0]!({ subscription: 's1', video: 'h264' }));
  await act(async () => result.current.seek(1000, 0));
  await act(async () => mockAnswers[0]!({ subscription: 's2', video: 'h264' }));
  await act(async () => mockRequests[0]!.resolve({ at: 1000 }));
  expect(mockRequests.map((request) => request.params)).toEqual([
    { subscription: 's1', at: 1000, rate: 0 },
    { subscription: 's2', at: 1000, rate: 0 },
  ]);
  await act(async () => mockRequests[1]!.resolve({ at: 990 }));
  expect(result.current.replay).toEqual({ rate: 0, ended: false });
  expect(result.current.playhead.getState().at).toBe(990);
  expect(result.current.seeking).toBe(false);
});

test('moves the playhead of a playing replay without rendering the component that holds the stream', async () => {
  jest.useFakeTimers();
  try {
    let renders = 0;
    const { result } = await renderHook(() => {
      renders += 1;
      return useDeviceStream(TARGET, { ...OPTIONS, startAt: 1000 });
    });
    await act(async () => mockAnswers[0]!({ subscription: 's1', video: 'h264' }));
    await act(async () => mockPackets[0]!(frame(1000, true)));
    const before = renders;
    const moves: (number | null)[] = [];
    result.current.playhead.subscribe(({ at }) => moves.push(at));
    for (const capturedAt of [1100, 1200, 1300]) {
      await act(async () => {
        mockPackets[0]!(frame(capturedAt));
        jest.advanceTimersByTime(200);
      });
    }
    expect(moves).toEqual([1100, 1200, 1300]);
    expect(renders).toBe(before);
  } finally {
    jest.useRealTimers();
  }
});
