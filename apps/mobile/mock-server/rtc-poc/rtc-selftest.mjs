import { createRequire } from 'node:module';
const root = '/Users/janicduplessis/Developer/stim/.worktrees/5232';
const require = createRequire(root + '/packages/server/package.json');
const nd = require('node-datachannel');
const { openRtc } = await import(root + '/packages/server/src/webrtc-sender.ts');
const { ClipFeed, loadClip } = await import(root + '/apps/mobile/mock-server/clip.mjs');
const clip = loadClip(
  '/private/tmp/claude-501/-Users-janicduplessis-Developer-stim/b1e629b4-1f36-4f6c-a292-8876057ce176/scratchpad/5232/clip/clip.annexb',
  { width: 590, height: 1280, fps: 60 },
);
const feed = new ClipFeed(clip, 'share', () => {});
const client = new nd.PeerConnection('c', { iceServers: [] });
const video = client.createDataChannel('video', { unordered: true, maxPacketLifeTime: 100 });
const ctl = client.createDataChannel('ctl');
let offer;
await new Promise((resolve) => {
  client.onLocalDescription((sdp) => (offer = sdp));
  client.onGatheringStateChange((s) => s === 'complete' && resolve());
  setTimeout(resolve, 2500);
});
offer = client.localDescription().sdp;
const stripped = offer
  .split(/\r?\n/)
  .filter((l) => !l.startsWith('a=candidate:'))
  .join('\r\n')
  .replace(/(m=application[^\r\n]*\r\n)/, '$1a=candidate:1 1 UDP 2122252543 192.168.254.254 9 typ host\r\n');
const session = await openRtc(
  stripped,
  {
    subscribe: (v) => {
      feed.stop();
      feed.sink = (u, c) => v({ keyframe: u.keyframe, capturedAt: c, width: u.width, height: u.height, data: u.data });
      feed.live();
      return () => feed.stop();
    },
    keyframe: () => feed.restart(),
    congested: () => {},
  },
  (r) => console.log('closed', r),
);
const seen = new Set();
const answer = session.answer
  .split(/\r?\n/)
  .map((l) =>
    l.startsWith('a=candidate:') ? l.replace(/^(a=candidate:\S+ \d+ \S+ \d+) \S+ \d+/, '$1 127.0.0.1 47100') : l,
  )
  .filter((l) => !l.startsWith('a=candidate:') || (!seen.has(l) && seen.add(l)))
  .join('\r\n');
client.setRemoteDescription(answer, 'answer');
let n = 0,
  gaps = 0,
  expected = null,
  waiting = true,
  kreq = 0,
  drawn = 0;
const lat = [];
const times = [];
video.onMessage((buf) => {
  const b = Buffer.from(buf);
  n++;
  const seq = b.readUInt32BE(4);
  const key = b[1] & 1;
  const cap = b.readDoubleBE(8);
  if (expected !== null && seq !== expected) {
    gaps++;
    waiting = true;
  }
  expected = (seq + 1) >>> 0;
  if (key) waiting = false;
  if (waiting) {
    try {
      ctl.sendMessage(JSON.stringify({ t: 'keyframe' }));
      kreq++;
    } catch {}
    return;
  }
  drawn++;
  lat.push(Date.now() - cap);
  times.push(Date.now());
});
const secs = Number(process.argv[2] ?? 15);
await new Promise((r) => setTimeout(r, secs * 1000));
lat.sort((a, b) => a - b);
let stalls = 0;
for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 400) stalls++;
console.log(
  JSON.stringify({
    received: n,
    drawnFps: drawn / secs,
    gaps,
    kreq,
    p50: lat[Math.floor(lat.length / 2)],
    p95: lat[Math.floor(lat.length * 0.95)],
    stalls400: stalls,
  }),
);
session.close();
client.close();
nd.cleanup();
process.exit(0);
