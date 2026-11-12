# LLP 0010: Hosted runtime ownership and connections

**Type:** Decision
**Status:** Active
**Systems:** Hosted devices, Server, Devices, Metro
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0008, LLP 0009, LLP 0013

## Hosting does not transfer workspace ownership

`device-host` approval is separate from read, control and
build, and permits the client's native app code in its own hosted simulator, emulator or macOS app session.
A person on the worker approves it by running `stim setup` there with
the requesting machine's setup ticket: the key holding one ticket, once per
capability, until one expiry, with a per-grant Y/n confirmation (Enter approves) in a terminal (`--yes`
otherwise), or in Stim Desktop on the worker under the same rules, as [LLP 0009](./0009-build-offload.decision.md#worker-side-approval) describes. An SSH-driven run is not offered. Setup never changes TCC or
enables Funnel; the person approves normal macOS permission prompts.

A remote worker runs the device for the requesting workspace. Pairing Desktop or a phone with the worker is a separate way to view work that the worker itself owns. Keeping approval separate prevents device placement from granting ordinary read or control access. [Owning servers design](https://github.com/appandflow/stim/pull/4489), [Worker approval](https://github.com/appandflow/stim/pull/5120).

## Resume the recorded session

The server owns its opaque journal under `server/device-host-sessions/` and
app receipts under `device-host/sessions/<id>/apps/`; core owns the readers. A hosted native worker
uses a server-chosen private home under `device-host/sessions/` and the CLI's
existing created-device ledger, ownership checks and centralized teardown.
Parked hosted devices stay ledger-owned in their session home. The same client
can adopt a compatible device. A hosted reserve occurs before app selection,
so adoption removes every third-party app. iOS adoption also resets privacy
grants and the keychain. [Hosted parking and adoption](https://github.com/appandflow/stim/pull/2755).

Keep a child-aware ownership claim across native work and a claim for the
session lifetime. Server close leaves a ready iOS or Android session ready
and its device booted when no native work is in flight, and the next server
resumes it only after taking its exclusive claim (a live child keeps it held)
and the worker's `resume` verifies the exact ledger-owned, recorded, running
device; anything unproven takes the stop path, and macOS apps always do. Serialize hosted admission, including unresolved sessions;
ordinary local producers do not participate, so it is not a machine-wide hard
capacity guarantee. Reconnect to the recorded attempt/session after a lost
reply. Unknown creation, journal, owner or shutdown state refuses replacement;
never identify a device by name or guess an empty inventory. Stop and
revocation touch only that client's recorded owned device.
The host's person lists and stops sessions through
`device-host.sessions` and `device-host.sessions.stop` on Desktop's Unix
socket connection; person-side stop uses the existing stop path.

Stopping a ready simulator at every server update interrupted the client’s Metro, agent and share connections. The persisted session and exclusive claim let the server resume the same device. Refusal on unknown ownership keeps two attempts from adopting or stopping one device. [Session resume](https://github.com/appandflow/stim/pull/4990), [Updates with live hosted sessions](https://github.com/appandflow/stim/pull/4992).

## The client opens every bridge

A session's Metro endpoint listens only on worker loopback. The worker never
connects to the client: each accepted connection rides one idle
`device-host.metro.link` connection the session's own client opened and
authenticated, and the client forwards it only to its verified loopback Metro.
Stop and revocation close the bridge, idle links and active streams. Keep the
recorded worker port on reconnect; refuse an occupied port. Reverse ports
(`stim ports reverse`, `device-host.reverse.set`) use the same transport and
rules for the workspace's own servers: one worker bridge per reversed client
port, listening only on worker loopback, never connecting to the client. A
simulator shares the host's loopback, so its bridge listens on the same port
number and an occupied port is refused; an emulator's bridge listens on a
loopback port of the host's choosing and the exact owned emulator's
`adb reverse` targets it. The client's Metro supervisor opens the links, each
registered for one port taken from the workspace's record; the host pairs a
link only with that port's bridge, and the client forwards it only to its own
loopback on that port, so the host cannot name a client port. The session
record keeps the bridge ports for resume, and parking, stop and revocation
drop them. `device-host` approval is enough; it widens nothing else. Agent control of a
session on a `local:` machine rides `device-host.agent.link` connections its
own client opened and authenticated, which the client's supervisor feeds from
a loopback port; the host serves only that client's session and still checks
the session's agent token on every request.

Hosted Metro and reverse ports must work from clients that cannot accept inbound connections, such as cloud sandboxes and clients reaching a shared Tailscale machine. Port registration also prevents the worker from requesting an arbitrary service on the client. [Client-opened Metro](https://github.com/appandflow/stim/pull/4451), [Hosted reverse ports](https://github.com/appandflow/stim/pull/5091).

## Verify install and launch

App transfer uses bounded digest chunks, including the manifest itself. The
worker validates content, contained links, simulator platform, architecture
and minimum OS before installing on the exact ledger-owned device. Hold the
session's child claim across installation and launch, and reconcile a repeated
app attempt without launching it again. Development launch remains unverified
until the client's Metro bridge provides bundle evidence; a release launch
needs positive native process evidence for true.

An interrupted upload or lost install reply must not admit a partial app or launch it twice. Launch evidence belongs to the exact session and app attempt. [Hosted native lifecycle](https://github.com/appandflow/stim/pull/3177).

## Capture and input stay with the session

Hosted view and input require a ready session and its held claim. Re-prove the
exact ledger-owned iOS simulator, Android emulator or macOS app before granting
access. Track the capture helper as a child of the session claim. Give native
posture input its own core child-aware claim
and refuse restarted ownership or native work while that input is live or
unresolved. Close capture and control before installation or
native teardown. Wait for native input still running after disconnect or
takeover, including termination of timed-out children. Revocation and server close end known transports even when
the journal cannot be read or written; retain unresolved native claims.
The host follows a session's agent-device records and sends the agent's
actions as presence (`device-host.presence.subscribe`) only to the client that
owns the session; the client keeps only agent participants from it.
Hosting approval never widens ordinary workspace read or phone control.

An old capture helper or input child can outlive a connection. Holding the same device’s claims across capture, installation and teardown prevents it from acting on a replacement. [iOS control](https://github.com/appandflow/stim/pull/2359), [Android control](https://github.com/appandflow/stim/pull/2721), [macOS control](https://github.com/appandflow/stim/pull/2485), [Recorder cleanup](https://github.com/appandflow/stim/pull/5031).

## Code

- [Session admission, resume and teardown](../packages/server/src/device-host.ts), [capture and input](../packages/server/src/hosted-view.ts).
- [Bridge RPCs](../packages/server/src/handlers/device-host.ts), [Metro forwarding](../packages/stim-cli/src/device-host/metro-request.ts), and [native worker](../packages/stim-cli/src/device-host/worker.ts).
