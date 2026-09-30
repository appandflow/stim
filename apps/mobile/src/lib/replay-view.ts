/**
 * What the device viewer streams, beyond the live screen of a running device. `startAt` opens the stream on the
 * device's recording at that time, for a device that is not running. `replayedLive` says the viewer showed a
 * replay while the device ran, so the replay carries on in the recording if the device stops.
 */
export interface ReplayView {
  startAt: number | null;
  replayedLive: boolean;
}

export type ReplayViewEvent =
  /**
   * What the viewer shows now. `at` is the replay frame last shown, read only when the device has just stopped;
   * `timelineStart` is where the recording starts, null without footage.
   */
  | { type: 'sync'; replaying: boolean; running: boolean; at: number | null; timelineStart: number | null }
  /** The replay bar asked for the frame at `at`; `hasFootage` says the recording can be streamed. */
  | { type: 'seek'; at: number; running: boolean; hasFootage: boolean }
  /** Leave the recording opened by `startAt`. */
  | { type: 'live' };

export const LIVE_VIEW: ReplayView = { startAt: null, replayedLive: false };

/** The next view, or `view` itself when the event changes nothing. */
export function replayView(view: ReplayView, event: ReplayViewEvent): ReplayView {
  switch (event.type) {
    case 'sync': {
      let { startAt, replayedLive } = view;
      if (event.replaying) replayedLive = event.running;
      else if (event.running) replayedLive = false;
      if (replayedLive && !event.running && startAt === null) {
        startAt = event.at ?? event.timelineStart;
        replayedLive = false;
      }
      return startAt === view.startAt && replayedLive === view.replayedLive ? view : { startAt, replayedLive };
    }
    case 'seek': {
      const opened = event.hasFootage ? view.startAt : null;
      if (event.running || opened !== null || view.startAt === event.at) return view;
      return { ...view, startAt: event.at };
    }
    case 'live':
      return view.startAt === null ? view : { ...view, startAt: null };
  }
}
