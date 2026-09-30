import { frameTarget } from './frame-target';

const device = { workspace: '/app', platform: 'ios', slot: 'default' } as const;

test('every call site derives the device part of the key and params from the same target', () => {
  const live = frameTarget(device, { fps: 5, maxEdge: 1280 });
  const snapshot = frameTarget(device);
  const stream = frameTarget(device, { fps: 5, maxEdge: 1280, video: ['h264'], startAt: null });
  expect(snapshot.params).toEqual(live.params);
  expect(stream.params).toEqual(live.params);
  expect(live.key.startsWith(snapshot.key.split('\n', 4).join('\n'))).toBe(true);
  expect(stream.key.startsWith(snapshot.key.split('\n', 4).join('\n'))).toBe(true);
});

test('the key changes with the device, the physical flag and each requested option', () => {
  const base = { fps: 5, maxEdge: 1280, video: ['h264'], startAt: null as number | null };
  const keys = [
    frameTarget(device, base).key,
    frameTarget({ ...device, workspace: '/other' }, base).key,
    frameTarget({ ...device, platform: 'android' }, base).key,
    frameTarget({ ...device, slot: 'two' }, base).key,
    frameTarget({ ...device, physical: true }, base).key,
    frameTarget(device, { ...base, fps: 10 }).key,
    frameTarget(device, { ...base, maxEdge: 640 }).key,
    frameTarget(device, { ...base, video: [] }).key,
    frameTarget(device, { ...base, startAt: 1000 }).key,
  ];
  expect(new Set(keys).size).toBe(keys.length);
});

test('params carry physical only when set', () => {
  expect(frameTarget(device).params).toEqual({ workspace: '/app', platform: 'ios', slot: 'default' });
  expect(frameTarget({ ...device, physical: true }).params).toEqual({ ...device, physical: true });
});
