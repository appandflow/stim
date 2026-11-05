# Device presence: who is touching the device, and where

Status: proposed design, 2026-11-02 (#4871). Decided 2026-11-03: agents use a `stim agent-device` wrapper command
(6.2), not an HTTP route, and it ships first as phase 1. Section 12 lists the decisions still open; they concern the
later phases.

## Goals

- Everyone watching a device sees who is interacting and where: a colored touch dot, a drag trail and a short name
  label per participant, live.
- A web share (`stim share`) can have a view password and a control password. View-only viewers watch and see
  everyone's touches; control viewers can also tap.
- Automation input from agent-device shows on the same overlay, labeled as the agent and its command.
- Agents drive a workspace's device through one `stim` command that wraps agent-device, so Stim sees every action,
  revives an idle workspace before the first one, counts each as activity, and highlights the element an action
  targets.
- One protocol for the web viewer, Desktop's viewer and the phone app. The web viewer stays a subset of Desktop's.

## Non-goals

- Multi-touch. The `stim-frames` helper and the adb path drive one pointer (`InputTouchParams` has no pointer id).
- Cursors for hovering viewers. Only touches are shown.
- Presence for physical iPhones (view only) and macOS windows. macOS can follow later with the same event.
- A generic automation endpoint for Maestro or Appium-style clients. The wrapper speaks agent-device's CLI only.
- Persisting names or presence. Nothing in this design writes a participant's name to disk.

## 1. How it works today

- **Control.** `ControlHub` (`packages/server/src/control.ts`) allows one control session per device. `begin` refuses
  with `device-busy` while an agent, a device lock or another client drives the device, unless `takeOver` is set; a
  take-over ends the previous session with `control-ended` / `taken-over`.
- **Shares.** Every viewer of a share acts through one session, `share.controlSession`, owned by a synthetic
  controller `share-<id>` named "Web share" (`share.ts`). The share starts it on the first input, never with
  `takeOver`, and retries 5 s after a refusal. Viewers have no identity: two viewers dragging at once interleave
  their `down`/`move`/`up` on the one pointer and break both gestures.
- **Login.** One password per share, compared as a SHA-256 digest; a correct one issues an opaque `stim_share` cookie
  whose digest goes into `share.sessions` (a `Set`, at most 32). `--no-password` issues no cookie at all. Wrong
  passwords count against one per-share window (10 per 10 minutes).
- **Input path.** Desktop, the phone and local shares call `ControlHub.input`, which already calls
  `options.onInput(device)`. A hosted device's input goes from the client's server (`HostedShareSource.input`,
  `HostedRelay.control`) to the worker as `device-host.input.*`, where the worker's own `ControlHub.input` runs it. So
  `ControlHub.input` on the machine that runs the device sees every human input.
- **Agent input.** agent-device drives the simulator through its XCTest runner and the emulator through adb. Nothing
  passes stim-server. Stim learns about actions only from agent-device's session files
  (`<stateDir>/sessions/*/events.ndjson`): `action.recorded` events carry `details.x`/`y` for `press` and `click`,
  and `x1,y1,x2,y2` plus `durationMs` for `scroll` and `swipe`, in device points (201 is mid-screen on a 402-point
  iPhone). They are written after the action completes. The CLI follows them with a recursive watch and a 500 ms
  debounce (`agent-actions-follow.ts`), and stim-server batches log records for 100 ms, so an action reaches a
  subscriber 0.6 to 1 s after it finished. There are no phases and no intermediate drag points.
- **Desktop.** `AgentFeed` subscribes to the `agent` log source and `AgentActionsPanel` lists the actions; the agent
  "glow" is the tutorial highlight of that panel, not an overlay on the screen. Timeline markers
  (`ReplayMarker`) carry `at`, `kind`, `command` and `label`, and no coordinates.

## 2. Control model

Recommendation: keep one control session per share and add a per-device pointer grab.

- All control viewers of a share keep acting through the share's single session. The share hub passes each input's
  participant to the source (`source.input(owner, session, method, params, command, participant)`), and from there
  to `ControlHub.input`.
- **Pointer grab.** `ControlHub` tracks the participant holding the pointer per device. A participant is one viewer
  socket, so two tabs on one cookie are two participants. A `down` takes the grab; the matching `up` releases it. A
  socket close, the control session ending, or 10 s with no input (long enough for a long-press) releases it by
  sending an `up` at its last point; the former holder's later `move` and `up` are dropped. While a grab is held,
  touches from other participants are dropped; the share tells that viewer `{type: 'busy', name}` and the viewer page
  draws its own attempt as a faded dot. Text, buttons and rotation are not grabbed; they serialize as today.
- **Take-over mid-share.** Unchanged. When Desktop, the phone or another client takes the device over, the share's
  session ends with `taken-over`, viewers see "Control ended", and their next input retries `begin`, which is refused
  with `device-busy` while the other client drives. Frames and presence keep flowing, so share viewers watch the
  Host's touches. An agent detected through status refuses the share's `begin` the same way.

Superseded 2026-11-04 (#5172): the maintainer decided "Can we remove this device busy and embrace multiplayer
instead". `ControlHub` now lets any number of sessions control one device: they share its lease, its `stim-frames`
input and one pointer grab per device, held by a share viewer or by a session's own controller (shown as `Host`).
`begin` no longer refuses for another client or a driver in status, nothing is taken over, and the `shared-control`
hello feature tells clients. Take-over mid-share and the agent arbitration in 6.3 no longer apply.

Rejected: per-viewer sessions, because `ControlHub` allows one session per device and they would take each other over;
explicit turn-taking, because the pointer grab already gives a turn per gesture and five viewers do not need a queue.

## 3. Identity and access

### 3.1 Participants

A participant is one source of input on one device:

| Kind     | Who                                       | Name shown to share viewers                       | Name shown to Desktop and phone |
| -------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------- |
| `viewer` | a web share socket                        | its chosen name or `Guest N`                      | the same, after "Web share:"    |
| `host`   | a Desktop or phone control session        | `Host`                                            | the paired device name          |
| `agent`  | agent-device, from records or the wrapper | `Agent` plus the command, such as `Agent · press` | the same                        |

Ids are opaque per device (`v3`, `c12`, `a1`) and never reveal cookies, session ids or paired device ids.

### 3.2 Names and colors

- The login form gets an optional "Your name" field. A passwordless share asks on the viewer page instead and sends
  `{type: 'name', name}` over the socket. Without a name the server assigns `Guest N`, N the lowest number no session of the share uses.
- Server-side cleanup: NFC, strip control and format characters (bidi overrides included), collapse whitespace, trim,
  then 1 to 24 code points; anything else falls back to `Guest N`. One rename per 5 s per session. Clients render
  names with `textContent` only.
- Names live in the share's in-memory session table and die with the share. They are never logged, audited or written
  to disk.
- Colors are palette indexes 0 to 7, not hex, so each client maps them to its theme. A viewer gets the lowest index no
  current participant uses; index 0 is reserved for `host` and 1 for `agent`.

### 3.3 View and control passwords

- `share.sessions` becomes a `Map` from cookie digest to `{access: 'view' | 'control', name, color}`. Each socket of
  a session is its own participant (section 2), so two tabs on one cookie share a name and color but hold the pointer
  separately.
  The cookie stays an opaque random token; the access level never travels in it. The URL token stays the outer
  secret: no password works without it.
- Login compares the given password with both digests, always both, with `timingSafeEqual`, and grants the access of
  the one that matches. The two passwords must differ. Wrong passwords keep counting against the one per-share
  window: a guess is not aimed at a particular password.
- A passwordless share now sets a cookie on its first page load, with no login, so a viewer keeps its name and color
  across reconnects. Today's table keeps 32 sessions and evicts the oldest, so anyone with the link could evict real
  viewers by reloading. Passwordless sessions therefore evict only sessions with no open socket (at most 5 have one,
  `maxViewers`); password sessions keep today's rule.
- **Upgrade.** A view-only viewer of a control share sees "Have the control password?" in the bar. Entering it posts
  the same login with the existing cookie; on a match the server raises that session to `control`, keeping its name
  and color, and the page reloads. Sessions are never downgraded.
- **Enforcement.** The server drops every input from a `view` session, whatever the page sends. The viewer page for a
  `view` session removes the device controls (fullscreen stays), attaches no pointer or key handlers, and shows a
  "View only" pill.

### 3.4 CLI surface (decision)

Options:

- **A. One new flag, `--view-password [value]`** (recommended). Only with `--control`; generated when the value is
  left out. `--password` keeps meaning the control password, or the only password of a watch-only share.
- **B. `--control` always makes two passwords.** No new flag, but it changes today's output and gives a second
  secret to people sharing with one person.
- **C. `--view-password <v>` and `--control-password <v>`, replacing `--password`.** Clearest names, but renames a
  flag.

Rules for A: `--view-password` without `--control` refuses with `STIM_BAD_ARG` (a watch-only share already has one
password). `--view-password` with `--no-password` refuses in the first version; "anyone can watch, control needs a
password" is open question 2. Equal passwords refuse.

Printed:

```text
Shared ios of /path/app: view and control, 0 viewers, expires 2026-11-02T22:00:00.000Z.
URL:              https://host.ts.net/s/<token>/
Control password: hk7m...
View password:    p2xq...
Anyone with the link and a password can open it from the internet until it expires. Passwords are shown only now.
Stop it with: stim share stop
```

`--json` and the protocol: `share.start` takes `view?: { password?: string }` (present means a separate view
password, generated unless given). `ShareRow` keeps `auth` for the control or only password and adds
`viewAuth: 'generated' | 'set' | null`. `StartedShare` adds `viewPassword` only when it was generated. A hello feature
`share-view-password` gates the parameter, so Desktop offers it only to servers that accept it.

Desktop: the share sheet gets a "Separate view-only password" toggle, generated or custom, under "Viewers can
control"; the result shows both passwords once. The share list reads "View and control, view password".

## 4. Presence protocol

### 4.1 Server hook

`ControlHub.input` becomes the single publish point: it already runs for every human input on the machine that runs
the device. `onInput(device)` widens to `onInput(device, command, participant)`, and a `PresenceHub` keyed by device
publishes touch commands (only `touch` and `scroll`; text is never published). Desktop and phone controllers become
`host` participants from their connection; a share passes its viewer's participant. Agent sources publish into the
same hub (section 6).

Delivery rides the existing frame subscriptions: `FramePool` listeners gain `presence`, next to `frame`, `delayed`
and `artwork`. That one listener feeds share sockets (`source.subscribe`), Desktop and the phone (`frames.subscribe`),
and the hosted relay, which already forwards worker subscription events verbatim (`hosted-relay.ts`).

### 4.2 Event

`frames.subscribe` takes `presence?: true`; only a subscription that asked receives:

```ts
interface PresenceEvent {
  event: 'presence';
  subscription: string;
  /** Participants that changed since the last event, oldest change first. */
  participants: PresenceParticipant[];
}

interface PresenceParticipant {
  id: string;
  kind: 'viewer' | 'host' | 'agent';
  name: string;
  color: number; // 0-7
  /** Absent when only the name, color or presence changed; null when the participant left. */
  touch?: {
    phase: 'down' | 'move' | 'up';
    x: number; // 0-1 of the upright screen, as InputTouchParams
    y: number;
    display?: number; // 0 is the main display; the Duo panel otherwise
    at: number; // epoch ms on the device's machine
  } | null;
  /** A completed agent gesture, replayed by the client over durationMs. */
  gesture?: {
    kind: 'tap' | 'swipe';
    from: { x: number; y: number };
    to?: { x: number; y: number };
    durationMs: number;
  };
  /** Set when a touch was dropped because another participant held the pointer. */
  refused?: true;
}
```

The first event after subscribing lists every present participant. The web share socket carries the same objects as
`{type: 'presence', participants}`, plus `{type: 'you', id, name, color, access}` once after connecting.

### 4.3 Rate and coalescing

- Presence runs on its own tick, not the frame rate: shares send 10 fps (`VIEW_HINT`) and drags would stutter.
- Per participant, the hub keeps the latest `move` and flushes every 33 ms (30 Hz). `down` and `up` flush at once, in
  order, so a tap is never coalesced away.
- A subscriber whose socket is backed up gets the latest state only, as frames do (`LatestFrames`). A viewer is not
  sent its own entries; its page draws them locally without the round trip.
- Size is bounded by participants: at most 5 viewers (`maxViewers`), the Host and the agent.

### 4.4 Hosted devices

A hosted device's agent runs on the host Mac, so the host publishes what the agent does. The client asks for it with
`device-host.presence.subscribe {session}` (feature `hosted-presence`, a dedicated subscription so that one request
serves every consumer and the host captures no frames for it). The host follows the session's agent-device records
from the subscription on and sends `presence` events with the `agent` participant and its gesture, measured in the
viewport of the latest snapshot the session's agent route answered. Only the session's own client may subscribe. The
client keeps just the validated agent participant and puts it into its own `PresenceHub` under the hosted workspace
device's key, so shares, relayed Desktop and phone subscribers and the wrapper's own events meet in one place.

Everything about people stays on the client: all viewers of a share connect to the client's share server, so viewer
participants, their touches and the pointer grab live in its hub (`HostedShareSource` applies the same `PointerGrab`
as `ControlHub` before it forwards `device-host.input.*`), and the touches of the client's own Desktop or phone on the
hosted device show as `Host`. The host publishes no human touches; a person on the host cannot touch a hosted device.
A host without the feature yields no agent presence from the host.

## 5. Web overlay

- A canvas over the screen image, same box as the image, so normalized points map directly. It follows rotation and
  the Duo display the touch names.
- Touch dot: 28 px circle in the participant color, 2 px white ring, at 85% opacity while down; on `up` it shrinks and
  fades over 300 ms. A tap with no move shows a ripple.
- Drag trail: a polyline of the last 600 ms of points in the participant color, fading by age, drawn with
  interpolation between 30 Hz points.
- Label: a pill with the name, offset up-right of the dot, ellipsized at 16 characters, shown while the touch lasts
  and 1 s after.
- Roster: a compact row in the bar of colored initials with names on hover, "you" marked; view-only viewers marked
  with an eye.
- Agent gestures replay over their `durationMs` with an `Agent · press` label.
- `prefers-reduced-motion`: no trails or ripples, dots only.
- The overlay code stays independent of the frame decoder, so the H.264 work in progress does not conflict with it.

## 6. Agent input

### 6.1 Direct agent-device calls (post-hoc)

While a device has presence subscribers, stim-server follows that workspace's agent records with the same in-process
`followLogs` call it runs for `logs.subscribe` (the CLI's `agent-actions-follow.ts` watcher, not the supervisor), and
publishes each `action.recorded` with coordinates as an `agent` participant `gesture`. `press`
and `click` become taps; `scroll` and `swipe` become swipes over `durationMs`. `@ref` targets have coordinates in the
record because the daemon resolved them.

Points must be normalized by the box agent-device measures in. A JSON snapshot reports it as `viewport`, in the same
space and orientation as its rects (callstack/agent-device#3182; that tap points share it is to verify); without one, use the device's logical size: on
iOS the integrated display's pixel size in the device type's `capabilities.plist` divided by its scale (1206 x 2622 at
3 is 402 x 874 for an iPhone 18 Pro, and `scroll` records `x1 = 201`), on Android the `wm size` in pixels (recorded
scrolls on 1080 x 2400 emulators run from `x = 540`, `y = 2160` to `240`, and press points on a foldable exceed any dp
width). The same
normalized start point (`x`/`y`, from `x1`/`y1` for scrolls and swipes) and end point (`x2`/`y2`) go onto `ReplayMarker` as optional fields, added in phase 1 for the wrapper's markers, so Desktop's replay can show where each
action landed.

stim-server follows the records of a workspace's owned simulator or emulator while a consumer follows its presence,
and pairs each recorded action with the wrapper's own publish of it, so a gesture draws once. A leased phone is shown
only by the wrapper. Rotation and folding are not accounted for: the fallback is the device's natural portrait size.

The honest gap: these show 0.6 to 1 s after an action completes, with no live phases.

### 6.2 `stim agent-device`: the wrapper command (decided)

Agents run `stim agent-device <agent-device args...>` instead of `agent-device`. The name says what runs and cannot
collide with `stim device lock|unlock|provision|location|permission|push|network`, whose `push` is also an
agent-device command. The maintainer decided the command and its name on 2026-11-03.

- **Selection.** Stim resolves this workspace's device and injects what agent-device needs: `--platform`, `--udid` or
  `--serial` of the owned simulator or emulator or the leased physical device, `AGENT_DEVICE_STATE_DIR` for the
  workspace, `--remote-config` for a hosted session, and a default `--session` per workspace and slot when the agent
  passes none. `--slot` picks a slot. Local, hosted and remote devices look the same to the agent: no device ids, no
  `connect` step.
- **Before the command.** Stim revives an idle-stopped workspace (the `stim revive` path: Metro, the owned device
  through admission, the app relaunched), with progress on stderr; the agent waits a few seconds, as it would for
  `stim revive`. It refuses with `STIM_BAD_ARG` when the agent names a device, udid or serial that is not this
  workspace's, and refuses `boot`, so agent-device never boots a device outside admission.
- **After the command.** Stim reads the session's new `action.recorded` events (written by the daemon before it
  answers; to verify) and publishes them to stim-server over its Unix socket as presence, a timeline marker and an
  activity signal. Presence shows `Agent · press` when the command starts and the point when it exits, with no
  file-follow delay.
- **Transparency.** stdin, stdout and stderr pass through, the exit code is agent-device's, and signals are forwarded.
  Stim writes nothing to stdout, so `--json` output stays parseable; its own lines go to stderr. Interactive and
  long-running commands (`record`, `logs`, `takeover`) keep working because the streams are inherited. Only a
  `snapshot --json` has its stdout teed through Stim, byte for byte, to read rects (6.5); a TTY never sees a pipe.
- **Version.** Stim resolves agent-device as the hosted driver does (`resolveAgentDevice`, the shared
  `~/.local/bin/agent-device`), checks the minimum version hosted control already requires (0.21.30), and otherwise
  passes arguments through without pinning. A missing or older agent-device refuses with the install command.
- **Cost.** A warm `stim --version` takes 80 ms (five runs on this MacBook; 0.16 to 0.72 s cold), and agent-device's
  own CLI start takes 0.15 to 0.4 s, which agents already pay. About 80 ms on top of a press that takes 0.5 to 1.5 s
  does not matter for agents issuing many taps, provided the wrapper reads workspace state without a full status
  payload.
- **Enforcement.** Agents can still call agent-device directly. `stim guide agent` routes all interaction through the
  wrapper and keeps the `AGENT_DEVICE_STATE_DIR` form only as a fallback; the static skill does not change
  (AGENTS.md invariant 1). Direct calls still get 6.1 presence, and the boot hook once callstack/agent-device#4153 ships. A soft rule is enough for presence,
  because 6.1 covers whoever bypasses it; the route in 6.3 is a backstop only if outlines must be reliable for every
  agent.
- **No listener.** Nothing listens, so revive needs no long-lived process, the daemon's exit rule is unchanged, and
  the change adds no network surface.

### 6.3 Not built: an HTTP route, a possible later backstop

Reuse the hosted shape. On a worker, stim-server already runs agent-device's daemon in HTTP mode under a policy
(`AgentDeviceDriver` with a `device`, `packages/agent-driver-agent-device/driver.ts`), pins every JSON-RPC request to
the session's lease (`pinLease`, `device-policy.ts`), and hands clients a `remoteConfig` for
`agent-device <command> --remote-config <file>`. agent-device supports this today (0.21.30 or later, already required
for hosted control), so the proxy needs no agent-device change.

For local devices, use the same shape as a hosted session on a `local:` machine, where the client's supervisor
listens on a loopback port and carries each connection over an authenticated `device-host.agent.link`
(`packages/stim-cli/src/supervisor/agent-relay.ts`):

- **Route.** A per-workspace loopback relay port carries each connection over stim-server's Unix socket on a new
  local-only `agent.link` method. stim-server applies the device policy and forwards to the agent-device daemon it
  runs for that workspace, in that workspace's agent-device state directory. `agent.link` is refused on every network
  connection. The relay is not a stim-server listener, so the Noise rule for stim-server connections is untouched;
  it is a bearer-token loopback port, the same trust model as the hosted agent relay today. Every request must carry
  the route token, which lives only in the 0600 config file and is never put in arguments, environment or logs;
  another local user who cannot read the file cannot use the port.
- **Who listens.** The relay must outlive an idle stop, or revive on first action cannot work. The supervisor stops
  with Metro, and the stim-daemon exits once nothing runs. Recommended: the stim-daemon hosts the relays and stays up
  while any workspace has an open agent route, a change to its exit rule (today it exits once nothing runs); `stim
stop` and `worktree remove` close the route. With `daemon.mode off` (the CI default) and on
  Windows there is no daemon: Stim reports no `remoteConfig`, and agents keep the state-dir path with its boot hook.
- **Interface.** `stim ios|android --json` and `status --json` report `agentDevice.remoteConfig` (a file path) next to
  `agentDevice.stateDir`. The guide tells agents to use `--remote-config` exactly as for hosted devices. No new
  command or flag. The config holds a per-workspace token; the file is mode 0600 in the workspace's agent-device
  directory.
- **Ownership.** The route's policy pins the lease to this workspace's owned simulator or emulator, or the physical
  device the workspace leases, and refuses device selection flags and host paths as the hosted policy does. It never
  reaches another workspace's device.
- **What Stim sees.** Each request's command and positionals before it runs, and its JSON-RPC result after. In
  agent-device 0.21.35, `action.recorded` details for `press`, `click`, `longpress`, `fill`, `hover` and `focus` are
  built from the command result's `x`, `y` and `durationMs`, and `scroll` and `swipe` record `x1,y1,x2,y2`, so the
  result carries the resolved point even for `@ref` and selector targets; no snapshot lookup and
  no upstream change is needed for them. Presence shows `Agent · press` at request start and the point when the
  result arrives, with no file-follow delay. Per command:

  | Command                                                        | Before it runs (request)        | After it runs (result)                  | Drawn as                        |
  | -------------------------------------------------------------- | ------------------------------- | --------------------------------------- | ------------------------------- |
  | `press`, `click`, `fill`, `longpress` with `x y`               | the point                       | the point, `durationMs` for `longpress` | tap or hold                     |
  | the same with `@ref` or a selector                             | the ref only                    | the resolved point                      | tap or hold at completion       |
  | `scroll`, `swipe`                                              | direction and amount, or points | `x1,y1,x2,y2`, `durationMs`             | trail from start to end         |
  | `gesture pan`, `fling`, `transform`                            | `x y dx dy`                     | kind, `durationMs`, pointer count       | trail from the request's points |
  | `gesture drag` with refs, `pinch`, `rotate`, multi-point `tap` | refs or a scale                 | kind and `durationMs` only              | label without a point           |

  Trails are straight lines animated over `durationMs`: agent-device synthesizes the finger path inside the runner
  and reports only its ends, so there are no intermediate points. The last row needs agent-device to return the
  resolved points; no callstack/agent-device issue or pull request asks for that yet, and the route's implementation would file one if it is
  wanted.

- **Revive on first action.** A request for an idle-stopped workspace runs the `stim revive` path first (Metro, the
  owned device through admission, the app relaunched), then forwards the request. Revive takes seconds: Metro 2 to
  5 s, a cold simulator boot 10 to 30 s. The proxy holds the request open, single-flight, so concurrent requests wait
  for the same revive; held requests count against the relay's 8-connection cap (`agent-relay.ts`). The HTTP
  request stays open with no response bytes until revive finishes, then the proxy
  forwards it and streams the daemon's answer. It holds up to a bound below agent-device's client request timeout
  (not documented in 0.21.35; measure it before building the route), and past that bound or
  on a revive refusal answers a JSON-RPC error carrying revive's code and remedy (`STIM_NO_METRO`,
  `STIM_DEVICE_LOST`).
- **Activity and admission.** Every proxied request records workspace activity, a direct form of the "agent-device
  actions" signal in the resource model (#4808). The daemon behind the route never boots a device itself, because the
  proxy revives first and its policy pins the lease, so `concurrency.maxDevices` cannot be bypassed.
- **Boot hook.** The `boot-hook.json` path from #4791 depends on callstack/agent-device#4153, which is still open.
  Agents on the proxy do not need it. Agents that use only `AGENT_DEVICE_STATE_DIR` still would.
- **Reuse.** The daemon side is the hosted code as it is: `AgentDeviceDriver` with a device policy, `pinLease` and
  `device-policy.ts`. The relay is `agent-relay.ts` with its transport swapped from a `device-host.agent.link` over a
  remote machine connection to `agent.link` over the local Unix socket. The remote-config shape is the one
  `stim macos --remote` already hands out. What changes is the lease source: the workspace's owned or leased device
  instead of a hosted session's claim. agent-device's own `agent-device proxy --port` mode would also serve a
  remote-config, but Stim would not see the requests, so it is not used.
- **Failure.** Fail closed: when the relay or stim-server is down, agent-device reports the connection failure, and
  the guide's remedy restarts it. There is no silent bypass inside the config path. An agent
  that ignores the config bypasses Stim as today and gets only 6.1 presence.
- **Arbitration.** Unchanged in the first version: agent activity counts as a driver in status, so share and Desktop
  `begin` refuse with `device-busy` unless they take over. Holding agent requests while a human holds the pointer
  grab is open question 4.
- **Cost.** One loopback HTTP hop per request, well under a millisecond, and one agent-device daemon per active
  workspace, as today.

### 6.4 Wrapper or route

|                        | `stim agent-device` (6.2)                       | HTTP route (6.3)                                                           |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Agent interface        | one command, no ids or config                   | `--remote-config <file>` on every call                                     |
| Revive on first action | before spawning, no listener                    | held request, needs a relay that outlives idle stop                        |
| Points                 | from action records after exit                  | from each RPC result                                                       |
| Element rects          | only from snapshots the agent asked as `--json` | from every snapshot RPC, whatever the CLI prints                           |
| Bypass                 | direct `agent-device` calls                     | agents that skip the config                                                |
| New surface            | a command                                       | a loopback listener, `agent.link`, daemon exit rule; `review: needs-human` |
| Hosted, remote         | same command                                    | already the hosted path                                                    |

Decided: the wrapper. The route stays a possible later backstop if agents bypass the wrapper; it could then sit under
the wrapper, which would pass `--remote-config` itself, without changing what agents type.

### 6.5 Element highlight

An action on a ref or selector shows the element: an outline of its rect in the agent's color, a ripple at the point
pressed, and the label.

- **What agent-device returns.** `press`, `click` and `fill` results carry the dispatched point (`x`, `y`), not a
  rect; the record builder copies only those fields. A `target_still_moving` refusal means nothing was dispatched,
  so nothing is drawn. `settle` and verification commands report screen state, not a target. No
  callstack/agent-device issue or pull request asks for the target rect in action results (searched 2026-11-03;
  only the occlusion refusal carries a `targetRect`).
- **Rects.** A `snapshot --json` result lists nodes with `ref` and `rect {x, y, width, height}` and a `viewport` in
  the same space; iOS and Android share this node shape. Stim keeps the latest tree per agent-device session. Android
  Appium snapshots publish `viewport` only when the measurements before and after the tree agree; without it Stim
  falls back to the logical size (6.1). A repeated unchanged Android snapshot prints a compact acknowledgement in
  text mode; `--json` keeps the full tree.
- **Resolving.** For `@eN`, take that ref's rect from the cached tree, and draw it only if it contains the point the
  result reports. Otherwise the ref is stale (the screen changed since the snapshot): draw the point only. Selectors
  are not re-matched; Stim hit-tests the reported point against the cached tree and outlines the smallest node that
  contains it, again only when one does.
- **Scaling.** Rects and points are divided by `viewport` to get fractions of the screen in its current orientation,
  then mapped to the upright frame with the device's rotation, which the frame stream already knows. The overlay
  draws in the screen box, never over the device frame artwork, like human touches.
- **Fading.** The outline holds 600 ms after the command exits and fades over 300 ms.
- **Verified on an iOS simulator** (agent-device 0.21.35, iPhone 18 Pro on iOS 27.0, 2026-11-03):
  - (a) `snapshot -i --json` prints `{success, data}`; `data.nodes[]` carry `ref` (`e1`, no `@`) and
    `rect {x, y, width, height}`, every node of the interactive tree has both, and `data.viewport` is
    `{width: 402, height: 874}`, the same point space as the rects and as the press point (a tap at mid-screen
    reports `x: 201`).
  - (b) `get attrs @ref --json` returns `data.node.rect`. For a ref it reads the session's last snapshot: about
    0.11 to 0.13 s, and after the screen changed it still answers from that snapshot with a staleness `warning`. A
    selector (`get attrs 'label="Menu"' --json`) matches the current screen in 0.1 to 0.5 s under this machine's
    load. It is no fresher than the wrapper's cached snapshot for refs, so the wrapper does not call it.
  - (c) `press @ref --json` returns `x`, `y`, `referenceWidth`, `referenceHeight` (the viewport), `ref`,
    `refLabel` and `selectorChain`, and no frame or rect of the target. The `action.recorded` details carry `x`,
    `y`, `ref` and `positionals`, and agent-device writes them before the command exits (risk 11 does not occur).
  - (d) not checked; it matters only to the HTTP route.
  - Android: not checked. No Android build of a test app was cached and the machine's load ruled out a Gradle
    build; until it is checked, Android points assume the same `viewport` space as iOS.
- **Cheapest reliable source.** Wrapper: the agent's own `snapshot --json`, cached, with the result point as the
  stale check; if (b) proves to carry the rect and costs little, a `get attrs` before each ref or selector action
  removes the dependence on the agent's snapshot format. HTTP route: the snapshot RPC result, if (d) shows it carries
  the tree whatever the CLI prints. Until (b) or (d) is checked, highlighting is equal on both paths only for agents
  that take `--json` snapshots; with text snapshots both show the point only, unless (d) holds for the route.

## 7. Desktop and phone

- Both subscribe with `presence: true` when the server lists the `presence` feature and draw the same overlay from
  the same event. Desktop already composites over the device image; the phone app is read-only and only renders.
- Desktop, as `host`, sees share viewer names with "Web share:" and the agent's command; its own touches are drawn
  locally.
- Desktop's share list and sheet change as in 3.4.

## 8. Features and build compatibility

- New hello features: `presence` (the `frames.subscribe` flag, the event, `participant` on
  `device-host.input.touch`) and `share-view-password` (the `share.start` parameter and the row fields).
- No `STIM_BUILD_COMPAT` bump: none of the touched files is in `scripts/build-compat.json`, and AGENTS.md exempts
  fields a hello feature negotiates.
- The wrapper adds a command, so AGENTS.md's command surface, `stim guide agent`, the guide contract tests and the
  website change with it. The HTTP route, if built, adds `agentDevice.remoteConfig` to the CLI's JSON contract.
- Phase 2 changes a share's authentication (a second password, cookies on passwordless shares) and gets
  `review: needs-human`; so would the HTTP route, a new loopback listener. Phase 2 also updates the "Web shares" rule in AGENTS.md, which
  describes one password. The HTTP route would add an AGENTS.md rule for the local agent relay, the local-only
  `agent.link` method and the daemon's new exit rule.

## 9. Privacy and safety

- Names reach only viewers of the same share and the owner's clients, live, and are never stored.
- Public viewers never see paired device names: Desktop and phone show as `Host`.
- Presence shows where people tap, a PIN pad included. The screen is already shared, so this adds little, but the
  share guide says so.
- On a passwordless share anyone with the link picks any name, so impersonation is easy. Recommended: passwordless
  shares use `Guest N` only (open question 3).
- Limits: 5 viewers per share, one rename per 5 s, the existing input bucket (120 per second) applies to touches, and
  presence is bounded by participants, not by input rate.

## 10. Phases

1. **`stim agent-device`** (CLI, server, guide, website; decided, ships first). 6.2 and 6.5: verify the rect sources
   on an iOS simulator and an Android emulator first; then the wrapper with device, session and state-dir injection,
   revive before the command, admission, refusal of foreign devices and `boot`, the activity signal, timeline markers
   with coordinates, and presence. It brings the minimal `PresenceHub`, the `presence` event and the `presence`
   hello feature (4.1, 4.2) that the later phases build on, so agent actions show wherever presence is drawn; until
   an overlay ships, the event is protocol only. AGENTS.md command surface, `stim guide agent` and the website change
   with it.
2. **Share presence and view/control passwords** (server, web viewer, CLI, Desktop share sheet and list). Pointer
   grab, participants and names, `ControlHub.input` publishing to the hub, the share socket messages, the overlay,
   view and control passwords with upgrade. Local devices; hosted shares follow in phase 4. Waits
   on open questions 1 to 3.
3. **Agent presence from direct calls** (server, core). 6.1: follow agent records per subscribed device for agents
   that bypass the wrapper, normalize, publish `gesture`.
4. **Desktop, phone and hosted presence** (desktop, mobile, server). `frames.subscribe` presence for Desktop and the
   phone, the overlay in both, worker-published presence across the device-host link.

## 11. Risks

- The pointer grab drops a second viewer's touch; without the busy hint it reads as lag.
- Unit mismatch for agent coordinates (points, pixels, dp) puts agent dots in the wrong place; verify per platform
  before shipping phases 1 and 3.
- The share viewer is being changed in parallel (H.264, keys, rotation). Phase 2 lands after those, and keeps the
  overlay in its own file.
- Agents that keep calling agent-device directly get only post-hoc points and no outlines.
- If the daemon writes `action.recorded` after it answers, the wrapper must wait briefly for the record; verify
  before phase 1.
- Element outlines depend on agents using `snapshot --json`; text snapshots give points only.

## 12. Open questions

1. CLI for two passwords: option A (`--view-password [value]`, recommended), B or C?
2. Should `--no-password --view-password` mean "anyone with the link can watch, control needs a password"? Recommended
   no for the first version.
3. Passwordless shares: force `Guest N` names (recommended), or allow chosen names?
4. Should Stim hold agent commands while a human holds the pointer grab, or keep today's arbitration (agent counts as
   a driver)?
5. Once the wrapper ships, should Stim stop pursuing callstack/agent-device#4153, keeping `boot-hook.json` only for
   direct agent-device calls?
