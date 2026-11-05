# WebRTC proof of concept (#5232)

Throwaway harness. Not wired into any test or script.

1. `ffmpeg -f lavfi -i testsrc2=size=590x1280:rate=60 -t 4 -c:v libx264 -profile:v baseline -b:v 4M -bf 0 -pix_fmt yuv420p -x264-params keyint=60:aud=1:repeat-headers=1:scenecut=0 -f h264 clip.annexb` (`-b:v 600k -maxrate 700k -bufsize 200k` for the light clip).
2. `STIM_WEBRTC_PORTS=47000-47000 node mock-server/server.mjs --port 7797 --clip clip.annexb --rtc-proxy 127.0.0.1:47100`
3. `node mock-server/rtc-poc/harness.mjs <out-dir>`: TCP shaper 7788 -> 7797, UDP shaper 47100 -> 47000, control and stat collector on 7790.
4. `pnpm run dev:pair --mock --port 7797 --endpoint ws://127.0.0.1:7788`, build a dev app, open a device view.
5. `run-matrix.sh <prefix> <repeats>` (taps are for an iPhone 18 Pro simulator at 402x874) and `node analyze.mjs <out-dir>`.

`harness.mjs` documents what the TCP and UDP shapers model.
