import { readFileSync } from 'node:fs';
import type { Device, FrameListener } from '../../src/frames.ts';
import { PresenceHub } from '../../src/presence.ts';
import { ShareHub, type ShareDeps, type StatusListener } from '../../src/share.ts';
import type { AccessUnit } from '../../src/video.ts';

const WIDTH = 270;
const HEIGHT = 480;
const START_CODE = Buffer.from([0, 0, 0, 1]);
const NAL_START = Buffer.from([0, 0, 1]);

/** The clip's access units: each starts at an access unit delimiter (NAL type 9). */
function clip(): AccessUnit[] {
  const data = readFileSync(new URL('./share-h264.annexb', import.meta.url));
  const starts: number[] = [];
  for (let at = data.indexOf(START_CODE); at >= 0; at = data.indexOf(START_CODE, at + 4)) {
    if (((data[at + 4] ?? 0) & 31) === 9) starts.push(at);
  }
  return starts.map((start, index) => {
    const unit = data.subarray(start, starts[index + 1] ?? data.length);
    let keyframe = false;
    for (let at = unit.indexOf(NAL_START); at >= 0 && !keyframe; at = unit.indexOf(NAL_START, at + 3)) {
      keyframe = ((unit[at + 3] ?? 0) & 31) === 5;
    }
    return { keyframe, capturedAt: 0, width: WIDTH, height: HEIGHT, data: unit };
  });
}

/** Plays the clip at 30 fps to every listener that asked for video, restarting at its first keyframe when one is asked for. */
class Camera {
  private readonly units = clip();
  private readonly listeners = new Set<FrameListener>();
  private keyframeAsked = true;
  private index = 0;
  private readonly timer = setInterval(() => this.tick(), 33);

  keyframe = (): void => {
    this.keyframeAsked = true;
  };

  subscribe = (listener: FrameListener): (() => void) => {
    this.listeners.add(listener);
    this.keyframeAsked = true;
    return () => this.listeners.delete(listener);
  };

  stop(): void {
    clearInterval(this.timer);
  }

  private tick(): void {
    if (this.keyframeAsked && !this.units[this.index]?.keyframe) this.index = 0;
    this.keyframeAsked = false;
    const next = this.units[this.index];
    if (!next) return;
    const unit = { ...next, capturedAt: Date.now() };
    this.index = (this.index + 1) % this.units.length;
    for (const listener of this.listeners) listener.video?.(unit);
  }
}

const STATUS = {
  environments: [
    { path: '/work/app', ios: { udid: 'SIM-1', owned: true, state: 'Booted', name: 'stim-app (iPhone 17)' } },
  ],
};

export async function share(
  webrtc: boolean,
): Promise<{ url: string; state: () => string | undefined; close: () => Promise<void> }> {
  const camera = new Camera();
  const presence = new PresenceHub();
  const hub = new ShareHub({
    presence,
    appName: async () => null,
    frames: {
      keyframe: camera.keyframe,
      congested: () => {},
      subscribe: (_device: Device, listener) => camera.subscribe(listener),
    },
    control: {
      begin: async () => ({ code: 'forbidden', message: 'No control in this fixture.' }),
      targetOf: () => null,
      input: async () => null,
      release: () => {},
      endFor: () => {},
      endById: () => false,
    } as unknown as ShareDeps['control'],
    subscribeStatus: (listener: StatusListener) => {
      listener.item(STATUS as never);
      return () => {};
    },
    route: {
      open: async (target) => ({ url: `http://127.0.0.1:${target}`, port: target }),
      close: async () => {},
      stranded: () => null,
      removeStranded: async () => {},
    },
    webrtc: () => webrtc,
    limits: { maxFailures: 3 },
    idle: () => {},
  });
  const started = await hub.start({
    workspace: '/work/app',
    platform: 'ios',
    control: false,
    expiresMinutes: 30,
    passwordless: true,
  });
  if ('code' in started) throw new Error(started.message);
  const url = new URL(started.url);
  return {
    url: `http://127.0.0.1:${hub.port}${url.pathname}`,
    state: () => hub.list()[0]?.state,
    async close(): Promise<void> {
      camera.stop();
      await hub.close();
      presence.close();
    },
  };
}

/** What `share-probe.js`, which runs in the viewer page, records about the page. */
export interface Probe {
  draws: number;
  socketVideo: number;
  peers: number;
  log: { phase: string; draws: number; socketVideo: number }[];
  /** The viewer's WebRTC phase now, from the page. */
  phase?: string;
}
