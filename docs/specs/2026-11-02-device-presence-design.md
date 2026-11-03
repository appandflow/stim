# Device presence: who is touching the device, and where

Status: proposed design, 2026-11-02 (#4871). Section 12 lists the decisions for the maintainer; the rest is
ready to implement once those are answered.

## Goals

- Everyone watching a device sees who is interacting and where: a colored touch dot, a drag trail and a short name
  label per participant, live.
- A web share (`stim share`) can have a view password and a control password. View-only viewers watch and see
  everyone's touches; control viewers can also tap.
- Automation input from agent-device shows on the same overlay, labeled as the agent and its command.
- agent-device can drive a workspace's device through a Stim route, so Stim sees every action, revives an idle
  workspace before the first one, and counts each as activity.
- One protocol for the web viewer, Desktop's viewer and the phone app. The web viewer stays a subset of Desktop's.

## Non-goals

- Multi-touch. The `stim-frames` helper and the adb path drive one pointer (`InputTouchParams` has no pointer id).
- Cursors for hovering viewers. Only touches are shown.
- Presence for physical iPhones (view only) and macOS windows. macOS can follow later with the same event.
- A generic automation endpoint for Maestro or Appium-style clients. The proxy speaks agent-device's protocol only.
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

Rejected: per-viewer sessions, because `ControlHub` allows one session per device and they would take each other over;
explicit turn-taking, because the pointer grab already gives a turn per gesture and five viewers do not need a queue.

## 3. Identity and access

### 3.1 Participants

A participant is one source of input on one device:

| Kind     | Who                                     | Name shown to share viewers                       | Name shown to Desktop and phone |
| -------- | --------------------------------------- | ------------------------------------------------- | ------------------------------- |
| `viewer` | a web share socket                      | its chosen name or `Guest N`                      | the same, after "Web share:"    |
| `host`   | a Desktop or phone control session      | `Host`                                            | the paired device name          |
| `agent`  | agent-device, from records or the proxy | `Agent` plus the command, such as `Agent · press` | the same                        |

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

The worker's `ControlHub` is the authority, so the worker publishes. `device-host.input.touch` takes an optional
`participant: {id, kind, name}` from clients that see the worker's `presence` feature. The worker prefixes the id with
the client's key and the host control session so clients cannot impersonate each other's participants, applies the same name cleanup, and assigns
colors itself. Presence events reach the client on its existing `device-host.frames.subscribe` subscription; the
client server passes them to its share sockets and relayed subscribers. Worker-side inputs (a person on the worker's
Desktop, the worker's hosted agent) appear too. A worker without the feature yields no presence; viewers still see
their own touches.

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

### 6.1 Without a proxy (cheap, post-hoc)

While a device has presence subscribers, stim-server follows that workspace's agent records with the same in-process
`followLogs` call it runs for `logs.subscribe` (the CLI's `agent-actions-follow.ts` watcher, not the supervisor), and
publishes each `action.recorded` with coordinates as an `agent` participant `gesture`. `press`
and `click` become taps; `scroll` and `swipe` become swipes over `durationMs`. `@ref` targets have coordinates in the
record because the daemon resolved them.

Points must be normalized by the device's logical size: on iOS the frame's pixel size divided by the device type's
screen scale, on Android the display size in the unit agent-device records (to verify: pixels or dp). The same
normalized start point (`x`/`y`, from `x1`/`y1` for scrolls and swipes) and end point (`x2`/`y2`) go onto `ReplayMarker` as optional fields, so Desktop's replay can show where each
action landed.

The honest gap: these show 0.6 to 1 s after an action completes, with no live phases, and only for agents that use
the workspace's agent-device state directory.

### 6.2 The agent-device proxy

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
stop` and `worktree remove` close the route (open question 5). With `daemon.mode off` (the CI default) and on
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
  resolved points; no callstack/agent-device issue or pull request asks for that yet, and phase 3 files one if it is
  wanted.

- **Revive on first action.** A request for an idle-stopped workspace runs the `stim revive` path first (Metro, the
  owned device through admission, the app relaunched), then forwards the request. Revive takes seconds: Metro 2 to
  5 s, a cold simulator boot 10 to 30 s. The proxy holds the request open, single-flight, so concurrent requests wait
  for the same revive; held requests count against the relay's 8-connection cap (`agent-relay.ts`). The HTTP
  request stays open with no response bytes until revive finishes, then the proxy
  forwards it and streams the daemon's answer. It holds up to a bound below agent-device's client request timeout
  (not documented in 0.21.35; measure it before phase 3), and past that bound or
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
  grab is open question 7.
- **Cost.** One loopback HTTP hop per request, well under a millisecond, and one agent-device daemon per active
  workspace, as today.

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
- The proxy changes the CLI's JSON contract (`agentDevice.remoteConfig`) and the guide; guide contract tests and
  website pages follow.
- Phase 1 changes a share's authentication (a second password, cookies on passwordless shares) and phase 3 adds a
  loopback listener; both get `review: needs-human`. Phase 1 also updates the "Web shares" rule in AGENTS.md, which
  describes one password. Phase 3 adds an AGENTS.md rule for the local agent relay and the local-only `agent.link`
  method, and the daemon's new exit rule.

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

1. **Share presence and view/control passwords** (server, web viewer, CLI, Desktop share sheet and list). Pointer
   grab, participants and names, `PresenceHub` at `ControlHub.input`, the share socket messages, the overlay, view and
   control passwords with upgrade. Local devices only; hosted shares show only a viewer's own touches.
2. **Agent presence from recorded actions** (server, core). 6.1: follow agent records per subscribed device,
   normalize, publish `gesture`, add coordinates to `ReplayMarker`.
3. **agent-device proxy** (server, CLI, guide, website). 6.2: local agent route, `agentDevice.remoteConfig`,
   revive on first action, activity, live agent presence from requests.
4. **Desktop, phone and hosted presence** (desktop, mobile, server). `frames.subscribe` presence for Desktop and the
   phone, the overlay in both, worker-published presence across the device-host link.

## 11. Risks

- The pointer grab drops a second viewer's touch; without the busy hint it reads as lag.
- Unit mismatch for agent coordinates (points, pixels, dp) puts agent dots in the wrong place; verify per platform
  before shipping phase 2.
- The share viewer is being changed in parallel (H.264, keys, rotation). Phase 1 lands after those, and keeps the
  overlay in its own file.
- Revive inside a held request can exceed agent-device's timeout on a cold boot; agents then see a timeout instead of
  a remedy.
- Two agent paths (proxy and state dir) during the transition mean two kinds of agent presence.

## 12. Open questions

1. CLI for two passwords: option A (`--view-password [value]`, recommended), B or C?
2. Should `--no-password --view-password` mean "anyone with the link can watch, control needs a password"? Recommended
   no for the first version.
3. Passwordless shares: force `Guest N` names (recommended), or allow chosen names?
4. Build the agent-device proxy as phase 3? Recommended yes.
5. If yes: host the loopback relays in the stim-daemon, kept up while a workspace has an open agent route
   (recommended), or elsewhere?
6. If yes: run the agent-device daemon and its policy in stim-server, as hosted sessions do (recommended)?
7. Should the proxy hold agent requests while a human holds the pointer grab, or keep today's arbitration (agent
   counts as a driver)?
8. If the proxy ships, should the guide drop the `AGENT_DEVICE_STATE_DIR` path, and Stim stop pursuing
   callstack/agent-device#4153?
