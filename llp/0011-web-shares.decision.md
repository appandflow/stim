# LLP 0011: Web share exposure and lifetime

**Type:** Decision
**Status:** Active
**Systems:** Web shares, Server, Transport
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0008, LLP 0010

## Public exposure belongs to share

`stim share` is the one path that enables Tailscale Funnel,
and only in tailscale exposure. `share.exposure` is `auto` (the default:
Funnel when the `tailscale` command is installed and logged in, else proxy),
`tailscale` or `proxy`. Proxy mode never runs `tailscale serve` or
`tailscale funnel`: the share listener binds `127.0.0.1` on the machine
setting `share.port` for the user's own reverse proxy, links print under
`share.publicUrl`, and the frame socket accepts exactly that URL's origin,
never Host or `X-Forwarded-*`.

A viewer outside the tailnet needs a public link to one device. Serving the viewer separately keeps public exposure scoped to the share and leaves the pairing and machine RPC listener private. A configured origin identifies the proxy’s public endpoint regardless of forwarded headers. [Public shares](https://github.com/appandflow/stim/pull/4806), [Proxy exposure](https://github.com/appandflow/stim/pull/4838).

## Persist the link and its expiry

The CLI asks this Stim home's stim-server through stimd's CLI socket
(`net.connect`, then `share.start|stop|list`, refused on every network connection); a share
lives only in that server's memory and always expires. Each share started
through `share.start`, by the CLI or by Stim Desktop, is saved by stim-server
as soon as it starts (the CLI saves it itself only when the server's reply
lacks `saved: true`, an older server), with its URL token and passwords, in the workspace's
`share-links.json` (mode 0600, written under the workspace state lock, removed
with the workspace, by `share stop --forget` and once expired) so that
`share ios|android --reuse` can start the same link again through
`share.start`'s `token` and `expiresAt`; stim-server writes this file only
through the CLI's own `saveShareLinkAsync` and `pauseShareLinks`, exported as
`stim/internal/share-links`, and an expired link is never extended or reused. A start
of a link the file already holds with the same passwords keeps the entry's
`auth`, `viewAuth` and `createdAt`, and the restore start does not pass
through the saving path, so it never rewrites the expiry. Each saved entry has a `state`:
`live` from when `share` starts or reuses it, `stopped` after a deliberate
`share stop`, `stim stop` or reclaim of its workspace. A restart or crash
leaves `live`, and a stim-server starts
every live, unexpired entry of its home again when it starts, through
`share.start`'s own path with the saved token or slug, passwords and expiry
(`@stim-cli/core/state`'s `readLiveShareLinks`); one whose device is not there
yet starts stopped, a refused one is logged and stays `live`; a net thread `stim share`
started restores them the same way (see below). `share.stop`
marks the entry stopped through the same module.

A restart can restore a live link created from either entry point. Deliberately stopped links remain available for explicit reuse, and restoring a link keeps its original expiry. [Reuse](https://github.com/appandflow/stim/pull/4975), [Server-side persistence](https://github.com/appandflow/stim/pull/5228).

A successful `stim share --reuse` replaces a restored share of the same link, target and access settings. It keeps the saved expiry unless `--expires` sets a new one. A new link ends a restored share for the same target once the new link is saved. This applies to full and share-only servers. [Restored share replacement](https://github.com/appandflow/stim/issues/5627).

## A share-only net thread resumes with stimd

A share started with no Desktop and no service lives in a share-only net thread
of stimd. That thread is resumable like any other work of stimd: a planned
handover (an engine switch) or a crash does not end the link. A stimd that
starts without `stim serve` or a service unit, and not bound to a command, starts a share-only
net thread (loopback only) when the home has a saved `live` share that has not
expired, or a share route claim whose holder is gone. The thread restores each
saved share with the same link, passwords and `expiresAt`, which re-arms its
expiry, and, in tailscale exposure, removes the Funnel route a dead server left
only while the serve config still holds exactly that route. A share that
expired while no stimd ran is not restored, and its route is removed the same
way. The thread ends once nothing is shared and the restore has settled. A stimd
that has no work of this kind starts no net thread, and nothing starts a stimd on
its own: the next command that starts one resumes the shares. A live share does
not hold an engine switch of stimd's own follower; the switch carries it by
restoring it in the successor. Restoring starts only shares `stim share` saved
and never touches a route Stim does not own. A restore never changes how a
share is exposed: it starts a saved share only when the exposure it would get
now is the kind and the address it was shared under (a proxy link under the
address proxy exposure serves now, a Funnel link under this node's Funnel host
and on the Funnel port it was shared on), and a saved entry that does not record
its address is not restored. The restore start carries the saved address and the
route checks it against the exposure it chooses to open, in the same step, so a
login or a setting that changes between the check and the opening refuses the
start instead of opening another exposure; a Funnel route is opened only on the
saved port, and the start is refused when that port is not free (the entry
stays saved and each later stimd tries again until it expires). No
`tailscale funnel` or `tailscale serve` command runs for a share saved under
proxy exposure. A share that cannot come back is not restored: a share-only
server marks it stopped, with one log line, and `stim share --reuse` starts it
again under the exposure of that day; a full server leaves its entry as it is.
While `auto` may still choose the other mode (Tailscale not up yet), the restore
waits and tries again, and leaves the entry saved when it gives up. Marking the
entry stopped means a later stimd does not start a thread for it; an entry of a
workspace that is not registered, which the registry cannot prove stale, is left
as it is and not counted either. A dead share route
claim starts a thread only while a tailscale command exists to remove its route.
The route claim path is
`shareRouteClaimRoot` in `@stim-cli/core/state`.

Maintainer decision: "another important consteaint of stimd is being resumable", 2026-11-12.
[Issue #5579](https://github.com/appandflow/stim/issues/5579).

Chosen by the lane that implemented [issue #5589](https://github.com/appandflow/stim/issues/5589), not by
the maintainer: restoring from saved state at boot instead of carrying serve
arguments (one path serves a handover and a crash), no hold of the follower's
engine switch by a share, a stimd of another build still held by live shares as
before, and no stimd started by a saved share alone.

## A temporary device gap pauses the share

A share outlives its
device: when the device goes away on its own (frames fail, the device or hosted
session changes or is not ready) the share shows as stopped, keeping its token,
passwords, viewer sessions and expiry, and comes back on the slot's device when
it is there; rows and the protocol carry no separate state for it. Only
`share.stop` (which `stim stop`, `stim worktree remove` and Desktop's Stop
send), expiry, server shutdown and a present, ready device that fails to
stream for 5 minutes in a row while a viewer is attached end the running share.
An explicit stop or that terminal stream failure marks the saved link stopped.
Server shutdown preserves the saved state so a live, unexpired link can be
restored. Viewers receive a fixed reason because raw errors can name
workspaces. `share --reuse` with no saved link starts a new share and warns.

Hosted installs close the frame stream during every rebuild. Ending the link on stream failure forced the owner to send a new link and password after an ordinary deploy. The stopped view keeps the same access while the slot gets its device back. [Share resume](https://github.com/appandflow/stim/pull/4970), [Terminal failure policy](https://github.com/appandflow/stim/pull/5155).

## Viewer permissions stay on the server

The server serves
shares on a separate loopback listener, not the Noise protocol: per share
the viewer page, the frames of its one device and, with control, input to
that device through `ControlHub` (on a simulator, emulator or Android phone that includes
its clipboard: a viewer's paste, and the viewer's own sync or copy of the device's text, never logged; a sync poll
never starts a control session or keeps one alive), behind a 256-bit URL token, a generated
password and an HttpOnly Secure SameSite=Strict session cookie. A control
share can also have a second, view-only password (`--view-password`): login
compares both digests, always both, with `timingSafeEqual`; the cookie stays an
opaque token and its access (`control` or `view`) and optional name live only
in server memory; the server drops every input from a `view` session, and a
`view` session can be raised, never lowered, by the control password. The
share socket also carries presence (each viewer's name and touches) from
`ControlHub`'s pointer grab and `PresenceHub`; names are cleaned and are
never logged or written to disk.

A single link can admit observers and controllers. The server checks the session’s permission for every input so viewer-side behavior cannot grant control. [View-only access and presence](https://github.com/appandflow/stim/pull/4909).

## Own the route and capture only on demand

In tailscale mode it adds one
Funnel route, a whole Funnel port that nothing else uses, proxied to that
listener, under an ownership claim at `server/share-route`, and removes it
with the last share, and after a crash on the next start, only while the
serve config still holds exactly that route. A share never starts the
recorder or capture before a signed-in viewer connects. The viewer's
stylesheet and its scripts are fixed bundled files served without a token
under `/s/assets/`; they carry no share data. In proxy mode with
`share.publicUrl` set, a stim-server installed with `stim service`
keeps the listener bound with no share and answers every request that is not
a live share's with the fixed not-found page (404, no share data, nothing
kept about an ended share); a net thread `stim share` started and tailscale
exposure never keep a listener.

The route claim prevents cleanup from removing a port the user has since repurposed. Delaying capture until login avoids reserving a frame stream for an unwatched link. [Route and capture ownership](https://github.com/appandflow/stim/pull/4806).

## Hosted shares use the client’s grant

A workspace whose
device is a hosted session is shared through this client's own device-host
connection (one host frame subscription per codec for all viewers, control through
`device-host.control.begin` and `device-host.input.*`); the worker sees only
that ordinary view and control traffic and gains no capability. The share's
viewers, their touches and the pointer grab stay in this machine's
stim-server, which forwards only the touches the grab admits. The client owns
the public link and arbitrates viewer input. The worker sees only the
approved client's existing hosted-device operations. [Hosted ownership](./0010-hosted-devices.decision.md#hosting-does-not-transfer-workspace-ownership).

## Link secrets and on-demand server

The password is
generated by default, set with `--password`, or dropped with
`--no-password`, which leaves the URL token as the only secret;
`--slug` puts a chosen name in the path in place of the token, so the password
is then the only secret and it refuses `--no-password`; a slug a live share
holds is refused, never taken over;
`--view-password` refuses without `--control`, with `--no-password` and when
it equals `--password`. When no
net thread answers, `stim share` asks this home's stimd, started when none
runs, to start one for shares (`net.ensure` with `share`: loopback only); that
net thread ends after its last share unless Desktop, `stim pair` or
`stim serve` asked for it meanwhile. stimd stays running while its net
thread runs.

A chosen slug is public enough to guess, so it needs a password. The share transport uses WebSocket. The former WebRTC path helped only on private links and its measured tail latency and dependency cost outweighed the median gain. [Share secrets](https://github.com/appandflow/stim/pull/4806), [WebRTC removal](https://github.com/appandflow/stim/pull/5252).

Maintainer decision: "Lets remove and keep stats panel", 2026-11-05.
[Issue #5250](https://github.com/appandflow/stim/issues/5250).

## Code

- [Boot trigger and successor](../packages/stim-cli/src/stimd/main.ts) (`shareWorkPending`).
- [Viewer sessions](../packages/server/src/share.ts), [password permissions](../packages/server/src/share-identity.ts), and [route claim](../packages/server/src/share-route.ts).
- [Local share RPCs](../packages/server/src/handlers/share.ts), [saved-link restoration](../packages/server/src/share-restore.ts), and [CLI reuse](../packages/stim-cli/src/commands/share.ts).
