# Desktop and phone pair with the stim-servers that own the work

Date: 2026-10-26. Status: proposed, design only. Issue: #4487.

## Summary

Stim Desktop today shows only its own Stim home. The phone app can pair with
several stim-servers. This design lets Desktop pair with other machines'
stim-servers the same way, read-only first and then with control.

The model is ownership. A workspace, its offloaded builds and its hosted
sessions belong to the stim-server of the machine that started them: the
client. Desktop and the phone pair only with those servers, such as the
MacBook and the bot VM. They never pair with a build worker or a device host
just to see work there. The client's server already reports what it started:
where each build runs and its phase, and each hosted session's host, device
and state. It already relays a hosted device's view and input over its
approved device-host connection. A paired Desktop or phone therefore sees, and
later controls, the bot's hosted simulator on janics-mac-mini-2 by talking only
to the bot's server.

- **Trust.** It is unchanged and not transitive. A host trusts only the
  clients a person on the host approved. A viewer trusts only the servers it
  paired with, by their pinned Noise keys.
- **Surface.** It adds no command, flag or capability. Desktop gains a Noise
  client, a Keychain store and a pairing flow. The remaining work is mostly
  Linux: the bot's server is not installed today.
- **Critical path.** Phase 0 runs stim-server on the Linux VM as a service that
  Desktop and the phone can reach. It needs one network decision from the
  maintainer (see [Open decisions](#open-decisions)).

## Maintainer decisions

Taken in chat on 2026-10-26 and treated as settled here:

1. Desktop pairs with other stim-servers, like the phone app. It is read-only
   first, then control.
2. Each server is the controller of what it started. The UI names that server
   for every workspace, device and hosted session.
3. When the bot VM runs a simulator on mini-2, the MacBook sees it, and remote
   builds show up the same way. It is seen through the bot's server, never by
   pairing with mini-2. A session shows once, under its owning server, with
   the host shown as where it runs.
4. Build machines and device hosts are never paired with for viewing. The
   host's "Hosted here" list stays a local admin view for the person at that
   machine.
5. The phone follows the same model. It pairs with each owning server itself.
   Nothing Desktop paired with appears on the phone.

## What exists

| Piece                     | Where                                                                                       | Today                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone pairing payload     | `packages/server/bin/stim-server.ts` `pair()`, `packages/core/phone-protocol.ts`            | `{ v: 2, name, endpoint, pairingToken, fingerprint }`. Single use, 5 minutes. `--control` stores `['read','control']` with the secret, otherwise `['read']`. The scope never travels in the payload.                                   |
| Authentication            | `packages/core/noise-session.ts`, `server.ts` `authenticate()`, `registry.ts` `spendSecret` | Protocol 2. First contact is `Noise_XXpsk2_25519_ChaChaPoly_SHA256` with the token as PSK, and later connections use `Noise_XX` against the pinned server key. A `devices.json` record holds the client's public key and capabilities. |
| Phone key and pins        | `apps/mobile/modules/stim-session/ios/ClientKey.mm`, `apps/mobile/src/lib/macs.ts`          | The X25519 private key is in the Keychain, `ThisDeviceOnly`. The pairing index (endpoint, name, `serverKey`, server id) is in SecureStore.                                                                                             |
| Control                   | `server.ts` `canControl`, `checkRevocations`                                                | `devices.json` is reread on every control call. Revocation closes sockets within about 1 s and ends control sessions that lost `control`.                                                                                              |
| Desktop's server client   | `apps/desktop/Sources/StimKit/ServerClient.swift`                                           | Mirrors the phone's `connection.ts` reconnect logic, with a pluggable `ServerTransport`. The only transport is plain WebSocket over the Unix socket. No Noise, no Keychain code.                                                       |
| Desktop-only methods      | `server.ts` `desktopMethod`                                                                 | `desktop.*`, `route.setup`, `machines.update.*` and `device-host.sessions*` answer only on the Unix socket. A Noise connection never reaches them.                                                                                     |
| Offloaded build in status | `packages/core/state/status.ts` `BuildPlacement`, build ledger `machine`                    | A running build reports `{ host, phase, startedAt, phaseStartedAt }`. The ledger records where it compiled and the outcome.                                                                                                            |
| Hosted session in status  | `packages/core/state/hosted-ios.ts`, `hosted-android.ts`, `hosted-macos.ts`                 | Per slot: `machine`, `session`, `device`, `agent`, and the latest session probe `state`.                                                                                                                                               |
| Hosted viewer relay       | `packages/server/src/hosted-relay.ts`, README "Hosted viewer relay"                         | The client's server relays hosted iOS, Android and macOS frames and input over one device-host connection per host, pinned to the host's key. Phones already use it.                                                                   |
| Linux service             | `packages/server/src/service-manager.ts` (systemd backend)                                  | A user unit, with `XDG_RUNTIME_DIR` defaulted to `/run/user/<uid>`. Linger is reported and its command printed; Stim never runs sudo.                                                                                                  |

The phone calls these methods. Desktop's local client already decodes the
ones marked yes:

| Method                                                                              | Phone | Desktop today                                                    |
| ----------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `hello`, `unsubscribe`                                                              | yes   | yes                                                              |
| `workspaces.subscribe`, `workspace.subscribe`, `machine.subscribe`, `archived.list` | yes   | yes                                                              |
| `logs.subscribe`, `logs.query`                                                      | yes   | yes                                                              |
| `frames.subscribe`, `frames.keyframe/seek/live`, `replay.range`, `archive.detail`   | yes   | yes                                                              |
| `workspace.files`, `workspace.diff`, `settings.get`, `control.begin`, `input.*`     | yes   | yes                                                              |
| `machine.get`, `machine.details`, `machine.history`                                 | yes   | no: Desktop reads its own machine from CLI and `desktop.reports` |
| `build.plan`                                                                        | yes   | no: Desktop uses `desktop.plan.get`                              |
| `notifications.list`, `push.*`, `recording.set`, `status.subscribe` fallback        | yes   | no                                                               |

So a remote view in Desktop reuses its existing decoders for workspaces,
devices, builds, logs and frames. Remote capacity and machine detail add
`machine.get`, `machine.details` and `machine.history`, which the phone's
payloads already define.

## Ownership: what the client's server reports

| Fact                                                  | Known from the client's own records            | Fetched from the host over the approved connection       |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| An offloaded build's worker, phase and start times    | yes: the offload stream feeds `BuildPlacement` | already streamed during the build; nothing new           |
| Its result, duration and cache outcome                | yes: build ledger                              | none                                                     |
| A hosted session's host, session id, device and agent | yes: workspace placement records               | none                                                     |
| The hosted session's live state                       | the latest probe in status                     | already probed by status; nothing new                    |
| Hosted app logs                                       | no                                             | `device-host.logs.query`, which `stim logs` already uses |
| Hosted device frames and input                        | no                                             | the hosted viewer relay, already used by phones          |

Phase 1 adds no server protocol for ownership. If the floco QA finds a gap,
such as a probe or relay that fails off macOS, it is fixed in phase 0.

### One session, one owner

Desktop and the phone show a session, build or device only under the server
that reports it. Two paired entries are the same server when their pinned
server keys are equal. Desktop also treats an entry whose `hello.server.id`
equals its local server's as itself. Pairing refuses either case with
"Already paired" or "This is this Mac's own server". With pairing limited to
owning servers, no hosted session is reported by two of them, so no
cross-server de-duplication is needed. The rule for both apps is in core:
`samePairedServer(a, b)` compares pinned keys. Desktop mirrors it as one key
comparison.

### Who controls it

Each server controls what it started. Both apps show three labels:

- **Owner.** Every remote workspace row, card and page names its server, using
  the name the person gave at pairing (default `hello.server.name`). Local
  rows show none, as today.
- **Where it runs.** A hosted device keeps the existing placement label
  ("Running on janics-mac-mini-2", computer icon), so a bot session reads
  "floco · running on janics-mac-mini-2".
- **Driver.** The existing `activity.driver.tool` chip, such as Claude Code,
  is unchanged. It now sits under the owner, so it reads "Claude Code on
  floco".

## Pairing and trust

1. **Payload.** Desktop reuses the phone's payload unchanged. On the owning
   machine a person runs `stim-server pair --json`, or `--control` from the
   control phase, and pastes the output into Desktop's **Pair with a
   Machine...** sheet. It is one JSON paste, not a QR code. Desktop requires
   the `fingerprint`. Separate Endpoint, Token and Fingerprint fields are the
   fallback. Unlike the phone's manual entry, which has no fingerprint,
   Desktop does not trust a first-use key it cannot check.
2. **Handshake.** This is the phone's flow:
   - `Noise_XXpsk2` with the token, then a check that the server's static key
     matches the fingerprint before message 3;
   - the device name in message 3 is the Mac's name plus " (Stim Desktop)";
   - `hello`, then pin the server key.
     Later connections use `Noise_XX` against the pin. A changed key refuses
     with "This machine's server key changed" and never re-pins on its own;
     only a new pairing replaces a pin.
3. **Implementation.** Desktop gets a Swift Noise client on CryptoKit:
   - CryptoKit provides X25519, ChaChaPoly, SHA-256 and HMAC for HKDF;
   - the ChaChaPoly nonce is 32 zero bits followed by the 64-bit little-endian
     counter, which is CryptoKit's 12-byte nonce;
   - Stim's framing is one ChaChaPoly message per WebSocket message;
   - it is tested against the shared vectors in
     `apps/mobile/modules/stim-session/test/`.
     The transport is a `ServerTransport` over `NWConnection` with TLS for
     `wss://` and without TLS for `ws://`. `ServerClient`'s reconnect,
     resubscribe and refusal handling stays as it is.
4. **Storage.** Everything is stored in the macOS Keychain, never in
   `$STIM_HOME`, never in `UserDefaults`, and never in the CLI's
   `client-identity.key`:
   - One X25519 key per Desktop install, as a generic-password item with
     `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and not synchronizable.
   - One item per pairing: endpoint, display name, pinned server key, server
     id, the capabilities seen in the last `hello`, and the pairing time.
   - The pins are integrity data. A file that another process could rewrite
     would let it redirect a pairing.
   - Unit tests use an in-memory store behind the same protocol.
5. **Endpoints.** Endpoints follow the phone's rule (`apps/mobile/src/lib/pairing.ts`):
   `wss://`, or `ws://` to a loopback, RFC 1918, link-local, CGNAT `100.64/10`
   or ULA literal. Phase 1 keeps the tailnet only (`*.ts.net` names, `100.64/10`,
   `fd7a:115c:a1e0::/48`); see Q3 for the LAN. It never uses Funnel:
   `stim-server pair` already refuses a funneled route, and Desktop refuses any
   public host.
6. **Revocation.** On the owning machine, `stim-server devices revoke <id>`,
   or that Mac's Desktop **Settings > Phones** list (renamed **Paired
   Devices**, since Desktop records appear there too), removes the record.
   The open connection closes within about 1 s. Desktop then shows "<name>
   no longer knows this Mac. Pair again." and stops retrying. **Forget** in
   Desktop deletes the Keychain item. Like the phone, it does not revoke on
   the server; the sheet says so and shows the revoke command.
7. **Read and control.** The scope is the one the server stored for this key.
   `devices grant <id> --control|--read` changes it, and **Reconnect** picks it
   up. Desktop reads scope only from `hello.capabilities` and `hello.actions`.

## Phase 1: what Desktop shows for a remote server (read-only)

For each paired server, Desktop opens one `ServerClient` and subscribes to:

- `workspaces.subscribe` and `workspace.subscribe`, for its workspaces,
  devices, running builds with placement, and hosted sessions;
- `machine.subscribe`, plus `machine.get` and `machine.details` on demand, for
  capacity, load, build and device slots;
- `archived.list`, `logs.subscribe` and `logs.query`.

`frames.subscribe` covers a workspace's local devices and, through the
relay, its hosted ones. It is opened only while a tile or viewer is visible,
as today.

Every action stays hidden or disabled for a remote workspace until the
control phase. That includes the actions Desktop runs through its local CLI:
Run, Stop, Reload, Show in Finder, worktree removal, Free and Copy command.
Desktop never runs a local `stim` command with a remote path, and never sends
a `desktop.*` method to a remote server.

Remote data is kept in memory only. On reconnect Desktop shows the last
payload as stale, with "Offline since 14:02". It does not persist other
machines' workspace paths or logs.

## Hosted devices through the owning server

A paired Desktop or phone views the bot's hosted simulator by sending
`frames.subscribe` for that workspace's slot to the bot's server. That server
relays it over its existing device-host connection to mini-2. The README's
"Hosted viewer relay" covers the existing behavior:

- **Trust.** mini-2 sees only its approved client, floco. Desktop sees only
  floco. Neither learns the other's key.
- **Read and control.** Viewing needs `read` on floco's server. Input needs a
  `control.begin` that floco's `canControl` grants, so a `--control` pairing,
  in the control phase. mini-2 checks floco's device-host approval as today.
- **Refused for hosted targets.** Replay (`at`, `rate`), `duoFrame` and
  `physical` are refused with `bad-request`. Hosted macOS needs the default
  slot.
- **Bandwidth and latency.** Every viewer of floco's hosted devices on mini-2
  shares floco's one connection, and with it the host's 32-subscription and
  input budgets. Frames cross two links: mini-2 to floco on AWS, then floco
  to the MacBook. That costs AWS egress for each viewer's stream and adds the
  VM's round trip to input. A lagging relay drops H.264 until the next
  keyframe and asks the host to lower bitrate (`hosted-congestion`).
- **Measurement.** Phase 0 measures frame latency and bitrate on this path
  and reports it in the PR. A live tile of a remote hosted device is opened
  only on demand, never for an Overview card. Remote Overview cards show the
  last frame thumbnail only when the server already sends one.

## Linux and Windows servers (phase 0, critical path)

The code does not gate the read path to macOS:

- `pair`, `serve` and every read handler have no platform guard;
- the systemd user backend exists;
- the LAN transport is platform-neutral;
- the server binds its Tailscale addresses directly, so `ws://100.x` works
  without `tailscale serve`.

What degrades on Linux, from the code:

- Memory pressure and `memory.usedBytes` are null.
- Status runs `xcrun simctl`, fails, and reports `simctlAvailable: false`.
- There is no frame helper. Local Android emulator frames come from gRPC
  screenshots, and there are no recordings or replay.
- Per-process footprints are null.

The client's relay of hosted frames runs before the local frame helper is
used (`server.ts` `frames.subscribe`), so it should work on Linux; phase 0
confirms it.

On floco (checked 2026-10-26, read-only):

- stim 1.29.0 is installed;
- `stim-server` is not installed and none is running;
- `systemctl --user` fails with "Failed to connect to bus: No medium found";
- Tailscale lists only floco, janics-mac-mini-2 and an offline
  janics-macbook-pro.

A separate QA run on floco checks the Linux read path with a test install.
This section takes its findings when they land; until then nothing here
claims the path was run on Linux.

Phase 0 makes this work and documents it as **Serve Desktop and phones from
Linux**:

1. Install the server beside `stim` (`npm install --global --prefix ~/.local
@stim-cli/server@<stim version>`).
2. A person with sudo runs `sudo loginctl enable-linger <user>`. That starts
   the user manager, and with it the bus. `stim-server service install`
   already defaults `XDG_RUNTIME_DIR` and prints this command. Before turning
   linger on, check which user units already exist. If the bot's
   `openclaw-gateway.service` is a user unit of the same account, linger
   changes when it starts. That is the maintainer's call; this design does
   not touch it.
3. Choose the reach:
   - `sudo tailscale set --operator=<user>` and `stim-server service install
--serve` give a tailnet-only `wss://floco.<tailnet>.ts.net:7443`;
   - or the server's direct `ws://<tailnet IP>:7787` with no serve route,
     which needs `pair` to print it (below).
4. `stim-server pair --json` over SSH prints the payload. Pairing is not
   setup, so SSH is fine.

Code changes, kept to what QA confirms:

- `pair` prints a reachable endpoint on a Linux host with no serve route. It
  prints the tailnet IP endpoint and says why, instead of assuming
  `wss://<dns>:7443` when `tailscale serve status` fails without operator.
- Status skips `xcrun simctl` off macOS instead of recording an error each
  time.
- The website section above, plus `stim-server service status` reporting
  the pairing endpoint.

A system unit is not proposed. A user unit with linger keeps the service and
its Stim home under the bot's account, matching how `stim` already runs
there.

Windows is not on the critical path. The same read handlers run there, with
no Unix socket and no `ps` or `lsof`. Windows follows once a Windows owner
asks.

## Phone

The phone uses the same model:

- it pairs with each owning server itself, such as the MacBook and floco;
- it gets the same relay, and it already uses it;
- it shows the same owner and where-it-runs labels;
- nothing Desktop paired with appears on the phone, and the reverse holds too.

The phone already does most of this. Its work is the owner label on
workspace rows, which it already shows per machine in the drawer, and the
where-it-runs label for hosted devices.

**Pairing the phone from Desktop** is deferred to a later phase. The safe form
would be:

- Desktop asks each server it trusts for a fresh single-use phone pairing
  code and shows them as one list;
- it never forwards its own key;
- the scope is capped at Desktop's own, and the server records which device
  minted each code, so revoking Desktop shows the phones it paired.

That needs a new capability to mint codes. It also makes a read pairing able
to create more read pairings, which a stolen Desktop key could repeat until
revoked. Scanning one QR per owning server is two or three scans in practice,
so the convenience does not justify widening trust in phase 1.

## UI

The design follows `apps/desktop/README.md` and the current `Sidebar.swift`.

- **Sidebar.**
  - Overview, Active Workspaces, Machines and Builds stay pinned at the top.
  - The Projects tree is this Mac's.
  - Below it, one section per paired server with its own tree, using the same
    rows, grouping and view options.
  - The section header shows the server's name, a connection dot and an
    access pill: **View Only**, or **View and Control** in the control phase.
  - A collapsed section shows its active count.
- **Overview and Active Workspaces** include remote active workspaces. Each
  card carries the owner chip, such as `floco`. Hosted devices keep "Running
  on <host>".
- **Machines.** The selector adds each paired server after **This Mac** and
  the remote build Macs. It shows that server's **Now** and capacity from
  `machine.subscribe` and `machine.details`. Disk and **Free** stay
  This-Mac-only.
- **Workspace page.** The read-only Status, Build, Logs and devices areas
  have no action menus. A "Viewing floco · read-only" line replaces the stage
  actions.
- **Settings.**
  - A **Paired Machines** tab holds **Pair with a Machine...**, each pairing's
    status, the server's fingerprint, **Reconnect** and **Forget...**.
  - The tab, the pairing sheet and the per-server sections are behind a new
    **Paired machines** feature flag, off by default until phase 1 ships.
- **States.** The section dot and a row under the header show:
  - "Connecting";
  - "Offline · retrying in 12 s", with the last data greyed and "Offline
    since";
  - "No longer paired. Pair again";
  - "Server key changed";
  - "Update stim-server on floco", for protocol 1 or a missing feature;
  - "This Mac speaks an older protocol. Update Stim Desktop".

  These reuse the phone's refusal mapping (`connection.ts`
  `sessionRefusal`).

## Control phase

Control gives a `--control` pairing the phone's control surface, through the
owning server:

- `action` (Stop and Reload);
- `control.begin` with `input.*`, including hosted devices through the relay;
- `recording.set`.

The UI turns on Stop, Reload and the viewer's Control toggle for that
server's rows.

These stay local-only, even with control:

- every `desktop.*` method: run, start, build, gc, worktree warm or remove,
  settings, doctor and reports;
- `route.setup`, `machines.update.*`, `device-host.sessions*` and pairing
  grants or revocations;
- approving build or device-host access, and any native build or install
  started from Desktop on another machine. The phone cannot start a build
  either;
- Disk, **Free** and Show in Finder.

Starting work on another machine needs its own product decision.

## Architecture rule changes

Proposed `CLAUDE.md` wording, applied by the PR that first opens a network
connection from Desktop (PR D below). In the Desktop paragraph, replace "It
connects to stim-server only over the server's Unix socket, normally..." up to
"without pairing or Noise." with:

> It connects to its own Stim home's stim-server only over that server's Unix
> socket, normally `$STIM_HOME/server/local.sock`. [unchanged socket-path
> sentences] It may also pair, as a client, with another machine's stim-server,
> as the phone app does: it spends a `stim-server pair` token in protocol 2's
> Noise handshake, requires the payload's server-key fingerprint, and keeps its
> client private key and each pairing's pinned server key in the macOS Keychain,
> never under `$STIM_HOME`. It connects only to tailnet endpoints, never through
> Funnel. A remote server grants it only the capabilities recorded for its key:
> `read`, plus `control` for a `--control` pairing. `desktop.*`, `route.setup`,
> `machines.update.*` and `device-host.sessions*` stay Unix-socket-only.
> Desktop never runs a local Stim command for a remote workspace and never
> stores another machine's workspace data on disk.

In "Machine-to-machine authentication", "Clients of this machine's own user
use the Unix socket, never a TCP connection" stays true: a remote Desktop is
another machine's client. Add after it:

> A Stim Desktop paired with another machine's server is an ordinary paired
> device there.

"Hosted devices" is unchanged. Hosted sessions stay visible to other machines
only through their owning client's server.

## Phases

0. **Linux owning server, critical path.** Run stim-server on the bot VM as a
   user service with linger. Fix what the floco QA finds. Make `pair` print a
   reachable endpoint. Write the docs. Measure the relay path.
1. **Desktop pairs read-only.**
   - Swift Noise client and Keychain store.
   - Pairing sheet and Paired Machines settings.
   - Per-server sidebar sections, owner labels and remote Machines entries.
   - Hosted devices and offloaded builds as their owning server reports them.
2. **Phone labels.** Owner and where-it-runs labels for hosted devices and
   offloaded builds. This can ship alongside phase 1.
3. **Control.** `--control` pairings get Stop, Reload, device control,
   including hosted devices through the relay, and recording.
4. **Later.** Pairing the phone from Desktop, LAN endpoints (Q3), self-forget
   (a method that removes the caller's own record), and Windows owning servers.

## Implementation breakdown

Each line is one PR. Critical-path PRs are marked **(critical)**.

| PR                                                  | Owns                                                                                                                                                                                                                                                                                                                                                           | Depends on                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **A. Linux serving (critical)**                     | `packages/server/bin/stim-server.ts` (`pair` endpoint off macOS), `packages/server/src/service-manager.ts` (status prints the endpoint), `packages/stim-cli/src/status-read.ts` and `devices/ios.ts` (skip simctl off macOS), `website/docs/remote-machines.md` and `packages/server/README.md` (Serve from Linux), tests in `packages/server/__tests__`       | floco QA findings; Q1 for the reach |
| **B. Floco deployment (critical, ops)**             | No repo files. Install the server, linger, operator, service and pairing on floco, with the maintainer's approval at each step that changes the VM                                                                                                                                                                                                             | A; Q1; Q2                           |
| **C. Core pairing rule**                            | `packages/core/phone-protocol.ts` (`samePairedServer`, the Desktop device-name suffix), `apps/mobile/src/lib/macs.ts` uses it                                                                                                                                                                                                                                  | none                                |
| **D. Desktop Noise client and Keychain (critical)** | `apps/desktop/Sources/StimKit/Noise.swift`, `NoiseTransport.swift`, `PairedServerStore.swift` (Keychain plus in-memory test store), `ServerClient.swift` (transport factory only), `Tests/StimKitTests/Noise*Tests.swift` with the shared vectors, `CLAUDE.md` rule change                                                                                     | none                                |
| **E. Desktop pairing UI (critical)**                | `apps/desktop/Sources/StimDesktop/PairedServersModel.swift`, `Views/PairMachineSheet.swift`, `Views/PairedMachinesView.swift`, `Views/SettingsView.swift` (tab), `FeatureFlagStore.swift` (flag), `Views/PhonesView.swift` (rename to Paired Devices), `apps/desktop/README.md`                                                                                | D                                   |
| **F. Desktop remote views (critical)**              | `Views/Sidebar.swift`, `Views/SidebarWorktreeRow.swift`, `Views/SidebarRowDetails.swift`, `Views/OverviewView.swift`, `Views/WallView.swift`, `Views/MachineView.swift`, `Views/MachineDetailView.swift`, `Views/WorkspaceActionsMenu.swift` (hide actions for remote), a per-server store keyed by server and path in `StimStores`, `website/docs/desktop.md` | E                                   |
| **G. Phone labels**                                 | `apps/mobile/src/lib/device-tile.ts`, `apps/mobile/src/lib/home-list.ts`, the workspace and build screens, `apps/mobile/mock-server/payloads.mjs` and fixtures (a hosted session and an offloaded build from a Linux owner), `apps/mobile/src/intl` and `locales`, `website/docs/phone-app.md`                                                                 | C                                   |
| **H. Control from Desktop (phase 3)**               | `Views/WorkspaceActionsMenu.swift`, `Views/DeviceViewer.swift`, `Views/DeviceViewerToolbar.swift`, `StimKit/AgentActions.swift` (route remote actions to that server's `action`), docs                                                                                                                                                                         | F                                   |

The critical path for the maintainer's case is A then B, run in parallel with
D, then E, then F. C and G run alongside, and H follows F.

## Test and verification plan

- **Unit tests.**
  - Swift Noise against the shared vectors (`noise-vectors.cpp` and
    `.test.mjs` inputs), covering first contact, returning mode, a
    fingerprint mismatch before message 3, and a changed key on reconnect.
  - The pairing payload parser refuses a missing fingerprint, a public host,
    `v: 1` with an update message, and a later `v` with "update Stim
    Desktop".
  - The Keychain store round-trips and Forget deletes the item. The test store
    runs in memory; the real Keychain is checked by hand on a signed test copy.
  - `samePairedServer`.
  - A remote workspace exposes no action and runs no CLI command.
- **Server tests (A).** These run in the Linux CI job:
  - `pair` on a host without a serve route prints the tailnet IP endpoint;
  - status off macOS never calls `xcrun`.
- **Real pairing with Linux (B).** On floco, after the maintainer approves the
  VM changes, run:
  - `stim-server service install`, then `service status`, showing linger on
    and an endpoint;
  - `stim-server pair --json` over SSH;
  - pair a Desktop test copy on janics-mac-mini, under the Desktop workflow
    rules, and the maintainer's phone.

  Then have the bot run `stim ios --remote janics-mac-mini-2` in its own
  worktree and confirm on both clients:
  - the workspace appears under floco;
  - the build shows "building on janics-mac-mini-2" with its phase;
  - the hosted simulator streams through the relay, with latency and bitrate
    recorded;
  - `devices revoke` on floco closes Desktop within about 2 s and shows
    "No longer paired";
  - mini-2's own Desktop still lists the session only in its local "Hosted
    here".

  Finish with `stim stop` in the bot's test worktree.

- **Desktop screenshots on janics-mac-mini** (`stim macos --remote-build
janics-mac-mini --remote janics-mac-mini`, agent-device with the native
  backend):
  - the pairing sheet;
  - a floco section, both connected and offline;
  - a hosted device row with the owner and where-it-runs labels;
  - Machines with floco selected;
  - Settings > Paired Machines.
- **Negative checks.**
  - A `ws://` public IP is refused.
  - A Funnel-routed server refuses `pair`.
  - Pairing the local server is refused.
  - Every `desktop.*` method sent over Noise returns `forbidden`.

## Open decisions

Only these block implementation.

1. **How do the MacBook and the phone reach floco's server?** floco is only on
   the App & Flow tailnet. The MacBook and the phone are usually on the
   personal tailnet. The App & Flow rules let floco reach only mini-2:7443.
   Pairing needs inbound access to floco's serve port.
   - **Recommendation:** share the floco node into the personal tailnet, as
     mini-2 is shared the other way, and add one App & Flow rule that allows
     the maintainer's identity to reach `tag:bot` on the serve port only.
     Tailscale rules are stateful, so floco gains no new outbound reach and
     the existing block stays. The phone gets the same reach without
     switching tailnets.
   - **Alternatives:**
     - keep the MacBook on the App & Flow tailnet: one tailnet at a time
       loses the personal one;
     - relay through a machine on both tailnets: that adds a hop and a
       trusted middle.
2. **Linger on floco.** Can `sudo loginctl enable-linger bot` be turned on?
   Recommend yes, after confirming `openclaw-gateway.service` is a system unit
   or otherwise unaffected. If it is a user unit of `bot`, the alternative is
   to run stim-server under a separate `stim` account that reads the bot's
   Stim home. That needs a decision on shared state, so prefer linger.
3. **LAN endpoints for Desktop.** Should Desktop accept `ws://` private LAN
   endpoints, as the phone does? Recommend later (phase 4). It is equally
   authenticated, since Noise pins the key, but the maintainer's case is all
   tailnet. Phase 1 is tailnet-only, as the brief says.

## Related

- #3681 and `docs/specs/2026-10-13-pluggable-transports-design.md`, phase 3
  (Desktop on the generic transport status).
- #3546: the Desktop actions behind the local server stay local here.
- #2451: machine-aware links. Remote workspaces need it to open from
  notifications.
- #2404: Linux workers.
- #4458: the LAN transport.
- #2750: the host's local "Hosted here".
