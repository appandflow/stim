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
- `frames.subscribe` takes `workspace`, `platform` (`ios` or `android`),
  `slot` (`default` when absent), `fps` (1 to 30, 5 by default) and `maxEdge`
  (240 to 2048 pixels, 1280 by default), and sends `frame` events: a JPEG,
  base64 in `data`, with `width`, `height` and `capturedAt`, at most `fps` a
  second and only when the screen changed. It serves only a booted simulator
  or a running emulator that `stim status` lists as owned by that workspace;
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
  upright; for an emulator it keeps one gRPC `streamScreenshot` call open,
  found through the discovery file and token the emulator writes when Stim
  boots it. It scales frames to fit the largest `maxEdge` and paces them to
  the highest `fps` its subscribers asked for. All subscribers of a device
  share one helper, which sends a new subscriber the latest frame and exits
  with the last subscriber or when the server's end of its stdin closes.

  A client that decodes H.264 adds `video: ["h264"]`. When the helper is
  built, the result carries `video: "h264"`, `fps` may go up to 60, and
  frames arrive as binary WebSocket messages instead of `frame` events: a
  big-endian header (u8 version 1, u8 flags with bit 0 set on a keyframe,
  u16 header length, u32 sequence number of the messages sent on this
  subscription, f64 capture time in milliseconds since the epoch on the
  Mac's clock, u16 width, u16 height, u8 subscription id length and the
  ASCII id), then one Annex-B access unit. Every keyframe carries its SPS
  and PPS, and the stream has no B-frames, so each access unit is shown as
  it arrives. The helper encodes with VideoToolbox in real time: Main
  profile, a keyframe at least every 2 seconds, straight from the
  simulator's IOSurface or from the emulator's RGBA frames, only when the
  screen changed. A subscriber starts at a keyframe, and `frames.keyframe`
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
  before; an iPhone Duo and a helper that fails before its first frame also
  fall back to `frame` events within a video subscription.

  Without the helper (the compiler is missing or fails, which the server
  retries every 5 minutes, or the helper fails before its first frame), for a
  subscription made while it is still being built, and for an iPhone Duo,
  frames come from screenshots, and `fps` and `maxEdge` only cap the rate. Simulators are
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
  `-grpc` has no endpoint on either path.

- `build.plan` takes `workspace`, `platform` (`ios` or `android`) and `slot`
  (`default` when absent), and returns the payload of
  `stim <platform> --plan --json` run in the workspace: the fingerprint, the
  cache result the next build would get (`local`, `remote` or `false`), the
  prebuild decision, and `expectedMs` with its `basis`. It builds, boots and
  installs nothing and writes no Stim state; a remote cache check can
  download the artifact into a temporary directory, so it gets 150 seconds
  instead of 60. A plan predicting that the build would refuse is a result
  whose `refusal` holds the code, message and remedy. A plan that cannot be
  computed is a `stim-failed` error.
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
  absent) and `takeOver`, and returns `{ "session", "platform", "lease" }`.
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
  began, as when it took the device over from an agent in the same workspace.
- `input.touch` takes `session`, `phase` (`down`, `move`, `up`), `x` and `y`
  as fractions of the upright screen, and `display` (0, the main display).
  `input.text` takes up to 256 printable ASCII characters, where `\n` presses
  Return, `\t` Tab and `\b` Delete. `input.button` takes `home` or `lock`,
  and on Android also `back` or `app-switch`. Each answers `{}` once the input
  is sent. A connection may send 120 inputs a second; more fail with
  `limit-exceeded`.
- `control.end` ends a session. The server also ends it with a
  `control-ended` event `{ "session", "reason", "message" }` after 5 minutes
  without input (`idle`), when another client takes the device over
  (`taken-over`), when the device stops or changes owner (`device-gone`),
  when the paired device loses `control` (`forbidden`), or when input cannot
  reach the device (`failed`). Closing the connection ends its sessions.

Input goes through the device's `stim-frames` helper, the process that
streams its frames:

- Simulators take touches, keys and buttons through SimulatorKit's HID
  client, addressed to the main screen. Text is typed key by key on a US
  layout. `lock` is the side button. On Xcode 27 (27A266a), a simulator
  shown in Xcode's Device Hub ignored this input in testing, while the same
  simulator booted without a Device Hub window took it.
- Emulators take touches through the emulator's gRPC `sendTouch`. Text and
  buttons go through `adb -s <serial> shell input`, because Stim's AVDs have
  no hardware keyboard and the emulator drops gRPC key events.

Every session start, takeover and end, and every refused `control.begin`,
appends a line to the action log, with `action` set to `control.begin`,
`control.take-over` or `control.end`, and a `reason` that says why the session
ended or whom it took the device from. Inputs are not logged.

The error codes `unauthorized`, `pairing-expired`, and `protocol-unsupported`
refuse the client until it pairs again or updates; clients retry the others.

The package exports the message types, and the build writes their JSON Schema
to `dist/protocol.schema.json`, exported as `@stim-cli/server/protocol.schema.json`.
