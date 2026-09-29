# @stim-cli/server

`stim-server` serves Stim state to paired clients, such as the Stim phone app,
and lets the clients the Mac grants control run `stim reload` and `stim stop`
in a workspace. It runs on the Mac, next to Stim. It changes Stim state only
through those two commands. It writes only its own pairing state and action
log under `$STIM_HOME/server/`, and the device recordings described under
[Recording](#recording).

The design is in
[`docs/specs/2026-09-25-stim-server-design.md`](../../docs/specs/2026-09-25-stim-server-design.md).

## Commands

```bash
stim-server [--port <n>]          # serve paired clients, port 7787 by default
stim-server pair [--port <n>] [--control]
                                  # print a single-use pairing payload
stim-server devices [list]        # list paired devices, build clients and build requests
stim-server devices grant <id> --control|--read|--build
                                  # let a paired device run actions, or only read;
                                  # --build approves a Mac's request to build here
stim-server devices revoke <id>   # revoke a paired device or build client, or deny a request
stim-server log                   # list the actions paired devices ran
```

`pair --json` prints `{ "qr": <payload>, "expiresAt": "<ISO time>" }`, and
`devices --json` prints `{ "devices": [...] }` with each device's `id`, `name`,
`identity`, `pairedAt`, `lastSeenAt` and `capabilities`, never its token hash,
followed by the [build clients](#build-access); a pending build request also
carries `pendingUntil`.
`log --json` prints `{ "actions": [...] }`, the records described under
[Actions](#actions).

`GET http://127.0.0.1:7787/health` answers requests from this Mac with the
server's name, versions, protocol, `stimHome`, and the Tailscale state it
started with. While Tailscale runs, it also carries `route`, read from
`tailscale serve status --json` on each request: `routed` with the HTTPS
`port` that proxies to the server, `funneled` with the Funnel `ports` that do,
`missing`, or `unknown` with a `reason`; the last three carry the `port` the
setup command would use. Stim Desktop uses it to find a running server and
show its route. A request through `tailscale serve` or on a Tailscale address
without an `Origin` or `Sec-Fetch-Site` header, which a web page's request
carries, gets only `{ "server": "stim-server", "version", "protocol" }`, which Stim
Desktop's Build machines list uses to find stim-server on the other Macs of the
tailnet. A request from this Mac with a `Host` other than `127.0.0.1` or
`localhost` gets HTTP 426, like any other plain HTTP request.

`stim-server` runs the `stim` version this package was released with, not the
one on your PATH. It reads the login shell's environment once at start, so
`PATH`, `ANDROID_HOME`, and `STIM_*` variables match your terminal even when
another app starts it.

## Tailscale

Tailscale carries and encrypts the traffic between the phone and the Mac, on
the same Wi-Fi or across networks, and identifies each device. Stim adds no
cryptography of its own. You need Tailscale on the Mac and on the phone, in the
same tailnet or with the Mac shared to the phone's user.

`stim-server` listens only on `127.0.0.1` and on the Mac's Tailscale
addresses, never on every interface. Run this once so clients can use
`wss://<mac>.<tailnet>.ts.net:7443` with a valid certificate:

```bash
tailscale serve --bg --https=7443 http://127.0.0.1:7787
```

The dedicated port 7443 keeps the server tailnet only and leaves port 443 to
other apps. Do not serve `stim-server` on a port where Tailscale Funnel is on:
Funnel makes every handler on that port reachable from the public internet.

`stim-server` reads `tailscale serve status --json` at start and on every
`pair`. It uses the HTTPS port whose `/` handler proxies to its loopback port,
preferring 7443. Without such a route, it assumes 7443 and prints the command
above, or the next free port when 7443 is taken. It never suggests a Funnel
port. Any handler, at any path, or TCP forward that reaches the server on a
Funnel port makes it public, and `pair` refuses.

When Tailscale is not running, `stim-server` listens on loopback only and
says so on stderr. Start Tailscale, then restart `stim-server`.

## Pairing

`stim-server pair` prints the JSON that the pairing QR code encodes:

```json
{ "v": 1, "name": "Janic's MacBook Pro", "endpoint": "wss://janics-mbp.tail1234.ts.net:7443", "pairingToken": "..." }
```

The endpoint names the route's port, and omits it for 443. When a route to
the server is on a port with Funnel on, `pair` refuses and exits 1 without
creating a token.

The pairing token works once and expires after 5 minutes. A client spends it in
`hello` and receives a random device token, which it presents on every later
connection. The server stores only the SHA-256 hash of each token.

At pairing, the server records the peer's tailnet node and user from
`tailscale whois`. A device token presented from any other node is refused, so
a leaked token alone is not enough. A device paired over loopback, from this
Mac, is accepted only over loopback. `tailscale serve` connects from loopback
and names the peer in `X-Forwarded-For`, which the server trusts only on
loopback connections. Forward only `tailscale serve` in HTTP mode to the
loopback port: a forwarder that omits that header, such as `tailscale serve
--tcp`, `ssh -L`, or a tunnel, makes every remote peer look like this Mac.

A connection must send `hello` within 5 seconds. Five failed attempts from the
same peer within a minute block new connections from it for up to a minute.

Paired devices live in `$STIM_HOME/server/devices.json`. Revoking a device
closes its open connections.

## Scopes

A paired device has the `read` capability, which serves state, or also
`control`, which runs [actions](#actions) and [controls devices](#control). Pairing grants `read` only, unless
the pairing code came from `stim-server pair --control`. On the Mac,
`stim-server devices grant <id> --control` adds control to a paired device and
`--read` takes it away. Nothing a client sends changes its own capabilities.
The server checks the device's capabilities in `devices.json` on every action
and control session, and ends a device's control sessions when it loses
`control`, so taking control away applies to open connections at once. `hello` reports
the capabilities and actions of the connection's device when it connects; a
connection sees a new grant after it reconnects.

Every method other than `hello` needs `read`. A device with only `build`
gets `forbidden` for all of them.

## Build access

`build` lets another Mac on the tailnet run its project's code on this Mac to
build for it: config plugins, CocoaPods hooks, Xcode script phases and Gradle
plugins run as the user `stim-server` runs as. It never comes with `read` or
`control`, and `devices grant` never turns a paired device into a build
client. Grant it only to Macs you trust with that. A connection from this Mac,
over loopback, cannot get it: it has no tailnet node to bind the token to.
Because the server trusts `X-Forwarded-For` on loopback (see
[Pairing](#pairing)), a process on this Mac can still claim a tailnet peer's
address. Run `stim-server` as a user no one else can run processes as when
other people use this Mac, and approve a request only when you expect it.

A Mac gets `build` only by asking and being approved on this Mac. The client
sends `hello` with `auth` set to `{ "request": "build", "deviceName" }`, a
name of at most 64 UTF-16 code units with no control or format characters.
The server records a pending build client bound to the peer's node, answers
with a `deviceToken`, no capabilities and
`approval: { "state": "pending", "expiresAt" }`, and closes the connection.
`stim-server devices` lists it as `pending build`. On this Mac,
`stim-server devices grant <id> --build` approves it and
`stim-server devices revoke <id>` denies it; Stim Desktop's **Allow** and
**Deny** run those commands. Until then, `hello` with its token
fails with `approval-pending`, which does not count as a failed attempt, while
the request itself does, so a peer cannot send more requests than failed
attempts. A request lapses after 15 minutes. Each node has at most one pending
request, the newest, and the server holds at most 8; more fail with
`limit-exceeded`. There is no pairing code for `build`: `stim-server pair`
never grants it.

`devices grant` never gives `build` to a paired device, or `read` or
`control` to a build client. Build clients live in
`$STIM_HOME/server/build-clients.json`, apart from `devices.json`, so a
`stim-server` release without `build` never reads them and refuses their
tokens.

## Offloaded builds

A client with `build` runs its iOS simulator builds and Android emulator
debug builds here with these methods.
They need `build`, not `read`; a device without `build` gets `forbidden`.
The server re-reads the build clients on every call, and revoking a client
closes its connections, which cancels its builds.

- `build.offer` takes `repo` (the client's name for its repository: letters,
  digits, `.`, `_` and `-`, at most 80) and an optional `lockfile` sha256. It
  returns `toolchain` (`stimBuild`, a digest of the bundled Stim's built code;
  `arch`; `xcode`; `simulatorSdk`; `cocoapods`; `runtimes`, the simulator
  runtimes with an iPhone simulator to build for; `jdk`, the major version of
  the JDK in `JAVA_HOME` or the macOS default; and `androidSdk`, the `ndk`,
  `buildTools` and `platforms` directories of the SDK in `ANDROID_HOME` or
  `~/Library/Android/sdk`, null without one), `capacity` and `warm`
  (`checkout`, `dependencies` when the last install used that lockfile, and
  `build` once a build ran there) for that repository. `capacity` holds
  `running` and `max` offloaded builds, `diskFreeBytes` of the worker root's
  volume and `minDiskFreeBytes`, `cpus`, `loadPerCore` (the 5-minute load
  average per CPU), `builds` (this Mac's own Stim runs in prebuild, pods or
  compile that it did not offload, plus the offloaded builds it runs), `maxBuilds` (its
  `concurrency.maxBuilds`, 0 when unlimited), `maxLoadPerCore` (its
  `offload.maxLoadPerCore`, default 2), and `declined`: why it would refuse a
  build now, or null. It declines while it runs its limit of offloaded builds,
  while the worker root's volume has less than 10 GiB free, while `builds`
  reaches a non-zero `maxBuilds`, or while `loadPerCore` is at or above
  `maxLoadPerCore`. The toolchain is read at most once a minute; capacity on
  every offer.
- `build.sync` takes `repo`, `files` and `done`. `files` is one page of the
  manifest, each `{ "path", "kind": "file"|"exec"|"link", "size", "sha256" }`,
  a link's blob being its target. Pages accumulate until `done`; the next
  `build.sync` starts a new manifest. A path is relative, with no `.`, `..`,
  empty or `.git` component (in any case). The result's `missing` lists the digests of the
  page this Mac lacks. The client then sends each as binary frames: 32 bytes of
  the sha256, then the next bytes of that blob, one blob after another. A frame
  for a blob that was not asked for, one that overruns its size, or bytes that
  do not match the digest close the connection with 4400. Blobs are kept per
  client and shared by all its repositories.
- `build.start` takes `repo`, `project` (the app directory in the repository),
  `platform` (`ios` or `android`), `configuration`, `scheme`, `runtime` (a
  simulator runtime identifier, required for `ios`, null for `android`),
  `fingerprint`, `packageName`, `isExpo`, `optimizations`, `android` (for
  `android`: `variant`, `abi`, `gradleBuildCache`, `pch` and `compilerCache`,
  `ccache` or `none`) and `stimBuild`, after the whole manifest of `repo` was
  synced on this connection. It returns `{ "job" }`. It fails with
  `build-busy` while the offer would be declined, naming the reason, or while
  another build of the same client and repository runs, and with
  `build-refused` when `stimBuild` differs. The build runs `offload-worker.mjs` of the bundled Stim with
  `STIM_HOME` set to the repository's area. It makes the area's checkout
  hold exactly the manifest (a file git lists as untracked and not ignored,
  and not in the manifest, is deleted; ignored dependencies and generated
  projects stay), installs JavaScript dependencies when the lockfile changed,
  runs prebuild and `pod install` when needed, refuses unless the fingerprint
  equals `fingerprint`, and runs `xcodebuild` for one of this Mac's iPhone
  simulators on `runtime`, which it never boots, or Gradle's
  `assemble<variant>` for `abi` with ccache under the area's Stim home. An
  Android build stops the Gradle daemons of the client's Gradle home when it
  ends or gets SIGTERM, because a daemon leaves the build's process group.
- `build.progress` events `{ "event": "build.progress", "job", ... }` carry a
  `phase` and `msg`, a build-log `record`, and last the `outcome`: `ok`, and
  on success `artifact` (`name`, `size`, `sha256` of a tar of the `.app` or
  `.apk`),
  `fingerprint`, `compilationCache` and `timings`, otherwise `code` and
  `message`.
- `build.cancel` takes `job` and stops it. Closing the connection cancels its
  jobs too. The build's process group gets SIGTERM, then SIGKILL 5 seconds
  later.
- `build.artifact` takes the `job` of a successful build and sends the archive
  as binary frames, each 32 bytes of its sha256 and then the next bytes, then
  answers `{ "name", "size", "sha256" }`, and deletes it here. An archive
  nobody fetched is deleted when its connection closes; one left by a server
  that crashed stays under `repos/<repo>/out/` until you delete it.

The worker root is `offload.workerRoot` in this Mac's Stim settings, or
`$STIM_HOME/build-worker`. Each client gets `<root>/<device id>/`, with its
blobs, caches (`CP_HOME_DIR`, `CP_CACHE_DIR`, the pnpm store and
`GRADLE_USER_HOME`) and one area
per repository under `repos/<repo>/`: the checkout, its own Stim home with
DerivedData, the compilation cache and ccache, and the output. A build never reads or
writes this Mac's own Stim home. An ownership claim at
`repos/<repo>.claims`, whose child is the build's process group, guards each
area; it is released only once that group is gone, and a claim whose server
and build are both gone is recovered by the next build. Each finished build
appends a `build` record to the [action log](#actions) with the repository as
`workspace`. The worker root keeps growing with each repository; delete a
client's directory to reclaim it.

## Protocol

JSON messages over a WebSocket. Requests are `{ "id", "method", "params" }`,
answered by `{ "id", "result" }` or `{ "id", "error": { "code", "message" } }`.
Events are `{ "event", "subscription", ... }`.

- `hello` must come first. Params: `protocol` (1), `client` (`name`,
  `version`), and `auth`, one of `{ "pairingToken", "deviceName" }`,
  `{ "deviceToken" }`, or `{ "request": "build", "deviceName" }` (see
  [Build access](#build-access)). The result carries the server name and versions, the
  device's `capabilities` (see [Scopes](#scopes)), the server's `features`
  (`physical-ios` and `physical-android` when it serves `physical: true` for
  that platform: see `frames.subscribe` below for an iPhone and
  [Physical Android devices](#physical-android-devices), and `notifications`
  for `notifications.list` and the `notification` event),
  the `actions` it may run
  (none without `control`), the paired device, and the new `deviceToken` when
  the hello paired. `server.home` is the home folder
  of the user the server runs as, so clients can show paths under it as
  `~/...`.
- `status.subscribe` returns a subscription id. Each `status` event carries a
  full payload as `stim status --watch --json` prints it, including each
  environment's `physicalDevices`, the phones it leases, and its `agents`, the
  Claude Code and Codex sessions working in it. Those carry the session id,
  working directory, the short session name the tool keeps, and times, never
  prompts or conversation. `openUrl` there is a `claude://` or `codex://` link
  that only the Mac can open; the server has no action that opens it. `webUrl`
  is a Claude Code session's `https://claude.ai/code/` link while Remote Control
  is connected, which a phone opens in the Claude app or a browser. The server
  drops `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` from the environment of
  the `stim` commands it runs, so a phone's reload is not recorded as the work
  of the agent session that started the server. All subscribers share
  one `stim status --watch --json` child, which stops with the last
  subscriber. While any status subscription is open, the server keeps a CPU
  and memory history from each payload's `machine.owners`, and every `status`
  event carries it beside the payload as `usage`, once it holds a reading:
  `{ "intervalMs", "endAt", "environments", "devices" }`. It covers the last 10
  minutes in 15-second slots, the cadence at which `status --watch` rereads
  machine usage, oldest first, at most 40 points: point `i` of `n`
  is at `endAt - (n - 1 - i) * intervalMs`, and a slot no payload fell in is
  `null`. Each `environments` entry is `{ "workspace", "cpuPercent",
"memoryMb" }` and sums every machine owner of that environment path; each
  `devices` entry is `{ "kind", "id", "workspace", "slot"?, "cpuPercent",
"memoryMb" }` for a simulator (`id` its UDID) or emulator (`id` its AVD name).
  `cpuPercent` is ps %CPU, where 100 is one core. The history lives in the
  server's memory only.
- `logs.query` returns `{ "records" }`, and `logs.subscribe` sends `logs`
  events: first the last `tail` matching records, then new ones in batches.
  Both take the Stim Desktop log viewer's filters: `workspace` (required),
  `sources` (`metro`, `client`, `device`, `build`, `agent`), `slot`, `level` (the
  minimum), `grep` (a regular expression), `errors`, and `tail` (1 to 5000,
  5000 by default). Without `sources`, `errors` keeps the CLI's default error
  scope. They run `stim logs --json` and `stim logs --json --follow` in the
  workspace. Subscribers with the same workspace and filters share one
  `--follow` child, which stops with the last of them.
- `stats.get` and `settings.get` return the payload of `stim stats --json` and
  `stim settings --json`, which masks sensitive values. Without `workspace`,
  they run in the home directory and cover the machine only.
- `frames.subscribe` takes `workspace`, `platform` (`ios`, `android` or `web`),
  `slot` (`default` when absent), `fps` (1 to 30, 5 by default) and `maxEdge`
  (240 to 2048 pixels, 1280 by default), and sends `frame` events: a JPEG,
  base64 in `data`, with `width`, `height` and `capturedAt`, at most `fps` a
  second and only when the screen changed. It serves only a booted simulator
  or a running emulator that `stim status` lists as owned by that workspace,
  or with `web` the page of the workspace's running Stim-owned Chrome from
  `stim web` (default slot only), or with `physical: true` the physical
  iPhone (see below) or Android phone (see
  [Physical Android devices](#physical-android-devices)) the workspace leases
  in that slot;
  any other device ends the subscription with a `frames-failed` `error`
  event, and so does a device that stops or changes owner. A client whose
  socket has more than two frames unsent skips frames and gets the newest
  once it catches up.

  Frames come from the `stim-frames` helper. When it starts, the server
  compiles it with `xcrun swiftc` from the Swift sources shipped in
  `dist/stim-frames/` (its own `main.swift` and the frame and input code it
  shares with Stim Desktop), which takes a few seconds, and keeps it in
  `$STIM_HOME/server/helpers/`, named by a hash of the sources and the
  compiler version. For a simulator it renders the display's framebuffer
  (CoreSimulator's IOSurface) when the display reports damage, turned
  upright. An iPhone Duo lights one of its two panels, the cover while
  folded and the inner panel while unfolded, and leaves the other black, so
  the helper streams whichever panel is lit; its frames and video carry
  `posture`, and the size changes with the panel. For an emulator it keeps one gRPC `streamScreenshot` call open,
  found through the discovery file and token the emulator writes when Stim
  boots it. It scales frames to fit the largest `maxEdge` and paces them to
  the highest `fps` its subscribers asked for. All subscribers of a device
  share one helper, which sends a new subscriber the latest frame. It keeps
  running for 10 seconds after the last subscriber leaves, so a client that
  subscribes for one frame at a time reuses it and gets the latest frame at
  once, and exits after that or when the server's end of its stdin closes.

  A client that decodes H.264 adds `video: ["h264"]`. When the helper is
  built, the result carries `video: "h264"`, `fps` may go up to 60, and
  frames arrive as binary WebSocket messages instead of `frame` events: a
  big-endian header (u8 version 1, u8 flags with bit 0 set on a keyframe,
  and on an iPhone Duo bit 1 while folded or bit 2 while unfolded,
  u16 header length, u32 sequence number of the messages sent on this
  subscription, f64 capture time in milliseconds since the epoch on the
  Mac's clock, u16 width, u16 height, u8 subscription id length and the
  ASCII id), then one Annex-B access unit. Every keyframe carries its SPS
  and PPS, and the stream has no B-frames, so each access unit is shown as
  it arrives. A change of size, such as a rotation or a Duo fold, restarts
  the encoder, and the next access unit is a keyframe with the new SPS and
  PPS. The helper encodes with VideoToolbox in real time: Main
  profile, a keyframe at least every 2 seconds, straight from the
  simulator's IOSurface, from the emulator's RGBA frames, or from the page's
  screencast JPEGs, only when the screen changed. A subscriber starts at a keyframe, and `frames.keyframe`
  with its `subscription` asks for another one, such as after its decoder
  lost state; a device sends at most one requested keyframe every 250 ms.
  A subscriber whose socket holds more than 256 KB unsent drops frames
  until it drains, then gets a keyframe. While it is behind, the device's
  bitrate halves every 2 seconds, from 3 Mbps down to 0.25 Mbps; it climbs
  back by a quarter every 2 seconds without congestion, up to 8 Mbps. All
  video subscribers of a device share one encoder and its bitrate, and JPEG
  subscribers of the same device still get at most the `fps` they asked
  for. Watching video needs only `read`. Without the helper, the result has
  no `video`, `fps` above 30 is lowered to 30, and `frame` events arrive as
  before; a helper that fails before its first frame also falls back to
  `frame` events within a video subscription.

  Without the helper (the compiler is missing or fails, which the server
  retries every 5 minutes, or the helper fails before its first frame), and
  for a subscription made while it is still being built, frames come from
  screenshots, and `fps` and `maxEdge` only cap the rate. Simulators are
  captured with `xcrun simctl io <udid> screenshot`, of the primary display,
  or of the default display when that `simctl` does not accept `primary`. An
  iPhone Duo lights one of two panels: the capture follows the lit one
  (`primary`, the cover, or `primary-1`, the inner panel) and the frame
  carries `posture`, `folded` or `unfolded`. Emulators are captured through
  their gRPC `getScreenshot`, scaled to fit 1280 pixels and converted with
  `sips`. An emulator whose gRPC POSTURE physical model reports a
  posture, such as a `pixel_fold` AVD, is a foldable: its frames carry
  `posture`, `folded` while the screenshot reports a folded display and
  `unfolded` otherwise. The server asks once per capture session, and a
  failed query counts as no hinge until the session restarts. A screenshot is sent only when the screen changed: up to 5 per
  second while it changes, backing off to one capture per second while it
  does not, with capturing taking at most half of each device's time, and at
  most two captures run at once. An emulator Stim booted before it passed
  `-grpc` has no endpoint on either path. A web page is captured with
  `Page.captureScreenshot`.

  A web page's frames and input go through the owned Chrome's DevTools
  endpoint, `web.cdpEndpoint` in `stim status`. Both the helper and the
  screenshot path connect only when `SystemInfo.getProcessInfo` names the
  Chrome pid status reports, then attach to the page's `targetId`. The
  helper runs `Page.startScreencast` sized to `maxEdge` and acks every
  frame; JPEG subscribers get Chrome's JPEG as is, and video decodes it for
  the encoder. Chrome draws a frame only when the page changes, so a
  keyframe request re-encodes the last one.

  With `physical: true` and `platform: "ios"`, frames come from the
  physical iPhone whose unexpired lease `stim status` lists under
  `deviceLeases` for the workspace and slot. `stim ios --device` holds that
  lease only while it runs, so `stim device lock ios <udid>` keeps the
  iPhone watchable between runs. A lease on the workspace's own simulator
  is skipped. The iPhone must be cabled over USB and trust the Mac; over
  Wi-Fi it has no screen to capture. The helper, run as
  `stim-frames iphone <udid> <name>` with the lease's device name, sets
  CoreMediaIO's `kCMIOHardwarePropertyAllowScreenCaptureDevices`, which
  makes macOS list cabled iPhones as capture devices, the ones QuickTime
  Player's New Movie Recording shows. Such a device's unique ID is a
  random UUID that names neither the UDID nor the USB device, so the
  helper first checks that an iOS device on USB has the UDID, without
  dashes, as its serial number. It then opens the iOS capture device
  named like the lease's device name, or the only one when the lease
  records no name and one iPhone is cabled. With several iPhones cabled,
  it waits until each shows a screen and refuses when none or several
  carry the name. It
  captures only while a subscriber asks for frames. macOS lets several
  processes capture the iPhone at once. Frames and video go through the
  same JPEG and H.264 paths as a simulator. A physical iPhone has no
  screenshot fallback: a subscription without the helper, or whose helper
  fails, ends with `frames-failed`, such as when the iPhone is not cabled
  or is unplugged. While macOS is asking for Camera access, or frames
  stop, such as while the iPhone is locked, the subscription gets
  `frame-delayed` with `delayed: true` and a `reason`, keeps its last
  frame, and gets `delayed: false` once frames can arrive again.

  macOS treats the iPhone's screen as a camera and attributes the helper's
  request to the app that started stim-server. Stim asks for it with its
  own Camera usage description and entitlement, so the first capture
  shows the Camera prompt for Stim. An app without them, such as `node`
  started from a shell, is denied without a prompt, and the subscription
  ends with a `frames-failed` that names the Camera pane of System
  Settings. A physical iPhone is view only: `control.begin` with
  `physical: true` refuses with `action-failed`. It is never recorded, so
  `at` and `frames.seek` on it fail with `no-recording`, and it counts
  toward no idle check.

- **Replay.** `replay.range` takes `workspace`, `platform` and `slot`
  (`default` when absent), like `frames.subscribe`, and returns what can be
  replayed of that device slot's [recording](#recording):
  - `enabled`: the workspace's `recording.enabled`, as the last status showed
    it.
  - `recording`: true while the server records the device now.
  - `spans`: the recorded time ranges `{ start, end }`, in epoch milliseconds on
    the Mac's clock, oldest first. Segments less than 1.5 seconds apart form
    one span; the gaps between spans are time nothing was recorded, such as
    after `stim stop`.
  - `markers`: `{ at, kind, command?, label }` from the start of the first span
    on, oldest first: the newest 400 actions and 100 errors. They come from `stim logs --json` in the
    workspace. `action` markers are the agent's actions on that device, failed
    ones included, from agent-device's session log and the owned Chrome page's
    agent input, with their `command`, such as `press`, `fill`, `open` or
    `click`. An agent-device action is placed when the command started, since
    it logs it when it finished, after any `--settle` wait. `error` and
    `crash` markers are error and fatal records of the workspace. Metro,
    client and build errors name no device, so they appear on every device of
    the workspace. `label` is the record's first line.

  It needs only `read`. A device with no recording gets empty `spans` and
  `markers`, and runs no `stim` command.

  `replay.keyframe` takes the same `workspace`, `platform` and `slot`, and
  `at` (epoch milliseconds), and returns one still frame for a scrubber
  preview without touching any subscription. The recording is stored in
  segments of about 5 seconds that each start at a keyframe; the server picks
  the segment `frames.seek` would show `at` from (the first one that ends at
  or after `at`, or the newest one) and reads only its first record. The
  result has the segment's `start` and `end`, the keyframe's capture time
  `at`, `width`, `height`, `posture` on an iPhone Duo, and `data`, the
  base64 Annex-B H.264 access unit with its SPS and PPS, so a client decodes
  it on its own; the server decodes nothing. The frame is the segment's first,
  so it can be up to about 5 seconds before `at`. It needs only `read`. It
  fails with `no-recording` when the device has no footage or that segment's
  first record is not a whole keyframe yet, as while it is being written. A
  connection can have 8 of these reads in flight; more fail with
  `limit-exceeded`.

  A video subscription can replay the recording instead of the live screen.
  `frames.seek` takes the `subscription`, `at` (epoch milliseconds) and `rate`
  (0, 1 or 2). The server sends the access units from the keyframe at or
  before `at` through the frame at `at`, or the newest frame when `at` is past
  it, as binary video messages right away, then plays on at `rate` times real
  time; 0 stays paused. The result's `at`
  is the capture time of the frame shown. Playback skips time nothing was
  recorded, and at the newest recorded frame it sends a `replay-ended` event
  with `subscription` and `at` and stays paused there. `frames.live` returns
  the subscription to the live screen, starting at a keyframe, or fails with
  `frames-failed` when the device is not running. While a subscription
  replays, the server sends no live frames on it, and `frames.keyframe`
  resends the frame shown from its keyframe. A seek on a device with no
  recording fails with `no-recording` and leaves the subscription live, and a
  JPEG subscription cannot seek.

  `frames.subscribe` with `at`, and optionally `rate`, starts the subscription
  replaying, and needs `video: ["h264"]`. It needs no running device, so the
  footage of a stopped workspace can be replayed; it fails with
  `no-recording` when nothing was recorded, and sends `replay-ended` at once
  when that footage holds no frame to show. Clients that never send these
  messages see no change.

- `recording.set` takes `enabled` and runs
  `stim settings set recording.enabled <enabled> --scope machine --json` in
  the home directory. It needs `control`, is logged like an
  [action](#actions) with `action` `recording.set`, and returns `enabled` and
  `recordingsDeleted`, the workspaces whose recordings turning recording off
  deleted.
- `build.plan` takes `workspace`, `platform` (`ios` or `android`) and `slot`
  (`default` when absent), and returns the payload of
  `stim <platform> --plan --json` run in the workspace: the fingerprint, the
  cache result the next build would get (`local`, `remote` or `false`), the
  prebuild decision, `expectedMs` with its `basis`, and on a predicted cold
  build its `missReason`. It builds, boots and
  installs nothing and writes no Stim state; a remote cache check can
  download the artifact into a temporary directory, so it gets 150 seconds
  instead of 60. A plan predicting that the build would refuse is a result
  whose `refusal` holds the code, message and remedy. A plan that cannot be
  computed is a `stim-failed` error. One plan runs per workspace at a time,
  across all connections; later requests wait their turn, and the 150
  seconds start when the plan starts.
- `machine.get` returns cheap machine usage, read in the server process
  without running `stim`: `volumes`, one per volume that holds a Stim
  workspace, Stim home, or the simulators, with `mount`, `holds`, `freeBytes`
  (free space without purgeable space, which Stim's disk budget measures) and
  `totalBytes`; `memory` with `totalBytes`, `usedBytes` (the Mac's memory in
  use as Activity Monitor's "Memory Used" counts it: app memory, wired and
  compressed; null off macOS) and the macOS `pressure` level (`normal`,
  `warning`, `critical`, or null); `load` with the 1, 5 and 15
  minute load averages and `cpus`; and `sampledAt`.
- `machine.history` returns `{ "intervalMs", "samples" }`: machine usage
  sampled every 5 seconds while at least one client is connected, the last
  720 samples (an hour of connected time), kept in memory only. Each sample
  has `at` (epoch milliseconds), `cpu` (busy fraction since the previous
  sample), `memoryUsedBytes`, `memoryPressure` (0 normal, 1 warning, 2
  critical) and `diskFreeBytes` of the startup volume; a field is null when it
  cannot be read. `sinceMs` returns only the samples taken after it.
- `machine.details` returns `{ "gc", "stats", "measuredAt" }`: the payloads of
  `stim gc --json` and `stim stats --json`, both run in the home directory, so
  a phone can show what Stim Desktop's Machine page shows about disk: every
  simulator, AVD, iOS runtime and system image, shared caches, recordings,
  workspace build outputs and logs, and what `stim gc --delete` would free. The
  `gc` run is always the dry run with no other flag; the server never deletes
  anything for this request. A part is null when its command failed, and
  `gcError` or `statsError` says why. It needs only `read`. The server keeps
  one result for 60 seconds, shared by every connection: a request while the
  commands run waits for them, and `measuredAt` says when they started. The
  commands fail after 150 seconds. Servers that predate it answer
  `unknown-method`. It also carries `buildMachines`, the `buildMachines` list
  of `stim doctor --json --platform ios` (never with `--fix`), so a phone can
  show whether each build machine takes builds. The server runs doctor only
  when `offload.machines` names a machine, else the list is empty; it runs it
  in the registered workspace that ran doctor for iOS most recently, because
  doctor judges a machine against an app. Like a doctor run from a terminal,
  that records the run for the workspace. `buildMachines` is null with
  `buildMachinesError` when doctor failed, the config could not be read, or no
  registered workspace exists. The reply never waits for doctor, whose offer
  to an unreachable machine can take about 13 seconds: it carries the last
  settled `buildMachines`/`buildMachinesError` (with `buildMachinesAt`, when
  they settled) while doctor refreshes them in the background, at most one run
  at a time, and sets `buildMachinesPending` while that background run has not
  settled a result yet, or the settled one is 60 seconds old or older. A client
  that wants the refreshed result asks `machine.details` again.
- `unsubscribe` ends a subscription.
- `push.register` takes `token`, an Expo push token, `events`, one or more
  [push notifications](#push-notifications) the phone wants (`started`,
  `stuck`, `looping`, `finished`, `machine`, `control`), `ref`, an opaque
  string of up to 128 characters that every push carries back as `data.ref`,
  and optionally `stuckMinutes` (1 to 240, default 15), `quietHours`
  (`{ "start", "end", "timeZone" }`, minutes after midnight in an IANA time
  zone) and `levels`, each event's [delivery level](#delivery-levels) (for
  example `{ "stuck": "silent", "machine": "alert" }`). It needs only `read`. Registering again replaces the device's
  registration; `push.unregister` removes it. Phones from before these events
  may still send `build-failed`, `log-errors`, `disk`, `app-stopped`,
  `slow-build` and `agentOnly`: `disk` counts as `machine`, and the rest are
  accepted and ignored.
- `notifications.list` returns the [notification history](#notification-history)
  as `{ "log", "cursor", "notifications" }`, newest first. `since` (a `cursor`
  from an earlier list) returns only the entries after it. From then on, the
  connection gets a `notification` event, `{ "event": "notification", "log",
"notification" }`, for each entry the server logs. It needs only `read`.
- `action` runs an [action](#actions) and returns
  `{ "action", "workspace", "output" }`.
- An `error` event ends a subscription whose source failed, or whose client
  fell behind (`slow-client`); subscribe again.

`workspace` is an environment `path` from a status payload. Any other path is
refused with `unknown-workspace` and runs nothing. A connection holds at most
32 subscriptions and runs at most 4 `logs.query`, `stats.get`,
`settings.get` and `build.plan` requests at a time. Those requests fail after
60 seconds, `build.plan` after 150, or at 32 MiB of output, and closing the
connection stops them. When the command refuses with Stim's error contract on
stdout, the `stim-failed` message is its code, message and remedy; otherwise
it is the exit status and the end of stderr. A `stim` child that
ignores SIGTERM gets SIGKILL a second later. A log subscriber whose socket has more than
4 MiB unsent gets no more batches until it catches up; past 20,000
waiting records the server ends that subscription with `slow-client`.

## Recording

The server records owned simulators, emulators and the Stim-owned Chrome page
so clients can replay what happened while nobody watched. It records a device
while `stim status` shows an automation tool driving it (`activity.state` is
`driven`), or while a client has a `frames.subscribe` subscription to it. It
records nothing else, holds no device awake and changes no device setting. To
see drivers, the server keeps one `stim status --watch --json` child running
for as long as it runs, shared with status subscribers.

Recording goes through the device's `stim-frames` helper, shared with live
subscribers. The helper runs a second H.264 encoder for it, at 720 pixels on
the long edge, 1 Mbps and at most 10 frames a second, so live video keeps its
own bitrate. Live frames are captured at no less than 720 pixels and 10 frames
a second while the device is recorded. A device on screenshots, without the
helper, is not recorded, and a helper that fails is started again after 5
seconds, doubling up to 5 minutes. One stim-server records and prunes a Stim
home at a time, under an exclusive ownership claim at
`$STIM_HOME/server/recorder`; a second one serves replays and records once the
claim frees.

Footage is stored under `$STIM_HOME/workspaces/<id>/recordings/<platform>-<slot>/`
as segments of about 5 seconds, each starting at a keyframe; the server asks
the helper for a keyframe once a segment is 5 seconds old, so a screen that
does not change still gets new segments, and a keyframe request also restarts
the recording stream at a keyframe. The segment being
written is `<start>.part`, and a closed segment is `<start>-<end>.seg`, in epoch
milliseconds. A segment is a sequence of records: a u32 big-endian length of
the rest, u8 flags (bit 0 keyframe, bit 1 folded, bit 2 unfolded, as in a video
packet), f64 capture time in milliseconds since the epoch, u16 width, u16
height, then one Annex-B access unit. The server creates a segment only while
the workspace directory has its `workspace.json`, so it never fills a directory
that `stim worktree remove` or `stim gc` emptied.

Every 30 seconds it keeps the last 15 minutes of footage of each device,
counting only recorded time, and at most 1 GiB of footage across every
workspace, deleting the oldest segments first. It closes, at their last write,
the `.part` segments of a server that stopped. When a status payload shows
`recording.enabled` false for a workspace (the `recording.enabled` setting, or
`STIM_RECORDING` in the server's environment), it stops recording that
workspace within seconds and deletes its recordings. `stim stop` ends recording
and keeps the footage; `stim worktree remove` and `stim gc` delete it. A gc that
deletes the segment being written loses the rest of that segment; the next one
is written as usual. Recordings stay on the Mac and are served only to paired
clients.

## Push notifications

A paired phone that sends `push.register` gets notifications while its app is
in the background or closed. The server keeps the registration with the
pairing in `devices.json`, so revoking the device drops it. A token belongs to
one pairing: registering it from a new pairing of the same phone removes it
from the old one.

A notification means that your attention changes the outcome, or that work you
wait on started or finished. A failed build, new log errors, a stopped app or a
slow build on their own are normal agent iteration and do not push; the phone
shows them in its attention strip. The server pushes, per device and only for
the events the device chose:

- `started`: a workspace began warming (`phase` `warming`), or an agent first
  drove one of its devices. It is grouped per Mac, and opens the workspace, or the device viewer
  once an agent drives it. An agent driving the workspace updates the warming
  notification in place.
- `stuck`: an agent drove the workspace, its devices are still up, and nothing
  happened for `stuckMinutes`: no agent action, build, Stim run, Metro bundle
  request or new log error. App log records do not count, because an idle app keeps
  logging: an idle Stim app writes about 200 UIKit info records a minute. The
  owned Chrome page counts as a device: an attached tool's input there is an
  agent action, and while an agent drives it its page log also counts, since an
  agent's navigations and scripts are not agent actions. It opens the device viewer.
- `looping`: the newest three or more iOS or Android builds failed the same
  way, at the same first compiler diagnostic `file:line`, or with the same
  error code when there is none, such as three failed launches
  (`STIM_LAUNCH_FAILED`, which includes an app that exits at launch). It says,
  for example, `Same Swift error 3x at AppDelegate.swift:71` and opens the
  build details.
- `finished`: the agent stopped driving after a green build and nothing
  happened for 5 minutes, or stopped the workspace after a green build; the
  workspace's pull
  request became ready for review, or merged, which opens the pull request; or,
  when GitHub cannot be asked, git finds the branch merged into the default
  branch.
- `machine`: a volume holding Stim state has less than 5 GB free (the episode
  ends once 6 GB are free again), or memory pressure stayed critical for a
  minute. It opens the machine sheet.
- `control`: another client took over a device this phone controls, or an
  agent started driving it. It opens the device viewer.

Stuck and finished are read from device activity, so two cases blur them. An
agent that finishes without closing its agent-device session still holds the
device, so it gets `stuck`, whose text then names the green build it stopped
after. With a `stim` whose status has no `activity.recent`, every app log
record counts as activity, so an app that keeps logging never looks stuck or
finished.

Each workspace notifies once per episode: a stuck agent notifies again only
after new activity and a new quiet stretch, a loop only after a success or a
different failure. A push carries a collapse id for its workspace and
category, so a later one replaces the earlier notification on the phone
instead of stacking. What is already true when the server starts or a device
registers does not push. During the phone's quiet hours nothing pushes: a
problem that still holds when they end pushes then, and what started or
finished during them does not.

While at least one device is paired, the server keeps its own
`stim status --watch --json` child running, even with no client connected, and
reads the free space of Stim's volumes and the memory pressure every minute.
While a device wants `finished`, it looks up the pull requests of worktree
branches that have an upstream every 5 minutes, with one `gh api graphql` call
per repository, the lookup `stim gc` uses. Without `gh`, or when it is signed
out or does not answer, that round relies on git, and the next round asks
again.

A device gets at most 20 alerting pushes an hour; silent pushes do not
count. More than three at once become one summary push that opens the
phone's home screen.

Pushes go to the Expo push service, `https://exp.host/--/api/v2/push/send`,
which forwards them to Apple. No APNs key or other secret lives on the Mac. A
workspace push carries the workspace title, a one-line cause and the Mac's name
as the subtitle; a machine or summary push has the Mac's name as its title. In
`data` it carries the `ref`, the screen to open (`home`, `machine`,
`workspace`, `device`, `build` or `url`), and the workspace's absolute path,
with the platform and slot for a device, the platform for build details and
the pull request's URL for `url`. The phone needs the path to open a workspace
before it has reconnected. It carries no logs. The server checks the push
receipts 15 minutes later and drops a token that Expo reports as
`DeviceNotRegistered`, and prints any other refusal, such as missing APNs
credentials, on stderr. Pushes are not retried, and nothing is pushed while
the server is not running.

### Delivery levels

Each event the device registers is delivered at one of two levels; an event it
leaves out of `events` is off and never pushes.

- `alert`: a banner and sound. The push has `sound: "default"`,
  `interruptionLevel: "active"` and `channelId: "attention"`, the phone's
  high-importance Android channel.
- `silent`: no banner or sound, only the notification list.
  The push has no sound, `interruptionLevel: "passive"` and
  `channelId: "updates"`, the phone's low-importance Android channel.

`levels` in `push.register` sets each event's level. An event it leaves out,
and every event of a phone that sends no `levels`, is silent. A summary push is
silent only when every notification it sums up is. An older server ignores
`levels` and alerts for every event but `started`.

The rules live in `src/oversight.ts`, a pure module the phone app keeps an
identical copy of (`apps/mobile/src/lib/oversight.ts`) for its local
notifications; `__tests__/oversight-agreement.test.ts` fails when they differ.

## Notification history

The server logs the notifications the rules produce for the Mac, whether or not
a phone was pushed, so a phone can list what it missed. While any device is
paired, it runs the rules once more for the Mac itself, with every category, no
quiet hours and the lowest `stuckMinutes` a registered device asked for (15
without one). Each notification it produces is an entry; a `control` conflict is
an entry too, listed only to the phone that lost the device. Pull request
entries need the GitHub lookup, which runs only while a device wants
`finished`.

An entry is `{ "seq", "at", "id", "category", "title", "body", "quiet",
"target", "suppressed"? }`. `seq` grows by one per entry. `id` names the
workspace or machine and category, the key a push's collapse id is made from,
so a later episode of the same problem shares it. `target` is the screen the
push opens, as `{ "kind", ... }` with the fields of the push's `data`.
`quiet` is the event's default delivery, always silent; a device's
[levels](#delivery-levels) decide how its push was actually delivered.
`suppressed` says why no registered device got the notification when it was
logged: `muted` when none wants its category, `quiet-hours` when those that do
were in quiet hours. A problem that still holds when quiet hours end is pushed
then, so a `quiet-hours` entry may still have reached the phone. Without
`suppressed`, a registered device was due to get it, or none is registered; a
device's hourly budget or a summary push can still stand in for the push
itself. A push for a logged notification carries the entry's `seq` as `data.notification`, so the
phone can mark it read.

The log keeps the last 200 entries, none older than 7 days, in
`$STIM_HOME/server/notifications.json`, which only the server writes, under
`notifications.json.lock`. `log` in `notifications.list` is a random id made
with the file: a new one means the history started over, so a cursor or read
state kept for the old one no longer applies. What is already true when the
server starts is not logged, as it is not pushed.

## Actions

A device with `control` can send `action` with params `{ "action", "workspace" }`:

| Action   | Params                                                               | Runs in the workspace           |
| -------- | -------------------------------------------------------------------- | ------------------------------- |
| `reload` | `platform` (`ios` or `android`), optional; needed when both are live | `stim reload [platform] --json` |
| `stop`   | none                                                                 | `stim stop --json`              |

Each action is one fixed argument list passed to the bundled `stim`, never
through a shell. `workspace` must be a project path Stim has registered, the
`path` a status payload lists; the command runs there. The result's `output`
is the JSON the command printed. The server refuses the request and runs
nothing with:

- `forbidden` when the device has only `read`;
- `unknown-action` for any other action;
- `bad-request` for a missing `workspace`, a `platform` that is not `ios` or
  `android`, or any other param;
- `unknown-workspace` for a path Stim has not registered or that no longer
  exists;
- `action-busy` while another action runs in that workspace. The server runs
  one action per workspace at a time, across all connections.

A command that exits with an error fails with `action-failed` and the message
and remedy it printed. An action fails with `action-failed` after 120 seconds,
and its `stim` child gets SIGTERM. An action keeps running when its client
disconnects, and stopping `stim-server` stops it.

Every `action` request from a paired device, refused or run, appends one line
to `$STIM_HOME/server/actions.ndjson`: `at`, `device` (`id` and `name`),
`action`, `workspace`, `platform` when given, `ok`, `error` when it failed,
and `durationMs` when it ran. Strings from the client and error messages are
cut to 256 characters. `stim-server log` prints them, with control characters
replaced by `?`.

## Control

A device with `control` can drive a simulator or emulator that `stim status`
lists as owned by a workspace, or a physical Android phone the workspace
leases (see [Physical Android devices](#physical-android-devices)). Nothing it
sends reaches any other device.

- `control.begin` takes `workspace`, `platform`, `slot` (`default` when
  absent), `physical` and `takeOver`, and returns `{ "session", "platform", "lease",
"postures" }`. `postures` lists what `input.posture` takes for the device:
  `folded` and `unfolded` for an iPhone Duo, `folded`, `half-open` and
  `unfolded` for an emulator with a hinge, such as a `pixel_fold` AVD, and
  none otherwise.
  The server refuses with `device-busy` when status reports the device driven
  (agent-device, a `stim device lock`, a test runner) or another client
  controls it, naming the driver. With `takeOver: true` it proceeds anyway;
  another client's session then ends with `taken-over`.
- The session holds a `stim device lock <platform> <id> --for 2m` lease,
  renewed every minute, so `stim status` shows the device as driven by
  `stim device lock` and agents leave it alone. `lease` carries its
  `grantedAt`, the `since` of that driver, so a client can tell its own lease
  from an agent's. The server releases the lease with `stim device unlock`
  when the session ends, unless the lease was already held before the session
  began, as when it took the device over from an agent in the same workspace;
  it renews only a lease it took. Leases belong to the workspace, not to the
  session: an agent in the same workspace that runs `stim device lock` on the
  device during a session shares the lease, and the session's end releases
  it.
- `input.touch` takes `session`, `phase` (`down`, `move`, `up`), `x` and `y`
  as fractions of the upright screen, and `display` (0, the main display).
  Without `display`, a touch on an iPhone Duo goes to the panel its latest
  frame showed, and before any frame to the cover.
  `input.text` takes up to 256 printable ASCII characters, where `\n` presses
  Return, `\t` Tab and `\b` Delete. `input.button` takes `home` or `lock`,
  and on Android also `back` or `app-switch`. `input.rotate` takes
  `direction` (`left` or `right`) and turns the device a quarter turn. An
  iPhone Duo refuses it with `bad-request`: its iOS 27.1 runtime receives the
  orientation event but keeps the orientation its posture sets.
  `input.posture` takes one of the session's `postures`. A web page takes
  only `back`, its history back, and refuses rotation and posture. Each answers `{}` once the input
  is handed to the device: when it goes through the helper, that is when the
  helper receives it, so a failure there shows only in the server's log. A connection may send 120 inputs a second and type 40
  characters a second, with a burst of 256, and rotate or change posture twice a
  second; more fail with `limit-exceeded`.
- `control.end` ends a session. The server also ends it with a
  `control-ended` event `{ "session", "reason", "message" }` after 5 minutes
  without input (`idle`), when another client takes the device over
  (`taken-over`), when the device stops or changes owner (`device-gone`),
  when the paired device loses `control` (`forbidden`), or when input cannot
  reach the device (`failed`). Closing the connection ends its sessions.

Input goes through the device's `stim-frames` helper, the process that
streams its frames:

- Simulators take touches, keys and buttons through the simulator's
  CoreDevice HID service (`dtuhidd`), the one Xcode's Device Hub uses, so
  input keeps working while Device Hub or Siniulator shows the simulator.
  With an Xcode whose simulators have no such service, input goes through
  SimulatorKit's legacy HID client instead. The first input starts that service, as Device
  Hub does, and from then until the simulator reboots it ignores tools that
  still use SimulatorKit's legacy HID client. Text is typed key by key on a US
  layout. `lock` is the side button.
- A web page takes DevTools input on the page's `targetId`: touches as
  `Input.dispatchTouchEvent` (a drag scrolls, on a desktop page too), text as
  key events, `\n`, `\t` and `\b` as Enter, Tab and Backspace. A web
  session holds no lease, since `stim device lock` covers devices; a
  DevTools client other than Stim's attached to the browser (`web.activity`
  in status, such as Playwright MCP) makes `control.begin` answer
  `device-busy` unless it takes over.
- Emulators take touches through the emulator's gRPC `sendTouch`. Text and
  buttons go through gRPC `sendKey` when the emulator reports a hardware
  keyboard, which AVDs Stim creates have. An emulator without one drops key
  events, so for it text and buttons go through `adb -s <serial> shell input`.
- Rotation and posture go the way Stim Desktop sends them: a simulator turns
  through the orientation message Simulator.app sends it, and an emulator
  through gRPC `setPhysicalModel` for rotation and `setPosture` for its hinge.
  An iPhone Duo folds with `sim-fold`, which the server builds from Stim
  Desktop's sources on the first fold and runs inside the simulator with
  `xcrun simctl spawn`; it answers `{}` once the fold finished, and fails
  with `action-failed` when the fold does not finish within 40 seconds. `sim-fold`
  swaps the posture, so the server runs it only when the Duo's latest frame
  shows the other posture, and refuses the request until a frame showed one.

Every session start, takeover and end, and every refused `control.begin`,
appends a line to the action log, with `action` set to `control.begin`,
`control.take-over` or `control.end`, and a `reason` that says why the session
ended or whom it took the device from. Inputs are not logged.

The error codes `unauthorized`, `pairing-expired`, and `protocol-unsupported`
refuse the client until it pairs again or updates; `approval-pending` refuses
a build client until the Mac approves it; clients retry the others.

The package exports the message types, and the build writes their JSON Schema
to `dist/protocol.schema.json`, exported as `@stim-cli/server/protocol.schema.json`.

## Physical Android devices

A phone reached with `stim android --device <serial>` (or held with
`stim device lock android <serial>`) is used, not owned. With `physical: true`,
`frames.subscribe` and `control.begin` pick the phone the workspace holds an
unexpired lease on in `slot`, as `deviceLeases` in `stim status` reports it,
instead of the Stim-owned emulator. A workspace without that lease gets
`frames-failed` or `action-failed`, and so does a slot whose leased device is
an emulator. Watching needs `read`, as for an emulator. Control needs
`control` and that lease: the session never takes, renews or releases a
phone's lease, and `takeOver` cannot move one between workspaces. When the
lease is released or expires, the control session ends with `device-gone` and
frame subscriptions end with `frames-failed`. Both follow `stim status
--watch`: a release reaches the server when status next reports it, usually
within seconds and at most about 30 seconds plus one refresh. Input after an
expiry is refused at once. A physical Android device is not recorded, so `at`
and `frames.seek` answer `no-recording`, and a watched phone is not listed as
viewed for Stim's idle checks.

The `stim-frames` helper reaches the phone over adb only, with the scrcpy
server 4.1 (Apache-2.0), shipped in `dist/scrcpy/` with its `LICENSE` and a
`NOTICE`. Before every push, the helper checks the jar's sha256 against the one
pinned in its source. It then pushes the jar to
`/data/local/tmp/stim-scrcpy-<id>.jar`, starts it with `app_process` as the
shell user, and connects through an `adb forward` port. The server's cleanup
process deletes the jar as soon as it runs; when the helper stops, it removes
the forward and deletes the jar again. It installs nothing, and it asks
scrcpy for no settings change: no `show_touches`, no `stay_awake` and no
screen power change (`power_on=false`), with clipboard sync off. The phone
encodes H.264 of its screen as it is oriented, scaled to fit 2048 pixels;
the helper decodes it with VideoToolbox and feeds the same encoder, JPEG path,
keyframe requests and bitrate adaptation as a simulator or emulator. The
stream has no time limit and restarts only with the helper.

Input goes over scrcpy's control socket: touches as finger events in the
current frame's pixels, text as injected text, and `\n`, `\t`, `\b`,
`home`, `back`, `app-switch` and `lock` as key events. `input.rotate` and
`input.posture` fail with `bad-request`, because a phone turns only in hand.

Some Android 15 and 16 devices send no frame until their screen changes
(scrcpy #6500, #6546), so a tile can stay blank until then. With its screen
off, a phone streams what its display shows, such as a Samsung always-on
display, or black; the stream never wakes it.

For testing without a phone, `STIM_SERVER_TEST_ADB_EMULATORS=1` in the
server's environment lets a `physical: true` target resolve to an emulator the
workspace leases, which then streams and takes input over adb the same way.
