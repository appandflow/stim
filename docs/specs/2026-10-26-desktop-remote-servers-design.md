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
just to see work there.

The client's server already reports what it started. It reports where each
build runs and its phase, and each hosted session's host, device and state. It
already relays a hosted device's view and input over its approved device-host
connection. So a paired Desktop or phone sees the bot's hosted simulator on
janics-mac-mini-2 by talking only to the bot's server, and later controls it
the same way.

- **Trust is unchanged and not transitive.** A host trusts only the clients a
  person on the host approved. A viewer trusts only the servers it paired
  with, by their pinned Noise keys.
- **No new command, flag or capability.** Desktop gains a Noise client, a
  Keychain store and a pairing flow. It must also treat every remote message
  as untrusted input.
- **Critical path is Linux.** Phase 0 runs stim-server on the Linux VM as a
  service that Desktop and the phone can reach. It needs one network decision
  from the maintainer (see [Open decisions](#open-decisions)).

## Maintainer decisions

These were taken in chat on 2026-10-26 and are treated as settled here.

1. Desktop pairs with other stim-servers, like the phone app. It is read-only
   first, then control.
2. Each server is the controller of what it started. The UI names that server
   for every workspace, device and hosted session.
3. When the bot VM runs a simulator on mini-2, the MacBook sees it, and remote
   builds show up the same way. This happens through the bot's server, never
   by pairing with mini-2. A session shows once, under its owning server, with
   the host shown as where it runs.
4. Build machines and device hosts are never paired with for viewing. The
   host's "Hosted here" list stays a local admin view for the person at that
   machine.
5. The phone follows the same model and pairs with each owning server itself.
   Nothing Desktop paired with appears on the phone.

## What exists

| Piece                     | Where                                                                                       | Today                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone pairing payload     | `packages/server/bin/stim-server.ts` `pair()`, `packages/core/phone-protocol.ts`            | Plain `pair` prints `{ v: 2, name, endpoint, pairingToken, fingerprint }`. `pair --json` wraps it as `{ qr, expiresAt }`. The token is single use for 5 minutes. `--control` stores `['read','control']` with the secret, otherwise `['read']`. |
| Authentication            | `packages/core/noise-session.ts`, `server.ts` `authenticate()`, `registry.ts` `spendSecret` | Protocol 2. First contact uses `Noise_XXpsk2_25519_ChaChaPoly_SHA256` with the token as the PSK. Later connections use `Noise_XX` against the pinned server key. A `devices.json` record holds the client's public key and capabilities.        |
| Phone key and pins        | `apps/mobile/modules/stim-session/ios/ClientKey.mm`, `apps/mobile/src/lib/macs.ts`          | The X25519 private key lives in the Keychain, `ThisDeviceOnly`. The pairing index (endpoint, name, `serverKey`, server id) lives in SecureStore.                                                                                                |
| Control                   | `server.ts` `canControl`, `checkRevocations`                                                | The server rereads `devices.json` on every control call. Revocation closes sockets within about 1 s and ends control sessions that lost `control`.                                                                                              |
| Desktop's server client   | `apps/desktop/Sources/StimKit/ServerClient.swift`, `ServerProtocol.swift`                   | It mirrors the phone's `connection.ts` reconnect logic. `connect()` assumes a Unix socket (path-length, socket-directory and port checks). `refusalCodes` lacks the Noise refusals. It has no Noise and no Keychain code.                       |
| Desktop-only methods      | `server.ts` `desktopMethod`                                                                 | `desktop.*`, `route.setup`, `machines.update.*` and `device-host.sessions*` answer only on the Unix socket. A Noise connection gets `forbidden`.                                                                                                |
| Offloaded build in status | `packages/core/state/status.ts` `BuildPlacement`, build ledger `machine`                    | A running build reports `{ host, phase, startedAt, phaseStartedAt }`. The ledger records where the build compiled and its outcome.                                                                                                              |
| Hosted session in status  | `packages/core/state/hosted-ios.ts`, `hosted-android.ts`, `hosted-macos.ts`                 | Each slot reports `machine`, `session`, `device`, `agent`, and the latest session probe `state`.                                                                                                                                                |
| Hosted viewer relay       | `packages/server/src/hosted-relay.ts`, server README "Hosted viewer relay"                  | The client's server relays hosted iOS, Android and macOS frames and input over one device-host connection per host, pinned to the host's key. Phones already use it.                                                                            |
| Hosted app logs           | `packages/stim-cli/src/device-host/hosted-logs-sync.ts`                                     | The client's CLI copies hosted logs into its Stim home during its own commands. The server does not pull them, so `logs.*` serves only what was copied.                                                                                         |
| Linux service             | `packages/server/src/service-manager.ts`, `service.ts`                                      | It is a systemd user unit. `XDG_RUNTIME_DIR` defaults to `/run/user/<uid>`. Linger is reported and its command printed; Stim never runs sudo.                                                                                                   |

The phone calls these methods. "Desktop today" says whether Desktop's local
client already decodes them.

| Method                                                                                 | Phone | Desktop today                                                         |
| -------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| `hello`, `unsubscribe`                                                                 | yes   | yes                                                                   |
| `workspaces.subscribe`, `workspace.subscribe`, `machine.subscribe`, `archived.list`    | yes   | yes                                                                   |
| `logs.subscribe`, `logs.query`                                                         | yes   | yes                                                                   |
| `frames.subscribe`, `frames.keyframe`, `frames.seek`, `replay.range`, `archive.detail` | yes   | yes                                                                   |
| `workspace.files`, `workspace.diff`, `control.begin`, `input.*`                        | yes   | yes                                                                   |
| `frames.live`, `action`, `settings.get`, `recording.set`                               | yes   | no. Desktop uses `desktop.settings.get` and its local CLI.            |
| `machine.get`, `machine.details`, `machine.history`                                    | yes   | no. Desktop reads its own machine from the CLI and `desktop.reports`. |
| `build.plan`                                                                           | yes   | no. Desktop uses `desktop.plan.get`.                                  |
| `notifications.list`, `push.*`, `status.subscribe` fallback                            | yes   | no                                                                    |

So a remote view in Desktop reuses its existing decoders for workspaces,
devices, builds, logs and frames. Remote capacity adds the `machine.*` reads,
and the control phase adds `action`, `settings.get` and `recording.set`. The
phone's payloads already define all of them.

## Ownership: what the client's server reports

| Fact                                                  | Known from the client's own records            | Fetched from the host over the approved connection      |
| ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| An offloaded build's worker, phase and start times    | yes: the offload stream feeds `BuildPlacement` | It is streamed during the build. Nothing new is needed. |
| Its result, duration and cache outcome                | yes: the build ledger                          | none                                                    |
| A hosted session's host, session id, device and agent | yes: the workspace placement records           | none                                                    |
| The hosted session's live state                       | the latest probe in status                     | Status already probes it. Nothing new is needed.        |
| Hosted app logs                                       | the logs the client's CLI already copied       | `device-host.logs.query`. Today only the CLI calls it.  |
| Hosted device frames and input                        | no                                             | the hosted viewer relay, which phones already use       |

Phase 1 adds no server protocol for ownership. A viewer sees the hosted logs
that the bot's own `stim` commands copied, and the log view says "Hosted logs
copy when the agent runs stim logs". A server-side pull of hosted logs is a
later phase. Any gap the floco QA finds, such as a probe or relay that fails
off macOS, is fixed in phase 0.

### One session, one owner

Desktop and the phone show a session, build or device only under the server
that reports it.

- **Same server.** Two paired entries are the same server when their pinned
  server keys are equal. Pairing refuses a second entry with "Already paired".
- **Local server.** An entry whose `hello.server.id` equals Desktop's local
  server's id is Desktop's own server. The server id is only known after the
  token is spent, so that pairing is refused after the fact. Desktop deletes
  the pin and shows the `stim-server devices revoke <id>` command for the
  record it left.
- **No cross-server de-duplication.** Pairing is limited to owning servers,
  so no two of them report the same hosted session.

Both apps apply the same rule: compare pinned keys, then server ids.

### Who controls it

Each server controls what it started. Both apps show three labels:

- **Owner.** Every remote workspace row, card and page names its server. The
  name is the one the person gave at pairing, by default `hello.server.name`.
  Local rows show no owner, as today.
- **Where it runs.** A hosted device keeps the existing placement label,
  "Running on janics-mac-mini-2" with a computer icon. A bot session therefore
  reads "floco · running on janics-mac-mini-2".
- **Driver.** The existing `activity.driver.tool` chip, such as Claude Code, is
  unchanged. It sits under the owner, so it reads "Claude Code on floco".

## Pairing and trust

### Payload

Desktop accepts the phone's payload in either printed form. That is the bare
JSON from `stim-server pair`, or the `{ qr, expiresAt }` wrapper from `pair
--json`. On the owning machine a person runs `stim-server pair`, adding
`--control` in the control phase. They paste the output into Desktop's **Pair
with a Machine...** sheet. It is one paste, not a QR code.

Desktop requires the `fingerprint`. The fallback is separate Endpoint, Token
and Fingerprint fields. The phone's manual entry has no fingerprint, but
Desktop never trusts a first-use key it cannot check.

### Handshake

The handshake is the phone's flow, as specified by
`docs/specs/2026-10-13-pluggable-transports-design.md` ("Authentication") and
`packages/core/noise-session.ts`. That covers the version and mode bytes, the
lookup prefix, the prologue, the PSK derivation and the message-type framing.

1. Run `Noise_XXpsk2` with the token.
2. Check the server's static key against the fingerprint before sending
   message 3. A mismatch aborts before the token proves anything to that key.
3. Send the device name in message 3: the Mac's name, chosen by the client.
4. Send `hello`, then pin the server key.

Later connections use `Noise_XX` against the pin. A changed key refuses with
"This machine's server key changed". Desktop never re-pins a key on its own;
only a new pairing replaces a pin.

### Swift implementation

Desktop gets a Swift Noise client built on CryptoKit.

- **Primitives.** CryptoKit provides X25519, ChaChaPoly, SHA-256 and HMAC.
  HKDF is RFC 5869 with empty info.
- **Nonce.** The ChaChaPoly nonce is 32 zero bits followed by the 64-bit
  little-endian counter. That is CryptoKit's 12-byte `ChaChaPoly.Nonce`.
- **Sealed boxes.** Build them with `SealedBox(nonce:ciphertext:tag:)`, never
  with `SealedBox(combined:)`. Stim's wire format carries no nonce.
- **Shared secrets.** An all-zero X25519 shared secret throws, as `noise.ts`
  requires.
- **Tests.** The client passes the JSON vectors in
  `packages/core/__tests__/fixtures/` (`noise-vectors.json`,
  `noise-framing-vectors.json`, `noise-secret-vectors.json`). A CI test also
  pairs and reconnects against a real `stim-server` over loopback TCP.

### Client changes

The transport is a `ServerTransport` over `NWConnection`, with TLS for `wss://`
and without it for `ws://`. `ServerClient.connect()` runs its Unix-socket
checks only for a `file:` endpoint.

`ServerProtocol.refusalCodes` gains the Noise refusals the phone maps in
`sessionRefusal`: `server-key-mismatch`, `unknown-secret` and
`handshake-failed`. Desktop then stops retrying instead of feeding the
server's failed-handshake lockout.

### Untrusted input

A paired server is another machine, and the bot's server runs as an AI agent's
account. Every message Desktop receives from it is validated the same way:

- reply ids and sequence numbers use checked integer conversion;
- sizes keep their existing 16 MiB bound;
- a malformed message closes that connection and never traps the app.

This applies to the existing parsers that assumed a local server, such as
`ServerClient.swift`'s reply id and `StatusViews.swift`'s sequence. Remote
URLs, such as an agent session's `openUrl`, are never opened automatically.
Remote paths are never turned into file URLs (see Phase 1).

### Storage

Desktop stores keys and pins in the macOS Keychain. It never stores them under
`$STIM_HOME`, in `UserDefaults`, or in the CLI's `client-identity.key`.

- **Client key.** There is one X25519 key per Desktop install. It is a
  generic-password item in the data-protection keychain
  (`kSecUseDataProtectionKeychain`), with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable.
- **Pairings.** There is one item per pairing. It holds the endpoint, display
  name, pinned server key, server id, the capabilities seen in the last
  `hello`, and the pairing time. The pins are integrity data: a file that
  another process could rewrite would let it redirect a pairing.
- **Entitlements.** The data-protection keychain needs signed entitlements
  (`keychain-access-groups` under the release team). The released app has them.
  Ad-hoc test copies (`apps/desktop/scripts/bundle.sh`) do not. PR C confirms
  the entitlement on a signed build.
- **Test copies and unit tests.** Ad-hoc copies use an in-memory store, so
  they re-pair on every launch. The pairing sheet says "Pairings are not kept
  in this build". Unit tests use the same in-memory store.

### Endpoints

Phase 1 accepts tailnet endpoints only:

- `wss://` to a `*.ts.net` name;
- `ws://` to a `100.64/10` or `fd7a:115c:a1e0::/48` literal.

These are a subset of the phone's rule (`apps/mobile/src/lib/pairing.ts`).
LAN endpoints wait for phase 4 (decided 2026-10-26). The host check is
advisory. The security boundary is the pinned server key, because a client
cannot tell a Funnel route from a tailnet one. `stim-server pair` already
refuses a funneled route.

### Revocation

- **On the owning machine.** `stim-server devices revoke <id>` removes the
  record. So does that Mac's Desktop **Settings > Phones** list, renamed
  **Paired Devices** because Desktop records appear there too. The open
  connection closes within about 1 s. Desktop then shows "<name> no longer
  knows this Mac. Pair again." and stops retrying.
- **In Desktop.** **Forget** deletes the Keychain item. Like the phone, it does
  not revoke on the server. The sheet says so and shows the revoke command.

### Read and control

The scope is the one the server stored for this key. `devices grant <id>
--control|--read` changes it, and **Reconnect** picks up the change. Desktop
reads scope only from `hello.capabilities` and `hello.actions`.

### What a read pairing reaches

Read exposes everything the phone sees on that server:

- workspace paths, status and logs;
- changed and untracked text files, including non-ignored `.env` files;
- the doctor report in `machine.details`;
- the live screens of every local and hosted device of every workspace there.

The website page says this next to the pairing steps, as it already does for
phones.

## Phase 1: what Desktop shows for a remote server (read-only)

For each paired server, Desktop opens one `ServerClient` and subscribes to:

- `workspaces.subscribe` and `workspace.subscribe`, for its workspaces,
  devices, running builds with placement, and hosted sessions;
- `machine.subscribe`, plus `machine.get` and `machine.details` on demand, for
  capacity, load, and build and device slots;
- `archived.list`, `logs.subscribe` and `logs.query`.

`frames.subscribe` covers a workspace's own devices and, through the relay, its
hosted ones. Desktop opens it only while a tile or viewer is visible, as today.

### Identity

Every workspace, device and viewer reference carries its owning server. The
local server is one owner among them.

Today Desktop decides that a device is local when it has `host == nil`
(`DeviceTile.swift`, `DeviceViewer.swift`, `DeviceRef.swift`). A remote
workspace's own simulator also has `host == nil`. Without an owner, Desktop
would attach CoreSimulator or gRPC to a UDID or serial on another machine.

Views that use `ServerSession.shared` directly take the owning server's client
instead. These include:

- LogsView, WorkspaceDiffView, ReplayViews, DeviceViewer and its toolbar;
- PhysicalDeviceScreen, ArchivedReplay, AgentFeed, WorkspaceDetail and RootView;
- `StimStores/StatusStore.swift`.

### Remote paths

A remote workspace path is a label, never a file. It is never converted to a
file URL, a process working directory, a git, `gh` or icon lookup, or a Finder
action. A remote path can equal a local one when both machines share a
username.

UI state that Desktop persists by path is keyed by server id, so a remote path
never collides with a local one. That covers hidden workspaces, navigation
history and expanded projects.

### Actions

Every action stays hidden or disabled for a remote workspace until the control
phase. That includes Run, Stop, Reload, Show in Finder, worktree removal, Free
and Copy command. Desktop never sends a `desktop.*` method to a remote server.

### Notifications

Remote workspaces raise no Desktop notifications in phase 1. Notifier,
OversightNotifier and the Inbox stay local. The phone's own pairing with that
server already covers notifications.

### Offline data

Remote data is kept in memory only. On reconnect, Desktop shows the last
payload as stale with "Offline since 14:02". It does not write other machines'
workspace data or logs to disk.

## Hosted devices through the owning server

A paired Desktop or phone views the bot's hosted simulator by sending
`frames.subscribe` for that workspace's slot to the bot's server. The bot's
server relays it over its existing device-host connection to mini-2. The
behavior below exists today; the server README's "Hosted viewer relay"
describes it.

- **Trust.** mini-2 sees only its approved client, floco. Desktop sees only
  floco. Neither learns the other's key.
- **Read and control.** Viewing needs `read` on floco's server. Input needs a
  `control.begin` that floco's `canControl` grants, so it needs a `--control`
  pairing in the control phase. mini-2 checks floco's device-host approval as
  it does today.
- **Refused for hosted targets.**
  - Replay (`at`, `rate`), `duoFrame` and `physical` are refused with
    `bad-request`.
  - Hosted macOS needs the default slot.
- **Bandwidth and latency.**
  - Every viewer of floco's hosted devices on mini-2 shares floco's one
    connection, and with it the host's 32-subscription and input budgets.
  - Frames cross two links: mini-2 to floco on AWS, then floco to the MacBook.
    That costs AWS egress for each viewer's stream and adds the VM's round
    trip to input.
  - A lagging relay drops H.264 until the next keyframe and asks the host to
    lower its bitrate (`hosted-congestion`).
  - A live tile of a remote hosted device opens only on demand, never for an
    Overview card.
- **Phase 0 measurement.** Phase 0 records relay frame latency (p50 and p90)
  and bitrate on this path in its PR. Acceptance is a viewer that stays live
  at the default frame rate for 60 s without a congestion drop. If it does
  not, Desktop lowers `fps` and `maxEdge` for remote hosted tiles.

## Linux and Windows servers (phase 0, critical path)

### What the code supports

The code does not gate the read path to macOS.

- `pair`, `serve` and every read handler have no platform guard.
- The systemd user backend exists.
- The LAN transport is platform-neutral.
- The server binds its Tailscale addresses directly, so `ws://100.x` works
  without `tailscale serve`.
- The client's relay of hosted frames runs before the local frame helper is
  used (`server.ts` `frames.subscribe`).

What degrades on Linux:

- Memory pressure and `memory.usedBytes` are null.
- Status runs `xcrun simctl`, which fails and reports `simctlAvailable: false`.
- There is no frame helper. Local Android emulator frames come from gRPC
  screenshots, and there are no recordings or replay. The server also retries
  building the helper and logs "frames come from screenshots" on every retry
  (`frame-helper.ts`, `server.ts`).
- Per-process footprints are null.

### On floco

I checked floco read-only on 2026-10-26.

- stim 1.29.0 is installed. `stim-server` is not installed, and none runs.
- The bot user has linger on (`loginctl show-user bot`: `Linger=yes`), and its
  systemd user manager runs at `/run/user/1001`.
- That user manager runs `openclaw-gateway.service` and
  `github-mentions.service`. These are the live bot.
- `systemctl --user` failed with "Failed to connect to bus" only because
  `sudo -iu bot` sets no `XDG_RUNTIME_DIR`. `stim-server service` already
  defaults it.
- Tailscale lists only floco, janics-mac-mini-2 and an offline
  janics-macbook-pro.

A separate QA run on floco checks the Linux read path with a test install.
This section takes its findings when they land. Until then, nothing here
claims the path was run on Linux.

### Setup

Phase 0 makes this work and documents it as **Serve Desktop and phones from
Linux**.

1. Install the server beside `stim`:
   `npm install --global --prefix ~/.local @stim-cli/server@<stim version>`.
2. Make sure linger is on. On floco it already is. Elsewhere, a person with
   sudo runs `sudo loginctl enable-linger <user>`, which `service install`
   prints.
3. Choose how clients reach the server:
   - `sudo tailscale set --operator=<user>` and
     `stim-server service install --serve` give a tailnet-only
     `wss://floco.<tailnet>.ts.net:7443`;
   - or skip the serve route and use the server's direct
     `ws://<tailnet IP>:7787`, which needs `pair` to print it (below).

   `service install` adds a `dev.stim.server` unit to the same user manager
   and reloads it. A reload does not restart other units, but it is the live
   bot's manager, so this step waits for the maintainer (Q2).

4. Run `stim-server pair` over SSH to print the payload. Pairing is not setup,
   so SSH is fine.

A system unit is not proposed. A user unit keeps the server and its Stim home
under the bot's account, beside the `stim` it serves.

### Code changes

Only what QA confirms:

- **`pair` endpoint.** On a host with no serve route, `pair` prints a
  reachable endpoint. It prints the tailnet IP endpoint and says why, instead
  of assuming `wss://<dns>:7443` when `tailscale serve status` fails without
  operator.
- **No simctl off macOS.** Status skips `xcrun simctl` off macOS instead of
  recording an error each time.
- **Frame helper.** The server stops retrying the frame helper off macOS.
- **Service status.** `stim-server service status` reports the pairing
  endpoint (`service.ts`).
- **Docs.** The website section above, and the server README.

`stim guide` topics do not change: pairing is a person's step on the server,
not an agent command.

### Windows

Windows is not on the critical path. The same read handlers run there, but
there is no Unix socket and no `ps` or `lsof`. Windows follows once a Windows
owner asks.

## Phone

The phone uses the same model.

- It pairs with each owning server itself, such as the MacBook and floco.
- It gets the same relay, which it already uses.
- It shows the same owner and where-it-runs labels.
- Nothing Desktop paired with appears on the phone, and nothing the phone
  paired with appears on Desktop.

The phone already does most of this. Its work is the where-it-runs label for
hosted devices and offloaded builds in the workspace list and build sheet. Its
drawer already names each machine.

### Pairing the phone from Desktop

Pairing the phone from Desktop is deferred to a later phase. The safe form
would work like this:

- Desktop asks each server it trusts for a fresh single-use phone pairing code
  and shows the codes as one list.
- Desktop never forwards its own key.
- The phone's scope is capped at Desktop's own.
- The server records which device minted each code, so revoking Desktop shows
  the phones it paired.

This needs a new capability to mint codes. It would also let a read pairing
create more read pairings, which a stolen Desktop key could repeat until it is
revoked. In practice, scanning one QR per owning server is two or three scans,
so this convenience does not justify widening trust in phase 1.

## UI

The UI follows `apps/desktop/README.md` and the current `Sidebar.swift`.

- **Sidebar.**
  - Overview, Active Workspaces, Machines and Builds stay pinned at the top.
  - The Projects tree is this Mac's.
  - Below it, each paired server gets its own section with its own tree, using
    the same rows, grouping and view options.
  - A section header shows the server's name, a connection dot and an access
    pill: **View Only**, or **View and Control** in the control phase.
  - A collapsed section shows its active count.
- **Overview and Active Workspaces.** These include remote active workspaces.
  Each remote card carries an owner chip, such as `floco`. Hosted devices keep
  "Running on <host>".
- **Machines.**
  - The selector adds each paired server after **This Mac** and the remote
    build Macs.
  - It shows that server's **Now** and capacity from `machine.subscribe` and
    `machine.details`.
  - Disk and **Free** stay This-Mac-only.
- **Workspace page.**
  - Status, Build, Logs and devices are read-only, with no action menus.
  - "Viewing floco · read-only" replaces the stage actions.
- **Settings.**
  - A **Paired Machines** tab holds **Pair with a Machine...**, each pairing's
    status, the server's fingerprint, **Reconnect** and **Forget...**.
  - The tab, the sheet and the per-server sections sit behind a new **Paired
    machines** feature flag, off by default until phase 1 ships.
- **States.** A section's dot and the row under its header show the
  connection state. They reuse the phone's refusal mapping (`connection.ts`
  `sessionRefusal`).

  | State                           | Shows                                                     |
  | ------------------------------- | --------------------------------------------------------- |
  | connecting                      | "Connecting"                                              |
  | unreachable                     | "Can't reach floco · retrying in 12 s"                    |
  | offline after being open        | "Offline · retrying", with stale data and "Offline since" |
  | expired or used pairing code    | "This pairing code expired or was already used"           |
  | revoked                         | "No longer paired. Pair again"                            |
  | server key changed              | "Server key changed"                                      |
  | protocol 1 or a missing feature | "Update stim-server on floco"                             |
  | newer protocol                  | "Update Stim Desktop"                                     |

## Control phase

Control gives a `--control` pairing the phone's control surface, through the
owning server:

- `action`, for Stop and Reload;
- `control.begin` with `input.*`, including hosted devices through the relay;
- `settings.get` and `recording.set`.

The UI turns on Stop, Reload and the viewer's Control toggle for that server's
rows.

These stay local-only, even with control:

- every `desktop.*` method: run, start, build, gc, worktree warm or remove,
  settings, doctor and reports;
- `route.setup`, `machines.update.*` and `device-host.sessions*`;
- pairing grants and revocations;
- approving build or device-host access;
- any native build or install started from Desktop on another machine. The
  phone cannot start one either. Starting work on another machine needs its
  own product decision;
- Disk, **Free** and Show in Finder.

## Architecture rule changes

PR C applies this `CLAUDE.md` wording, because it is the PR that first opens a
network connection from Desktop.

In the Desktop paragraph, replace "It connects to stim-server only over the
server's Unix socket, normally..." through "without pairing or Noise." with:

> It connects to its own Stim home's stim-server only over that server's Unix
> socket, normally `$STIM_HOME/server/local.sock`. [unchanged socket-path
> sentences] It may also pair, as a client, with another machine's stim-server,
> as the phone app does: it spends a `stim-server pair` token in protocol 2's
> Noise handshake, requires the payload's server-key fingerprint, and keeps its
> client private key and each pairing's pinned server key in the macOS Keychain,
> never under `$STIM_HOME`. The pinned key is the trust boundary; Desktop
> accepts only tailnet endpoints, and `stim-server pair` refuses a Funnel route.
> A remote server grants it only the capabilities recorded for its key: `read`,
> plus `control` for a `--control` pairing. `desktop.*`, `route.setup`,
> `machines.update.*` and `device-host.sessions*` stay Unix-socket-only.
> Desktop treats every remote message as untrusted input, never turns a remote
> path into a local file or process, and never stores another machine's
> workspace data on disk.

In "Machine-to-machine authentication", the sentence "Clients of this machine's
own user use the Unix socket, never a TCP connection" stays true, because a
remote Desktop is another machine's client. Add after it:

> A Stim Desktop paired with another machine's server is an ordinary paired
> device there.

"Hosted devices" is unchanged. Hosted sessions stay visible to other machines
only through their owning client's server.

## Phases

0. **Linux owning server (critical path).**
   - Run stim-server on the bot VM as a user service.
   - Fix what the floco QA finds.
   - Make `pair` print a reachable endpoint.
   - Write the docs.
   - Measure the relay path.
1. **Desktop pairs read-only.**
   - A Swift Noise client, remote input validation and a Keychain store.
   - The pairing sheet and Paired Machines settings.
   - Owner identity throughout, per-server sidebar sections and owner labels.
   - Remote entries on Machines.
   - Hosted devices and offloaded builds as their owning server reports them.
2. **Phone labels.** Where-it-runs labels for hosted devices and offloaded
   builds. This can ship alongside phase 1.
3. **Control.** A `--control` pairing gets Stop, Reload, device control
   (including hosted devices through the relay) and recording.
4. **Later.**
   - Pairing the phone from Desktop.
   - LAN `ws://` endpoints, as the phone accepts them. Decided 2026-10-26:
     they wait for this phase. Noise pins the key, so they are equally
     authenticated, but the maintainer's case is all tailnet.
   - Self-forget: a method that removes the caller's own record.
   - A server-side pull of hosted logs.
   - Windows owning servers.

## Implementation breakdown

Each row is one PR. **(critical)** marks the critical path.

| PR                                                        | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Depends on                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **A. Linux serving (critical)**                           | `packages/server/bin/stim-server.ts` (the `pair` endpoint off macOS), `packages/server/src/service.ts` (status prints the endpoint), `packages/server/src/frame-helper.ts` and `server.ts` (no helper retry off macOS), `packages/stim-cli/src/status-read.ts` and `devices/ios.ts` (skip simctl off macOS), `website/docs/remote-machines.md` and `packages/server/README.md` (serving from Linux), and tests in `packages/server/__tests__`                                                                                                                                                                                                                                                                                               | the floco QA findings; Q1 for reach |
| **B. Floco deployment (critical, ops)**                   | No repo files. Install the server, operator, service and pairing on floco, with the maintainer's approval at each step that changes the VM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A; Q1; Q2                           |
| **C. Desktop Noise client and Keychain (critical)**       | `apps/desktop/Sources/StimKit/Noise.swift`, `NoiseTransport.swift`, `PairedServerStore.swift` (Keychain plus an in-memory store), `PairingPayload.swift`, `ServerClient.swift` (endpoint kinds, checked ids), `ServerProtocol.swift` (Noise refusals), `StatusViews.swift` (checked sequence), Noise and malformed-message tests, a loopback interop test against a real server, the entitlements in `Support/` and `scripts/bundle.sh`, and the `CLAUDE.md` rule change                                                                                                                                                                                                                                                                    | none                                |
| **D. Desktop pairing UI (critical)**                      | `apps/desktop/Sources/StimDesktop/PairedServersModel.swift`, `Views/PairMachineSheet.swift`, `Views/PairedMachinesView.swift`, `Views/SettingsView.swift` (the tab), `FeatureFlagStore.swift` (the flag), `Views/PhonesView.swift` (renamed Paired Devices), `apps/desktop/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C                                   |
| **E. Desktop owner identity and remote views (critical)** | `StimKit/DeviceRef.swift` and workspace identity (the owner), `ServerSession.swift` (a client per server), `StimStores/StatusStore.swift` (a store keyed by server and path), `Views/Sidebar.swift`, `SidebarWorktreeRow.swift`, `SidebarRowDetails.swift`, `OverviewView.swift`, `WallView.swift`, `DeviceTile.swift`, `DeviceViewer.swift`, `DeviceViewerToolbar.swift`, `LogsView.swift`, `WorkspaceDiffView.swift`, `ReplayViews.swift`, `ArchivedReplay.swift`, `PhysicalDeviceScreen.swift`, `AgentFeed.swift`, `RootView.swift`, the workspace detail view, `MachineView.swift`, `MachineDetailView.swift`, `WorkspaceActionsMenu.swift` (hides actions for remote rows), the persisted-UI-state keys, and `website/docs/desktop.md` | D                                   |
| **F. Phone labels**                                       | `apps/mobile/src/lib/device-tile.ts`, `apps/mobile/src/lib/home-list.ts`, the workspace and build screens, `apps/mobile/mock-server/payloads.mjs` and fixtures (a hosted session and an offloaded build from a Linux owner), `apps/mobile/src/intl` and `locales`, `website/docs/phone-app.md`                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                |
| **G. Control from Desktop (phase 3)**                     | `Views/WorkspaceActionsMenu.swift`, `Views/DeviceViewerToolbar.swift` (the Control toggle), `StimKit/AgentActions.swift` (routes remote actions to that server's `action`), `settings.get` and `recording.set` for remote rows, docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | E                                   |

The critical path for the maintainer's case is A then B, running in parallel
with C then D then E. F runs alongside them, and G follows E. PR E is the
largest; it can split into identity (DeviceRef, ServerSession, StatusStore)
and views once identity lands.

## Test and verification plan

- **Unit tests, C and E.**
  - Swift Noise passes the core JSON vectors.
  - A loopback interop test pairs with a real `stim-server`, reconnects in
    returning mode, and refuses a wrong fingerprint before message 3 and a
    changed server key on reconnect.
  - The payload parser accepts both printed forms and refuses a missing
    fingerprint, a non-tailnet host, `v: 1` (update stim-server) and a later
    `v` (update Stim Desktop).
  - Malformed authenticated messages, such as an oversized reply id, a bad
    sequence number or a truncated frame, close the connection without
    trapping.
  - The in-memory store round-trips and Forget deletes the item.
  - A remote workspace exposes no action, and a remote path never reaches a
    file or process API.
  - A remote device with `host == nil` never resolves to a local simulator.
- **Server tests, A.** These run in the Linux CI job:
  - `pair` on a host without a serve route prints the tailnet IP endpoint;
  - status off macOS never calls `xcrun`.
- **Real pairing with Linux, B.** This runs on floco after the maintainer
  approves the VM changes.
  1. Run `stim-server service install`. `service status` shows linger and an
     endpoint.
  2. Run `stim-server pair` over SSH.
  3. Pair a Desktop test copy on janics-mac-mini, following the Desktop
     workflow rules. It uses the in-memory store. Pair the maintainer's phone
     too.
  4. The bot runs `stim ios --remote janics-mac-mini-2` in its own test
     worktree.
  5. Confirm on both clients:
     - the workspace appears under floco;
     - the build shows "building on janics-mac-mini-2" with its phase;
     - the hosted simulator streams through the relay, with latency and
       bitrate recorded against the acceptance above;
     - `devices revoke` on floco closes Desktop within about 2 s and shows "No
       longer paired";
     - mini-2's own Desktop lists the session only in its local "Hosted here".
  6. Run `stim stop` in the bot's test worktree.
- **Desktop screenshots on janics-mac-mini.** Use `stim macos --remote-build
janics-mac-mini --remote janics-mac-mini` and agent-device with the native
  backend. Capture:
  - the pairing sheet;
  - a floco section, connected and offline;
  - a hosted device row with the owner and where-it-runs labels;
  - Machines with floco selected;
  - Settings > Paired Machines.
- **Signed build.** Pair once with a signed build to confirm the
  data-protection keychain items. Delete the items afterwards.
- **Negative checks.**
  - Desktop refuses a `ws://` public IP.
  - A Funnel-routed server refuses `pair`.
  - Pairing the local server is refused, and Desktop shows the revoke command.
  - Every `desktop.*` method sent over Noise returns `forbidden`.

## Open decisions

Only these block implementation.

1. **How do the MacBook and the phone reach floco's server?**

   floco is only on the App & Flow tailnet. The MacBook and the phone are
   usually on the personal tailnet. The App & Flow rules let floco reach only
   mini-2:7443, and pairing needs inbound access to floco's serve port.

   **Recommendation:** share the floco node into the personal tailnet, as
   mini-2 is shared the other way. Add one App & Flow rule that allows the
   maintainer's identity to reach `tag:bot` on the serve port only. Tailscale
   rules are stateful, so floco gains no new outbound reach and the existing
   block stays. The phone gets the same reach without switching tailnets.

   The alternatives are weaker:
   - Keep the MacBook on the App & Flow tailnet. Being on one tailnet at a
     time loses the personal one.
   - Relay through a machine on both tailnets. That adds a hop and a trusted
     middle.

2. **May phase 0 add a stim-server user unit to the bot's user manager?**

   The bot account's user manager already runs `openclaw-gateway.service`, and
   linger is on. `stim-server service install` writes `dev.stim.server.service`
   and runs `systemctl --user daemon-reload`, then `enable` and `start` for that
   unit only. A reload restarts no other unit.

   **Recommendation:** yes, done by hand by the phase 0 agent with the
   maintainer watching. Stop if `openclaw-gateway.service` changes state.

## Related

- #3681 and `docs/specs/2026-10-13-pluggable-transports-design.md`, phase 3
  (Desktop on the generic transport status).
- #3546: the Desktop actions behind the local server stay local here.
- #2451: machine-aware links, which remote workspaces need to open from
  notifications.
- #2404: Linux workers.
- #4458: the LAN transport.
- #2750: the host's local "Hosted here".
