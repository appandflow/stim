import { LIVE_VIEW, replayView, type ReplayView, type ReplayViewEvent } from './replay-view';

const sync = (replaying: boolean, running: boolean, at: number | null = null): ReplayViewEvent => ({
  type: 'sync',
  replaying,
  running,
  at,
  timelineStart: 100,
});
const run = (events: ReplayViewEvent[], from: ReplayView = LIVE_VIEW) => events.reduce(replayView, from);

describe('the replay view', () => {
  it('keeps showing the recording from the frame shown when the device stops during a replay', () => {
    const replaying = run([sync(false, true), sync(true, true)]);
    expect(run([sync(false, false, 5000)], replaying)).toEqual({ startAt: 5000, replayedLive: false });
  });

  it('opens the recording at its start when the device stops before the replay showed a frame', () => {
    expect(run([sync(true, true), sync(false, false, null)])).toEqual({ startAt: 100, replayedLive: false });
  });

  it('leaves a device that stops while live, or after the replay went back live, on the stopped placeholder', () => {
    expect(run([sync(false, true), sync(false, false, 5000)])).toBe(LIVE_VIEW);
    expect(run([sync(true, true), sync(false, true), sync(false, false, 5000)])).toEqual(LIVE_VIEW);
  });

  it('opens the recording of a stopped device at the first seek, and later seeks go to the stream', () => {
    const opened = run([{ type: 'seek', at: 300, running: false, hasFootage: true }]);
    expect(opened.startAt).toBe(300);
    expect(replayView(opened, { type: 'seek', at: 400, running: false, hasFootage: true })).toBe(opened);
    expect(replayView(LIVE_VIEW, { type: 'seek', at: 300, running: true, hasFootage: true })).toBe(LIVE_VIEW);
  });

  it('closes the recording it opened on live', () => {
    const opened = run([{ type: 'seek', at: 300, running: false, hasFootage: true }]);
    expect(replayView(opened, { type: 'live' })).toEqual(LIVE_VIEW);
    expect(replayView(LIVE_VIEW, { type: 'live' })).toBe(LIVE_VIEW);
  });

  it('returns the same view when nothing changes, so syncing on every render settles', () => {
    const replaying = run([sync(true, true)]);
    expect(replayView(replaying, sync(true, true, 7000))).toBe(replaying);
    const opened = run([sync(true, false)], { startAt: 300, replayedLive: false });
    expect(replayView(opened, sync(true, false, 9000))).toBe(opened);
  });
});
