# @stim-cli/server

`stim-server` serves Stim state to paired clients, such as the Stim phone app,
and lets the clients the Mac grants control run `stim reload` and `stim stop`
in a workspace. It runs on the Mac, next to Stim. It changes Stim state only
through those two commands, and writes only its own pairing state and action
log under `$STIM_HOME/server/`.

The design is in
[`docs/specs/2026-09-25-stim-server-design.md`](../../docs/specs/2026-09-25-stim-server-design.md).

## Commands

```bash
stim-server [--port <n>]          # serve paired clients, port 7787 by default
stim-server pair [--port <n>] [--control]
                                  # print a single-use pairing payload
stim-server devices [list]        # list paired devices
stim-server devices grant <id> --control|--read
                                  # let a paired device run actions, or only read
stim-server devices revoke <id>   # revoke a paired device
stim-server log                   # list the actions paired devices ran
```

`pair --json` prints `{ "qr": <payload>, "expiresAt": "<ISO time>" }`, and
`devices --json` prints `{ "devices": [...] }` with each device's `id`, `name`,
`identity`, `pairedAt`, `lastSeenAt` and `capabilities`, never its token hash.
`log --json` prints `{ "actions": [...] }`, the records described under
[Actions](#actions).

`GET http://127.0.0.1:7787/health` answers requests from this Mac with the
server's name, versions, protocol, `stimHome`, and the Tailscale state it
started with. While Tailscale runs, it also carries `route`, read from
`tailscale serve status --json` on each request: `routed` with the HTTPS
`port` that proxies to the server, `funneled` with the Funnel `ports` that do,
`missing`, or `unknown` with a `reason`; the last three carry the `port` the
setup command would use. Stim Desktop uses it to find a running server and
show its route. A request through
`tailscale serve`, on a Tailscale address, or with a `Host` other than
`127.0.0.1` or `localhost` gets HTTP 426, like any other plain HTTP request.

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

## Protocol

JSON messages over a WebSocket. Requests are `{ "id", "method", "params" }`,
answered by `{ "id", "result" }` or `{ "id", "error": { "code", "message" } }`.
Events are `{ "event", "subscription", ... }`.

- `hello` must come first. Params: `protocol` (1), `client` (`name`,
  `version`), and `auth`, either `{ "pairingToken", "deviceName" }` or
  `{ "deviceToken" }`. The result carries the server name and versions, the
  device's `capabilities` (see [Scopes](#scopes)), the `actions` it may run
  (none without `control`), the paired device, and the new `deviceToken` when
  the hello paired. `server.home` is the home folder
  of the user the server runs as, so clients can show paths under it as
  `~/...`.
- `status.subscribe` returns a subscription id. Each `status` event carries a
  full payload as `stim status --watch --json` prints it. All subscribers share
  one `stim status --watch --json` child, which stops with the last
  subscriber.
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
  `stim web` (default slot only);
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
- `unsubscribe` ends a subscription.
- `push.register` takes `token`, an Expo push token, `events`, one or more
  [push notifications](#push-notifications) the phone wants (`started`,
  `stuck`, `looping`, `finished`, `machine`, `control`), `ref`, an opaque
  string of up to 128 characters that every push carries back as `data.ref`,
  and optionally `stuckMinutes` (1 to 240, default 15) and `quietHours`
  (`{ "start", "end", "timeZone" }`, minutes after midnight in an IANA time
  zone). It needs only `read`. Registering again replaces the device's
  registration; `push.unregister` removes it. Phones from before these events
  may still send `build-failed`, `log-errors`, `disk`, `app-stopped`,
  `slow-build` and `agentOnly`: `disk` counts as `machine`, and the rest are
  accepted and ignored.
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
  drove one of its devices. It is delivered quietly, without sound (iOS
  `passive`), grouped per Mac, and opens the workspace, or the device viewer
  once an agent drives it. An agent driving the workspace updates the warming
  notification in place.
- `stuck`: an agent drove the workspace, its devices are still up, and nothing
  happened for `stuckMinutes`: no agent action, build, Metro bundle request, app
  log record or new log error. It opens the device viewer.
- `looping`: the newest three or more iOS or Android builds failed the same
  way, at the same first compiler diagnostic `file:line`, or with the same
  error code when there is none, such as three failed launches
  (`STIM_LAUNCH_FAILED`, which includes an app that exits at launch). It says,
  for example, `Same Swift error 3x at AppDelegate.swift:71` and opens the
  build details.
- `finished`: the agent stopped driving after a green build and nothing
  happened for 5 minutes, or it stopped the workspace; the workspace's pull
  request became ready for review, or merged, which opens the pull request; or,
  when GitHub cannot be asked, git finds the branch merged into the default
  branch.
- `machine`: a volume holding Stim state has less than 5 GB free, or memory
  pressure stayed critical for a minute. It opens the machine sheet.
- `control`: another client took over a device this phone controls, or an
  agent started driving it. It opens the device viewer.

Each workspace notifies once per episode: a stuck agent notifies again only
after new activity and a new quiet stretch, a loop only after a success or a
different failure. A push carries a collapse id for its workspace and
category, so a later one replaces the earlier notification on the phone
instead of stacking. What is already true when the server starts or a device
registers does not push. During the phone's quiet hours nothing pushes: a
problem that still holds when they end pushes then, and what started or
finished during them does not.

While at least one device is registered, the server keeps its own
`stim status --watch --json` child running, even with no client connected, and
reads the free space of Stim's volumes and the memory pressure every minute.
While a device wants `finished`, it looks up the pull requests of worktree
branches that have an upstream every 5 minutes, with one `gh api graphql` call
per repository, the lookup `stim gc` uses. Without `gh`, or when it is signed
out or does not answer, it stops asking and relies on git.

A device gets at most 20 pushes an hour. More than three at once become one
summary push that opens the phone's home screen.

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

The rules live in `src/oversight.ts`, a pure module the phone app keeps an
identical copy of (`apps/mobile/src/lib/oversight.ts`) for its local
notifications; `__tests__/oversight-agreement.test.ts` fails when they differ.

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
lists as owned by a workspace. Nothing it sends reaches any other device.

- `control.begin` takes `workspace`, `platform`, `slot` (`default` when
  absent) and `takeOver`, and returns `{ "session", "platform", "lease",
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
  `input.text` takes up to 256 printable ASCII characters, where `\n` presses
  Return, `\t` Tab and `\b` Delete. `input.button` takes `home` or `lock`,
  and on Android also `back` or `app-switch`. `input.rotate` takes
  `direction` (`left` or `right`) and turns the device a quarter turn.
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
refuse the client until it pairs again or updates; clients retry the others.

The package exports the message types, and the build writes their JSON Schema
to `dist/protocol.schema.json`, exported as `@stim-cli/server/protocol.schema.json`.
