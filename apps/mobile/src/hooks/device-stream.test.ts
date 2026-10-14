import { act, renderHook } from '@testing-library/react-native';

import { useDeviceStream } from './device-stream';
import type { ServerEvent } from '@/protocol/types';
import type { VideoFormat, VideoProgress } from 'react-native-stim-session';

interface FakeStream {
  onFormat?: (format: VideoFormat) => void;
  onProgress?: (progress: VideoProgress) => void;
}
const mockAnswers: ((result: { subscription: string; video?: string }) => void)[] = [];
const mockEvents: ((event: ServerEvent) => void)[] = [];
const mockVideo: ((stream: FakeStream) => void)[] = [];
const format = (generation: number, artworkTurns?: number): VideoFormat => ({
  width: 390,
  height: 844,
  generation,
  ...(artworkTurns !== undefined ? { artworkTurns } : {}),
});
const progress = (capturedAt: number): VideoProgress => ({ capturedAt, frames: 1, bytes: 100, latencyMs: 5 });
/** Answers the subscription with H.264 and returns the stream the session would create for it. */
async function answerVideo(subscription: string): Promise<FakeStream> {
  const stream: FakeStream = {};
  await act(async () => {
    mockAnswers[0]!({ subscription, video: 'h264' });
    mockVideo[0]!(stream);
  });
  return stream;
}
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
      event: unknown,
      answered: (typeof mockAnswers)[number],
      video: (typeof mockVideo)[number],
    ) => {
      mockAnswers.push(answered);
      mockEvents.push(event as (event: ServerEvent) => void);
      mockVideo.push(video);
      return () => {};
    },
  ),
};

jest.mock('@/hooks/machines', () => ({ useMacConnection: () => ({ connection: mockConnection }) }));

const TARGET = { workspace: '/app', platform: 'ios' as const, slot: 'default' };
const OPTIONS = { enabled: true, fps: 30, maxEdge: 720, video: ['h264' as const] };

beforeEach(() => {
  mockAnswers.length = 0;
  mockEvents.length = 0;
  mockVideo.length = 0;
  mockRequests.length = 0;
});

test('requires presentation of the current Duo pose and ignores old image callbacks', async () => {
  const { result, rerender } = await renderHook(
    ({ workspace }: { workspace: string }) => useDeviceStream({ ...TARGET, workspace }, { ...OPTIONS, duoFrame: true }),
    { initialProps: { workspace: '/app' } },
  );
  await act(async () => mockAnswers[0]!({ subscription: 's1' }));
  const image = (revision: string): ServerEvent => ({
    event: 'frame',
    subscription: 's1',
    platform: 'ios',
    slot: 'default',
    mime: 'image/jpeg',
    width: 800,
    height: 600,
    capturedAt: '2026-10-04T10:00:00Z',
    data: 'jpeg',
    duo: { revision, screenID: 10, angle: 76, orientation: 3 },
  });
  await act(async () => mockEvents[0]!(image('first')));
  expect(result.current.displayedDuoRevision).toBeNull();
  await act(async () => result.current.frameDisplayed('first'));
  expect(result.current.displayedDuoRevision).toBe('first');
  await act(async () => mockEvents[0]!(image('second')));
  await act(async () => result.current.frameDisplayed('first'));
  expect(result.current.displayedDuoRevision).toBeNull();
  await act(async () => result.current.frameDisplayed('second'));
  expect(result.current.displayedDuoRevision).toBe('second');
  await act(async () => mockEvents[0]!(image('second')));
  expect(result.current.displayedDuoRevision).toBe('second');
  await rerender({ workspace: '/other' });
  await act(async () => result.current.frameDisplayed('second'));
  expect(result.current.displayedDuoRevision).toBeNull();
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
  let renders = 0;
  const { result } = await renderHook(() => {
    renders += 1;
    return useDeviceStream(TARGET, { ...OPTIONS, startAt: 1000 });
  });
  const stream = await answerVideo('s1');
  await act(async () => {
    stream.onFormat!(format(0));
    stream.onProgress!(progress(1000));
  });
  const before = renders;
  const moves: (number | null)[] = [];
  result.current.playhead.subscribe(({ at }) => moves.push(at));
  for (const capturedAt of [1100, 1200, 1300]) await act(async () => stream.onProgress!(progress(capturedAt)));
  expect(moves).toEqual([1100, 1200, 1300]);
  expect(renders).toBe(before);
});

test('keeps housing unavailable until native clearing, ignoring stale generations and preserving steady video renders', async () => {
  const { result } = await renderHook(() => useDeviceStream(TARGET, { ...OPTIONS, deviceFrame: true }));
  const stream = await answerVideo('s1');
  await act(async () => stream.onFormat!(format(1, 0)));
  expect(result.current.stream).toBe(stream);
  expect(result.current.video?.artworkTurns).toBeUndefined();
  await act(async () => result.current.orientationCleared(1));
  expect(result.current.video?.artworkTurns).toBe(0);
  const before = result.current.video;
  await act(async () => stream.onProgress!(progress(1100)));
  expect(result.current.video).toBe(before);
  await act(async () => stream.onFormat!(format(2, 2)));
  expect(result.current.video?.artworkTurns).toBeUndefined();
  await act(async () => result.current.orientationCleared(1));
  expect(result.current.video?.artworkTurns).toBeUndefined();
  await act(async () => result.current.orientationCleared(2));
  expect(result.current.video?.artworkTurns).toBe(2);
  const next = await answerVideo('s2');
  expect(result.current.stream).toBe(next);
  await act(async () => next.onFormat!(format(1, 2)));
  await act(async () => result.current.orientationCleared(2));
  expect(result.current.video?.artworkTurns).toBeUndefined();
  await act(async () => result.current.orientationCleared(1));
  expect(result.current.video?.artworkTurns).toBe(2);
});

test.each(['platform', 'posture', 'mime'])(
  'ignores a future frame %s without replacing the displayed capture',
  async (field) => {
    const { result, unmount } = await renderHook(() => useDeviceStream(TARGET, OPTIONS));
    await act(async () => mockAnswers[0]!({ subscription: 's' }));
    const image: ServerEvent = {
      event: 'frame',
      subscription: 's',
      platform: 'ios',
      slot: 'default',
      mime: 'image/jpeg',
      width: 400,
      height: 800,
      data: 'image',
      capturedAt: '2026-09-27T12:00:00Z',
    };
    await act(async () => mockEvents[0]!(image));
    await act(async () => mockEvents[0]!({ ...image, [field]: 'future-kind', data: 'unsupported' }));
    expect(result.current.frame).toEqual(image);
    await unmount();
  },
);

test('reports window selection mode and clears it when the subscription or target changes', async () => {
  const { result, rerender } = await renderHook(
    ({ workspace }: { workspace: string }) => useDeviceStream({ ...TARGET, platform: 'macos', workspace }, OPTIONS),
    { initialProps: { workspace: '/app' } },
  );
  expect(result.current.windows).toBeNull();
  await act(async () => mockAnswers[0]!({ subscription: 's1' }));
  const window = { id: 12, title: 'App', frame: { x: 0, y: 0, width: 800, height: 600 } };
  for (const pinned of [false, true]) {
    await act(async () =>
      mockEvents[0]!({
        event: 'macos-windows',
        subscription: 's1',
        current: window,
        windows: [window],
        pinned,
      }),
    );
    expect(result.current.windows).toEqual({ current: window, windows: [window], pinned });
  }
  await act(async () => mockAnswers[0]!({ subscription: 's2' }));
  expect(result.current.windows).toBeNull();
  await act(async () =>
    mockEvents[0]!({
      event: 'macos-windows',
      subscription: 's2',
      current: null,
      windows: [],
    }),
  );
  expect(result.current.windows).toEqual({ current: null, windows: [], pinned: false });
  await rerender({ workspace: '/other' });
  expect(result.current.windows).toBeNull();
});

test('opens archives only at recorded times and never sends a live request', async () => {
  mockConnection.subscribe.mockClear();
  const target = { archive: 'app--old', platform: 'ios' as const, slot: 'default' };
  const { result, rerender } = await renderHook(
    ({ startAt }: { startAt: number | null }) => useDeviceStream(target, { ...OPTIONS, startAt }),
    { initialProps: { startAt: null } },
  );
  expect(mockConnection.subscribe).not.toHaveBeenCalled();
  await rerender({ startAt: 1000 });
  expect(mockConnection.subscribe.mock.calls[0][1]).toMatchObject({ archive: 'app--old', at: 1000, rate: 0 });
  expect(mockConnection.subscribe.mock.calls[0][1]).not.toHaveProperty('workspace');
  await act(async () => mockAnswers[0]!({ subscription: 's1', video: 'h264' }));
  await act(async () => result.current.live());
  expect(mockRequests).toEqual([]);
});
