# LLP 0018: Children that must outlive stimd have their own parent

**Type:** Decision
**Status:** Active
**Systems:** Stimd, Metro, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0016, LLP 0017

## Which children stimd may own

stimd restarts: it crashes, updates in place, switches engine and idle-exits. A
process learns a child's exit status only by waiting on it as its parent, and a
pipe it reads ends when it does. So a child belongs to stimd only when a stimd
restart can drop it unnoticed: a pass, a measure, a fingerprint check, a probe.
A child whose exit code and complete output matter, and that must keep running
across a stimd restart, gets a small per-workspace helper process as its parent,
not stimd. Today that is the macOS app (`macos-run`, LLP 0017); planned are the
dev server (below) and the physical iPhone console (another issue). stimd stays
the coordinator of such a child: it starts and stops it, holds its claim, and
finds a running helper again by that claim and the helper's verified process
identity, never by name. Each helper costs one Node process while its child runs.
A new design that adds a long-lived child to stimd says which side of this rule
the child is on.

## Maintainer decisions

Maintainer decision: "i think supervisors might still be needed to allow stimd restarting? I think we need to keep this in mind for future designs", 2026-11-12.

Maintainer decision: "Bring back helper for both and fix 3 to 6 in stimd", 2026-11-12. "Both" is the dev server and the physical iPhone console; items 3 to 6 of the regression audit are stimd log fixes another issue covers.

Maintainer decision: "if we're regressing on func i don't mind keeping the extra processes if it makes things simpler and more robust", 2026-11-12 (LLP 0017).

The maintainer said these to the coordinating session, which relayed them; #5571
quotes them (https://github.com/appandflow/stim/issues/5571#issuecomment-6834430648). The general rule above and the design below were written by the
implementing agent from those words; nothing else in them is the maintainer's.

## Planned: the dev server's helper (#5571)

Why: an adopted dev server loses its exit code ("exit code unknown" after every
stimd restart), output written between a crashed stimd's last read and adoption
is never recorded, and the tail stops at the leader's exit although group
members still write (audit A1, A3).

**Process tree.** stimd spawns `metro-run` (new entry `dist/metro-run.mjs`,
`src/stimd/metro/run.ts`), which spawns the dev server with piped stdout and
stderr. The helper's child per mode: Expo, `node_modules/.bin/expo start` (on
Windows, Stim's node running the bin); `metro.command`, the command's program;
bare React Native, `node <build>/injected/metro-host.cjs` (a separate process,
not in the helper's own, so a Metro crash cannot take the record with it);
Re.Pack, the Rock or React Native CLI bin. stimd keeps building the fixed
invocation (invariant 3) in `server-expo.ts`, `server-command.ts`,
`server-repack.ts` and `spawnHost`; their existing `spawnFn` seam launches the
helper with that argv after `--`, the cwd, and the env as the helper's own env,
which it passes on unchanged. No env reaches disk. The helper opens the pipes,
and the dev server's identity comes from the handshake, not from the spawned
process's pid. The managed tunnel stays a
stimd child (LLP 0016); it should follow later, since its exit code matters less
than Metro's but it shares the Windows hold.

**Detaching.** The helper starts `detached: true` (its own process group and
session on POSIX) with stdio `ignore`, `metro-run.log`, `metro-run.log`, `ipc`;
stimd `unref`s it. On POSIX the dev server leads its own group as today, so a
group signal to it never reaches the helper.

**Claim and liveness.** stimd keeps `metro.claim` exactly as today: owner stimd,
details as today plus `helper: {pid, processToken, protocol: 1}`. The child stays
pending (`{"record":null}`, never recovered, LLP 0007) until the helper reports
the dev server, which then becomes the child. The dev server stays the claim
child, so `retake()`, the claim checks in `stopMetroTree` (`daemon/client.ts`)
and a rolled-back build keep working. stimd judges the dev server running while
the helper's identity reads `same`; the helper exits only after its child's
group is gone and the exit is on disk. A helper whose identity reads neither
`same` nor `gone` is a `STIM_CLAIM_UNAVAILABLE` refusal naming `metro.claim` and
its remove command. The helper holds no claim of its own.

**Protocol.**

- Startup over IPC, the `macos-run` handshake: the helper sends `registered`
  with the dev server's `{pid, processToken}`; stimd checks that identity, sets
  it as claim child, writes `helper` into the details and answers `accept`; the
  helper disconnects. A disconnect before `accept` makes the helper stop its
  child and exit.
- Output: the helper appends raw chunks to `metro.stdout.log` and
  `metro.stderr.log` (emptied by stimd at spawn; `start` quotes the stderr tail
  and the guides name both) and turns lines into `metro.ndjson` records with
  today's `outputRecord(mode)` parsers, Re.Pack's included. It writes the Expo
  tunnel URL into workspace state under the same lock and token check stimd uses
  today, its only state write.
- Exit: at the leader's `exit` the helper keeps the code or signal and reads on
  until both pipes close, or until the group is proven gone plus 1 s. It then
  writes `metro-run.exit.json` (`{pid, processToken, code, signal, exitedAt}`,
  atomic, workspace dir) and exits. stimd settles that file at boot, on every
  tick and before `start` spawns: it scans the workspace directories of the
  registered projects for the file itself, since a claim whose owner and child
  are both gone is no longer live and adoption never sees it. A file whose
  `{pid, processToken}` matches the recorded `supervisor` gets the one
  `supervisor_stopped` line and the stop record through today's
  `forgetExited`; a file that matches nothing gets a warn line naming the pid and
  code. Either way stimd then deletes it. Core's stop-cause reader reads a
  matching file before it calls a supervisor vanished, so `status` shows the
  code even before stimd settles it. stimd stays
  the only writer of `supervisor_stopped` and of the stop cause, which it reads
  from the stop request in workspace state as today.
- Readiness and heartbeat: unchanged. The heartbeat carries the dev server's pid,
  and stimd probes the port.
- Stop: stimd checks the helper's identity and sends SIGTERM to that exact pid
  in one synchronous function. The helper stops the group (identity check, SIGTERM,
  5 s, SIGKILL, 1 s), writes the exit file and exits. stimd waits for the helper
  to go. When it does not, or it went while the group lives, stimd stops the group
  itself through the claim child as it stops an adopted child today; an unproven
  end is today's `STIM_CLAIM_UNAVAILABLE` refusal naming `metro.claim` and its
  remove command. `metro.stop` answers only after the helper is gone, so
  `reclaim`, which stops through `stopMetroTree`, removes no workspace directory
  the helper still writes.

**Events.**

- stimd crash, in-place update, engine switch: the helper keeps recording. The
  successor retakes `metro.claim` (owner gone, child live) and verifies the
  helper from the details; there is no tail and no offset handover. An exit while
  no stimd runs waits in the exit file. The helper runs from its build's engine
  directory, which `metroEngineDirs` keeps retained through the claim's
  `engineDir`. A helper of an unknown `protocol` is restarted at the workspace's
  next idle point by the C6 path.
- Idle exit: stimd still does not idle-exit while it supervises a dev server,
  because idle stop, the C6 restart, hosted links and watch roots run in its
  tick. If it ends anyway, it is the crash case.
- Helper crash: the dev server likely dies of EPIPE on its next write. stimd sees
  the helper gone with no exit file, stops the group by the claim child's
  identity, logs at error that the helper ended without recording the exit, and
  starts Metro at the next ensure. Output after the crash is lost.
- Dev server crash: the exit file carries the code; `status` shows it as today.
- Machine reboot: claim owner and child are gone, so the claim is recovered; with
  no exit file the stop is today's "gone and recorded no cause".
- A helper killed before it reports its dev server leaves the claim child
  pending: the claim stays held and refuses with its remove command, as a
  pending child does today.

**Windows.** Not checked. The untested assumption is that a detached helper
outlives stimd and that its non-detached dev server ends with it. Until a
`ci-full` run of the new integration test
(stimd exits, helper and dev server keep running, the successor stops them)
passes on Windows, Windows keeps stopping dev servers at stimd's exit and the
`heldBy: "dev-servers"` hold. Two Stim builds on one home (audit A6) are unchanged.

**Contracts.** `status --json` `supervisor` keeps its shape and meaning:
`supervisor.pid` stays the dev server's pid, which the heartbeat, `metro.stop`,
`resolveProjectMetro`, `reclaim`, `machine-usage.ts:151` and Desktop
(`Resources.swift:62`) use. The helper's own memory therefore falls outside the
workspace's measured process tree. Stdout of `start` and `stop`, error codes and
`launched` do not change. `guide metro` changes where it says stimd parses the
output.

**Migration.** A claim without `helper` is a dev server a pre-helper stimd
started: adopted as today (file tail, exit code unknown) and restarted at its
workspace's next idle point. That branch is a marked compat row, the next free
one (C30 when written), ending in 2.1.0. A rollback to a pre-helper build adopts
the claim as today and tails the raw files the helper still writes, at a known
cost: every line lands in `metro.ndjson` twice (the helper's and the tail's),
the exit settles as unknown, and the exit file stays until a helper-aware stimd
finds it matching nothing.

**Pull requests.** (1) The helper for all four modes on POSIX: `run.ts`,
`spawn-entry.ts`, `tsdown.config.ts`, `children.ts`, `child-server.ts`, the
three `server-*.ts` files, `stop-cause.ts` and its core reader, `guide/metro.ts`, `compat-budget.json`, this document
and the `llp/0000` index, and tests extended in
`stimd-metro-adopt-identity.integration.test.ts` (exit code and complete output
across a killed stimd, a leader that exits while its group writes) and
`supervisor-repack.test.ts`. (2) Windows, after the `ci-full` evidence: drop
Metro from `metroRootsEndingWithStimd` and the hold.

Not determined: Windows behaviour; how long a group member that holds the pipe
open can keep a helper alive (the 1 s bound applies only once the group is gone,
and a descendant outside the group is not seen); whether a `NODE_OPTIONS` meant
for the project, which the helper inherits as 1.40's supervisor did, matters.

## Code

- `packages/stim-cli/src/stimd/metro/children.ts`: spawn, adoption, stop and settle of dev servers.
- `packages/stim-cli/src/macos/run.ts`: the helper this rule already applies to.
