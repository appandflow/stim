import { WATCHMAN_NESTED_WORKTREES } from '../diagnostics/doctor-watchman.ts';
import type { GuideTopic } from './types.ts';

const cleanup: GuideTopic = {
  summary: 'Where simulators come from, and how they get reclaimed',
  preamble: () => `DEVICE SLOTS

Cleanup enumerates every slot. stop --slot <name> keeps the shared server and
other slots; plain stop and worktree remove handle the whole workspace.
An upgrade retains existing device assignments as the default slot. Do not
wipe state to upgrade: it records ownership needed for safe teardown. Use the
same slot-aware CLI for all commands while named assignments exist; older
versions cannot reliably manage their assignments.

ARCHIVE

Worktree removal and gc dead-project pruning keep history under
$STIM_HOME/archive by default. See stim guide cleanup archive.

MAINTENANCE

Automatic maintenance follows daemon.mode (guide settings): on (the default)
runs the disk actions below through gc's own removal code and logs each one;
report measures, plans and logs, and never deletes anything; off disables it,
with the idle and dormant stages and the pressure ladder. It is off in CI
unless STIM_DAEMON is set, so a CI run never deletes on its own. A scoped
STIM_HOME home runs it like any other.
The stim-daemon runs a pass in its own process on each tick when a check is
due: a disk and memory reading for status (every minute), hosted idle stops
(every 5 minutes), directory sizes (hourly), finished worktrees (every 15
minutes) and the age sweep (daily). The reading plans nothing, the idle check
plans only idle stops, and the cap trims follow the size, worktree and sweep
checks. Pressure itself is the daemon's: each tick
classifies the machine normal, high or critical and runs the pressure ladder
above normal (stim guide lifecycle budget). While no daemon holds the home
(when it cannot start), stim doctor runs the same
maintenance pass in its own process, and start, ios and android run it, the
idle stage for owned devices whose workspace has no running dev server, and the
pressure ladder from rung 2 before they build; no other command starts one, and
with daemon.mode off none runs. gc --dry-run prints what an acting gc would
delete at the measured level, or at the --pressure level.
Size, idle, worktree and sweep checks wait while the one-minute load is above 4
per core. Measured directories are workspace build outputs and Stim's
shared native, Metro, ccache, Swift compilation and registered caches. The size
check also records the disk of each owned and parked simulator and emulator
(category owned-devices); status prints the total as "owned devices".
Pressure checks read free disk on the Stim home, projects and worker root
volumes. On macOS the memory signal is the sysctl pressure level, with no
signal if sysctl fails. Other platforms use os.freemem(); macOS never falls
back to it. Idle devices and dev servers of a workspace with no hosted device
are the daemon's activity pass (guide metro), and memory pressure its ladder,
not a maintenance check; the idle check stops only a workspace whose device is
hosted on a remote Mac (IDLE STOP). While the level is warning or critical, the
check also names abnormally large processes (guide lifecycle simslim) in
status's maintenance block and the cleanup log.

IDLE STOP: the idle check, while daemon.mode is on, stops a workspace whose
device is hosted on a remote Mac once it has had no real activity for
maintenance.idleStopHours (default 6; 0 never; machine or project
layers; STIM_MAINTENANCE_IDLE_STOP_HOURS overrides; fractions work); gc neither
runs nor lists these stops. Every other workspace follows
the daemon's idle stage at idle.minutes (guide metro) instead. Six hours
outlasts a lunch break, a meeting or an agent's pause between tasks, and still
frees the memory overnight. Real activity is the newest of: a Stim command in
the workspace (start, ios, android, macos, web, reload, revive, logs, worktree warm),
the end of its last native build, the start, progress or end of a Metro
bundle or manifest request, or an HMR update, in metro.ndjson, an agent-device command in the workspace's
agent-device sessions, input stim-server forwarded to its device, and
recent keyboard or mouse input while its simulator or emulator window is
frontmost (guide metro).
Device and system log lines, in-app console logs, dev server output,
collector writes and maintenance's own records never count, and an app that
only stays connected does not either. The stop is stim stop's: the dev
server stops, the owned devices shut down through centralized teardown
(never deleted), and the port is released; device leases stay. A build, a
held native-run or metro-start lock, a build lock or slot, a running macOS
app, a remote (EAS) session, an unexpired device lease, a managed tunnel
or remote lock, a running owned Chrome, a live web share (guide share), a
device driver other than agent-device, a live agent-device claim, lease or runner whose last command cannot be dated (one dated and older than 10 minutes under pressure, or the idle threshold otherwise, does not keep it; a runner lease with no runnerLogPath or no events.ndjson cannot be dated, and the keep reason says so),
device activity, an emulator list or an emulator's AVD name that cannot be read keeps
the workspace;
the check decides again under the native-run and metro-start locks. Each stop
is a gc_item record naming the idle time, each workspace kept past
the window a maintenance_skip line with the reason. The port is released, so
status shows the workspace idle as after stim stop, and the supervisor_stopped
line in metro.ndjson names the idle time and the requester, automatic
maintenance. The next start, ios or android starts it
again. An owned emulator the activity check missed keeps the workspace while
adb lists it, and so does any emulator adb lists without an AVD name, such as
a stale offline entry that adb kill-server clears. A workspace whose iOS, Android or macOS device is hosted on a remote Mac is
stopped the same way once the host confirms the session is ready; stim stop's
hosted path ends the session and the host parks or tears down the device. A host
that does not answer, a session it cannot confirm (unknown, as after a worker
crash) and a placement that cannot be read keep the workspace, and a live view of
the hosted device is not seen here. On the host, stim-server stops a ready session
whose client has had no connection, live stream or Metro link and sent no
agent-device request for the host's own machine maintenance.idleStopHours (default 6; 0
never; STIM_MAINTENANCE_IDLE_STOP_HOURS overrides), only while its daemon.mode is on;
a project value or maintenance.keep on the client does not reach it. Server downtime is not
counted. It uses the stop a person uses, never touches a session whose journal state is
preparing, stopping or unknown, or one with a native operation or a claim it cannot prove free
(a session a crashed server left ready counts once its claim is proven free),
and writes the reason to the server log and the session's idleStop journal field.
The count is per client, not per session. A dev server that may still run after its supervisor
exited is kept until stim stop ends it. So is a dev server whose requests Stim
does not record: an Expo project before SDK 54, which cannot load Stim's Metro config
adapter, or a dev server an older Stim started, until stim stop and stim start
restart it. A pass the stim-daemon runs can stop any workspace; a pass that
start, ios or android runs never stops the command's own workspace, while
\`gc\`'s ladder can (THE PRESSURE LADDER).
A dev server run through metro.command is kept: Stim sees none of its
bundle or HMR requests. A Metro log that cannot be read, or that rotated
within the window, and agent-device sessions, a state.json or a stim-server
viewer record that cannot be read or verified keep the workspace too. A STIM_HOME-scoped home never
idle-stops, because its devices are machine-wide. maintenance.keep does not keep a workspace from idle
stop, which deletes nothing; set maintenance.idleStopHours 0 at workspace
scope instead.
  stim settings set maintenance.idleStopHours 1 --scope machine

In on mode a pass runs, cheapest to rebuild first:
  1. orphaned workspace directories whose project is gone, and registered
     caches whose directory no longer exists
  2. build outputs of idle workspaces, over maintenance.workspaceOutputsMaxGb,
     or unused for maintenance.olderThanDays; the Cargo target/ of an Exact
     app or a Cargo workspace root (CACHEDIR.TAG), in a registered workspace or
     a discovered checkout, in use or not, over maintenance.cargoTargetMaxGb
     (default 25, 0 no cap; one du walk per target/, at most 6 discovered
     ones per size scan, the least recently measured first, so every one is
     reached within a few scans; one that times out
     records no size, only its stale profiles are trimmed, and it is reported
     as needing a person). Only directories with Cargo's profile shape
     (.fingerprint) are profiles; other directories in target/, and a nested
     target/ inside it, are never removed, though they count in its size. A
     target triple directory holding anything besides Cargo's CACHEDIR.TAG and
     .rustc_info.json and its profiles keeps those files and loses only its
     stale profiles: first the profiles and target triples no build wrote in the last
     day (directory times and Exact's own .exact-sweep.json ledger; reads leave
     no trace on APFS), then, if still over, the incremental/ directory of each
     remaining profile, largest first, until under the cap. Without Exact's
     ledger, a build that changes nothing leaves no trace in a profile's
     directory times. Each is renamed
     into target/.stim-trimmed after a check, checked again at its new path,
     moved back if a build took one of the profile's lock files (.cargo-lock,
     .cargo-build-lock, .cargo-artifact-lock) meanwhile, then deleted; a
     leftover .stim-trimmed is deleted first. A profile whose lock file a
     build holds, and any path a process executes from or holds open (one lsof
     and one ps read; unreadable keeps everything), stay, so a server running
     from target/exact-filesystem-tool does not protect the rest
  3. build-cache and Metro entries, least recently used first, down to
     80% of caches.buildCacheMaxGb or
     caches.metroCacheMaxGb, and entries unused for olderThanDays
  4. the Swift compilation cache, emptied whole once it is over
     caches.swiftCompilationCacheMaxGb (default 0, no cap), whatever the free
     disk, and kept while an iOS build holds its shared
     claim (taken for each xcodebuild run that compiles with it) or that
     claim is unresolved; the emptying holds the exclusive claim
  5. linked worktrees whose branch or pull request finished (gc's finished
     worktree rules and gc.worktreeGraceMinutes; maintenance.removeFinishedWorktrees),
     a dirty finished one after archiving its uncommitted files (ARCHIVED
     CHANGES in stim guide cleanup gc), clean ones with no commits of their
     own (NO COMMITS OF ITS OWN there), and, with
     maintenance.removeIdleWorktrees (off by default), in the age
     sweep clean, pushed ones unused for olderThanDays, git-ignored files
     included; never
     an unfinished dirty one, one with unpushed commits, the source checkout,
     a locked one, or one whose last use is unknown
  6. parked simulators and emulators unused for olderThanDays in the age
     sweep, through centralized teardown with ownership checked again
  7. owned simulators and emulators of a finished worktree that is kept, such
     as a dirty one (not one locked with git worktree lock), once it finished
     and was idle for gc.worktreeGraceMinutes (at least protectRecentHours),
     and not while a web share of it is live (guide share), checked again
     under its native-run claim. Devices are recreated on the next run. A
     workspace without activity for idle.dormantDays (1) is reduced to its
     minimal size instead, by this pass's companion, the dormant stage (stim
     guide lifecycle budget): build outputs, owned devices, logs archived and,
     in a linked worktree, node_modules and ios/Pods.
  8. the age sweep also runs pressure ladder rung 6: idle Gradle and Kotlin
     daemons, an unused watchman over 2 GiB (\`guide cleanup memory\`), unpinned Gradle versions unmodified for
     maintenance.gradleVersionIdleDays, Stim TMPDIR leftovers unmodified for 24
     hours, and the worktree trash.
  9. the age sweep also prunes what outlived the thing it describes, by the
     rules gc applies: status cache files (disk-usage, pull-request,
     git-merge) of folders and worktrees that are provably gone, process lock
     directories that hold no claim, expired device lease files, and archives
     past the archive.* retention (guide settings). A lease whose workspace is
     pinned with maintenance.keep or in use stays; so does anything Stim cannot
     show stale, each logged as a kept record with its reason. These steps
     run whatever maintenance.olderThanDays is; maintenance.sweepHours 0 turns
     them off with the rest of the sweep.
  10. unused iOS simulator runtimes, deleted through \`xcrun simctl runtime
     delete <identifier>\` only when simctl marks the image deletable and no
     simulator on the machine, user-created ones included, uses it; the only
     installed runtime is never deleted, and when no runtime is used the
     newest stays. Also kept: a runtime a project's ios.runtime pins, every
     runtime with the major version of the active Xcode's simulator SDK
     (xcrun --sdk iphonesimulator --show-sdk-version), and every runtime
     whose simctl lastUsedAt is within maintenance.olderThanDays or that
     simctl records no use of (Stim keeps no record of its own). When the SDK
     version cannot be read, a registered project's path cannot be reached or
     its .stim.json cannot be parsed, no runtime is deleted and the run
     reports why under "Needs a person". Owned simulators whose runtime is
     gone are deleted through teardown only when no registered workspace
     records them; a workspace's own simulator goes only through its dormant
     stage or teardown. A user-created unavailable simulator
     is never touched, and Stim never runs \`simctl delete unavailable\`.
     Nothing runs in a scoped (test) STIM_HOME or when a listing fails.
The age sweep runs every maintenance.sweepHours (24) on a stim-daemon tick, or,
while no daemon holds the home, in stim doctor, start, ios or android; never
at a set hour.
maintenance.olderThanDays (7) is its age for steps 2, 3, 5 and 6; with 0 the
sweep removes nothing in them by age, while step 1, step 7, finished
worktrees and the cap and disk-driven parts of steps 2 and 3 still run.
Kept for
every pass: a workspace that is in use, holds a lock, was used within
maintenance.protectRecentHours, is pinned with maintenance.keep, or is the
workspace of the command that started the pass; cache entries used within
protectRecentHours, named by a project's last builds, a parked device or a
live build lock, or in a Metro store with a running or unverifiable dev
server. Anything the pass cannot verify is kept. A device is deleted only when
its workspace is idle: no dev server, native run, build, lease, managed lock,
driven or busy device, web share (live or stopped for now), and no recorded use within the window. A pass stops a
dev server only by IDLE STOP above and never stops watchman; removing a
finished worktree or orphaned directory does tear down that workspace's own
dev server, owned devices and Chrome profile, as gc does. ccache evicts by itself under
caches.ccacheMaxGb.

DISK PRESSURE
  Disk and memory pressure are the stim-daemon's: one level per tick and one
  ladder (stim guide lifecycle budget), not maintenance levels. The ladder
  reuses maintenance's removal code for parked devices, the Swift compilation
  cache, Gradle daemons and versions, and the node_modules and ios/Pods of
  idle linked worktrees, with the running-process checks of WORKTREE
  DEPENDENCIES; dependencies that worktree warm can restore are recorded for
  the next start, ios or android to restore. A directory is cleared only when
  it is a real directory inside its worktree, git tracks nothing in it, its
  worktree is not in use, is not locked with git worktree lock, holds no build
  lock and is not pinned. The last rung, 9, cleans other tools' caches (npm,
  Yarn, pnpm, CocoaPods, Gradle's version-independent caches, SwiftPM) through each
  tool's own command, only at critical and only while the earlier rungs left
  the disk short (\`stim guide cleanup gc\`); Xcode DerivedData outside Stim
  is never deleted. Every command prints one stderr line while the daemon's last tick, at most 10
  minutes old, found the disk critical.

  stim status                     last checks, plan and running pass
  stim status --json              maintenance observations and recent records
  stim logs --source maintenance  this workspace's maintenance records
  stim gc --dry-run               what gc would delete now, live pressure, cached sizes
  stim settings set daemon.mode off --scope machine     turn automatic cleanup off
  stim settings set daemon.mode report --scope machine  plan and log, delete nothing

A pass writes to the one machine cleanup log, $STIM_HOME/gc/gc.ndjson (WHAT
WAS CLEARED), with trigger maintenance, runId the pass id and via the command
that started it. A pass that crashes writes maintenance/child.log.
In report mode planned actions (maintenance_action) and explaining skips
(maintenance_skip) are logged only when newly planned; in on mode every action
taken, failed or kept is one gc_item record with its bytes, a skip the planner
explains is a maintenance_skip record, and a maintenance_pass record carries
the bytes freed. maintenance_failure records the failures that are not an
item. Each fact is written once. A workspace's own
maintenance.ndjson, which stim logs --source maintenance reads, also gets
the maintenance_action, maintenance_failure and maintenance_skip records that
name it.
A merged or ended worktree the worktree check keeps, and with
maintenance.removeIdleWorktrees any other linked worktree it keeps, gets a
maintenance_skip line with its path, the reason, and a code (locked, dirty,
unpushed, in-use, submodules, last-use-unknown, recent-activity for the grace
window, and the other worktree skip codes), logged again when the code
changes. stim gc lists every worktree's reason in its worktree section.
An iOS build that fails on a corrupt compilation cache logs the emptying,
or why Stim left the cache alone, with trigger "ios build", in every mode;
see \`stim guide errors STIM_COMPILATION_CACHE_CORRUPT\`.
maintenance.logChecks enables debug observations; default false.
status and doctor report invalid settings and unresolved claims with a removal
command to run only after confirming the holder is gone. Invalid cache caps
fall back to their own defaults; invalid maintenance settings disable passes.
Pin a workspace with \`stim settings set maintenance.keep true\` in its project.
The run claim serializes passes with an acting gc; gc refuses a held claim
with the holder and recovery guidance instead of waiting. A dry run takes no
claim.
Each pass keeps a 1 MiB file, maintenance/disk-reserve. When taking the run
claim fails with ENOSPC or EDQUOT, the pass deletes it and retries once; an
acting gc gives it back before taking the claim. Either starts deleting at zero
free disk as long as an earlier run left the reserve, and writes the reserve
again at its end when there is room.

WHAT WAS CLEARED
Every run that deletes or changes something appends one record per item to
the machine cleanup log, $STIM_HOME/gc/gc.ndjson: an acting gc, at any
level, and each maintenance action taken. Maintenance passes also write their pass summaries,
explaining skips, failures and (with maintenance.logChecks) checks there. The stim-daemon's own pressure ladder logs its
actions to daemon.ndjson instead. Records the removed budget gate wrote keep
trigger budget. A dry run writes nothing, and a
gc run that only kept items writes nothing. Failed and kept items carry their
reason. The file rotates at maintenance.logMaxMb and its old generation is
kept for maintenance.logRetentionDays.
  stim logs --source gc           the retained records, oldest first
  stim logs --source gc --json    one record per line
  stim logs --source gc --errors  only the items that failed
gc works from any directory because the log is machine-wide; it cannot be
combined with other --source values and --source all leaves it out. Fields
(\`guide logs\`, GC LOG): runId, trigger (manual, desktop, maintenance or
budget), options, kind, status (done, kept or failed), label, id, path,
bytes, detail. Records with event maintenance_pass, maintenance_skip,
maintenance_failure, maintenance_check or maintenance_action carry no status,
kind or label.

CLEANUP AND DISK

worktree remove stops the agent-device daemon when the workspace's
agent-device/daemon.json exists, then removes its state directory with the
workspace. If agent-device is missing or the stop fails, it keeps the directory
and reports the retry command: agent-device daemon stop --state-dir <dir> --clean.
A daemon.json whose process is gone is stale and does not block removal.
gc of a finished worktree does the same.
stop closes owned-device sessions in that directory without deleting it.
See stim guide logs for AGENT_DEVICE_STATE_DIR examples.

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    parks eligible owned simulators and emulators
                            (\`guide lifecycle pool\`); deletes them when
                            parking is disabled, their setup cannot be
                            verified, or the disk pressure level is
                            critical
  stim gc                 sweeps devices this Stim home created that no project
                            references (\`guide cleanup gc\`) and, at the
                            level it runs, parked devices and the owned devices
                            of idle workspaces (their dormant stage), and runs
                            \`stim worktree remove\` on every clean linked
                            worktree of a registered repository whose branch is
                            merged, or whose pull request was merged or closed,
                            and that shows no activity within
                            gc.worktreeGraceMinutes (at high or critical,
                            without waiting), and deletes the owned
                            devices of a finished worktree it keeps (dirty,
                            unpushed, locked) when its workspace is idle for
                            that grace, not pinned by maintenance.keep and not
                            shared with a live stim share
  the stim-daemon         shuts down the owned devices of a workspace idle
                            for idle.minutes and deletes them after
                            idle.dormantDays, sooner under pressure
                            (\`guide lifecycle budget\`)
  automatic maintenance   deletes the owned devices of a finished worktree
                            it keeps (MAINTENANCE above)
  stim gc --pressure critical
                            also makes every idle workspace dormant, which
                            deletes its owned devices, and deletes every
                            parked device (\`guide lifecycle pool\`)

At high or critical, \`gc\` also shuts down an unused watchman daemon and idle
Gradle and Kotlin daemons with no local build running. They are shared
helper processes, not devices (\`guide cleanup memory\`).

\`worktree remove\` and \`gc\` are the only two commands that delete;
\`gc\` deletes worktrees only through \`worktree remove\`. \`gc\`
also clears the build outputs of idle workspaces, trims oversized workspace logs
(\`guide cleanup disk\`) and removes orphaned workspace directories, never a
checkout. Device recordings can also go without either: stim-server prunes
them, and turning recording.enabled off deletes them (\`guide cleanup disk\`). \`stim stop\` shuts a device
DOWN (an owned iOS simulator at the end of its booted grace period) and leaves it assigned, which is what makes returning to a branch cost a
boot rather than a create, a provision and a reinstall.

Before shutting down, parking or deleting an owned device, Stim best-effort
closes local agent-device sessions bound to its exact iOS UDID or live Android
serial. An Android session must also name the owned AVD, because the next
emulator on a console port reuses its serial. For an emulator that is already
shut down, Stim closes the sessions that name its AVD on any serial that no
connected device now holds. \`stop\` closes a session only
when agent-device's claim on the device names it and was taken inside this
workspace. It also closes a session claimed from the workspace's git root
itself, such as a worktree root above the app, but only after it has shut that
device down and rechecked that the device is still stopped and that no other
device holds its UDID or serial. Sessions from another workspace or claim,
including sibling directories under the git root, stay open. Stim rechecks
device ownership and uses agent-device's rejecting session target guard;
sessions on other devices stay open. Physical devices are outside
this cleanup. agent-device is optional: a missing binary skips this step, and a
failed or timed-out list/close prints a device line on stderr while teardown
continues. Each cleanup pass allows at most 15 seconds of agent-device calls
per device; the pass \`stop\` makes after shutdown has its own budget.
A daemon agent-device will not replace (daemon-busy: it is starting up or still
has sessions, requests or leases) is not retried. Stim prints one line per
device, naming each busy daemon, even though it lists sessions before and after
shutdown: sessions on the device in them stay open until the daemon is idle or,
if it is yours, stopped with agent-device daemon stop --state-dir <dir>.
A local daemon that cannot use socket transport or a CLI without the target guard
skips cleanup with a warning; no remote daemon is used.

Neither touches $STIM_HOME/stats.json: \`gc\` never reports or trims the run
counters \`stats\` prints, and there is no reset flag. Delete that one file to
start the counters over. A file this version cannot read -- unparseable, or
written by a newer Stim -- costs one dim line on stderr and is otherwise left
alone; only the next \`ios\` or \`android\` run moves an unparseable one aside
to stats.json.corrupt-<unix ms> and starts a new one.`,
  sections: {
    archive: {
      summary: 'retained workspace history and explicit archive cleanup',
      body: () => `ARCHIVE
  Worktree removal, including the environment reclaim of a source checkout, and
  gc pruning a registered root that is gone keep
  state, ended agents, the error index, logs, closed recording segments and
  workspace-local agent-device sessions under $STIM_HOME/archive.
  Build outputs and open recording segments are deleted with the workspace.
  Archives have no checkout, devices, ports or running processes. A recreated
  path starts fresh; status links its earlier archives with replacedBy.
  Paired clients with read can select archived[].id with archive instead of
  workspace for server log queries and replay.
  archive.detail takes { archive: id } and returns { builds, recordings }:
  live-shaped iOS/Android build history and { platform, slot, spans } for every
  retained recording slot with spans. Missing state gives builds {}; no footage
  gives recordings []. status keeps archive build summaries.
  Older servers refuse archive.detail with unknown-method.
  Archived log subscriptions send retained records, then logs-ended.
  Archived frame subscriptions need at and cannot be physical or go live.
  Replay ranges report recording disabled.
  Reads stay on this machine.
  An updated server is required; older servers refuse with bad-request when
  workspace is omitted. There is no CLI archive log flag.
  archive.enabled defaults true and accepts every settings layer. STIM_HOME
  disables archives unless STIM_ARCHIVE_ENABLED is set. Empty stubs and orphaned
  workspace directories are not archived. A failure prints one stderr line
  beginning "could not archive:" and removal continues with empty stdout.

  Retention runs on every worktree removal, archived or not, once an archive
  exists, and in automatic maintenance's daily age sweep, so archives that
  outlive their limits go without another removal (a worktree archive that a
  claim holds stays). It deletes records past their age or count limit first, then expires
  recordings, agent actions and logs by age from removedAt; trims per-workspace
  logs (oldest rotated generations, then build logs, then oldest other files);
  and removes the largest kind of the oldest archive while over total caps.
  Archives with expired artifacts keep their record until the record limit. recording.enabled false at machine scope deletes archived
  recordings on the next retention pass. Sizes are binary GB/MB; 0 keeps none.
  See stim guide settings for the nine archive.* keys and overrides.

  stim gc --dry-run   lists the archives past retention a run would delete
  stim gc             deletes archives past retention at every level; at
                      critical it also deletes the logs, recordings and agent
                      actions of every archive and keeps each archive record
  The CLI cannot delete one archive, or one kind of one archive; Stim Desktop
  can, through stim-server.

  Directories are 0700 and files 0600. No redaction is applied; logs and agent
  actions can contain secrets. Use archive.enabled false for a sensitive repo.
  Archived logs and replay are not exposed through CLI or app readers yet.`,
    },
    gc: {
      summary:
        'what gc and worktree remove delete, keep and refuse: orphans, stale records, locks, leases, EAS sessions',
      body: () => `RUNNING GC
  stim gc                       one maintenance pass now at the level the machine
                                measures; deletes
  stim gc --dry-run             reports what that run would delete; deletes nothing
  stim gc --pressure <level>    runs at normal, high or critical instead of the
                                measured level (add --dry-run to preview it)
  stim gc --json                one payload (\`guide facts gc\`)
  Agents suggest \`stim gc --dry-run\` first and run \`stim gc\` only when the
  user asks to free space. The CLI cannot pick one item to delete. Single
  items (one cache, the build outputs of idle workspaces, one archive or one
  part of it, watchman, Gradle daemons) are deleted from Stim Desktop, which
  asks stim-server for them (desktop.gc.item.subscribe on its Unix-socket
  connection); the library API has deleteGarbageItem({ item }) (\`guide api\`).

  Plain output is short, in this order:
    - the level the run used, and one summary line: what it freed, or what it
      would free
    - totals per category, each with its 3 largest items
    - "Needs a person:" lists every failure, every reason the run could not
      decide, and every cache Stim only reports, with its command
    - "Where the disk goes:" lists the largest things Stim measured and can
      reclaim, and other tools' caches it kept, with their size
    - "Full detail, kept entries with their reasons included: <path>", the
      path being $STIM_HOME/gc/last-report.txt, which each run overwrites. It
      holds one line per action: outcome, size, maintenance or rung, kind,
      target and reasons
    - on a dry run, "Apply with: stim gc" (plus --pressure <level> when you
      gave one)
  An acting run appends each item to $STIM_HOME/gc/gc.ndjson (WHAT WAS
  CLEARED).

  What each level deletes. Every level runs the automatic maintenance plan, the
  dormant reduction and the unused-runtime cleanup; a level includes the ones
  below it:
  normal    the automatic maintenance plan, workspaces idle for
            idle.dormantDays (1) reduced to their minimal size, unused iOS
            simulator runtimes, finished linked worktrees past
            gc.worktreeGraceMinutes
  high      plus the pressure ladder at high (\`guide lifecycle budget\`):
            idle stage at 2 minutes, parked devices until the level clears,
            shared caches trimmed to half their caps, the dormant stage and
            node_modules and Pods of idle linked worktrees at 10 minutes, idle
            daemons, clean finished worktrees without the grace period, and,
            while free disk stays under disk.minFreeGb, other tools' caches
  critical  plus every parked device, every shared cache Stim registered
            emptied, the dormant stage and node_modules and Pods at 2 minutes,
            every unpinned Gradle version, clean pushed worktrees idle 7 days,
            every device recording not being written, archived logs,
            recordings and agent actions, and other tools' caches
  Never: anything building, driven, leased, hosted or pinned by
  maintenance.keep; source, tracked or unignored files; uncommitted or
  unpushed work; user-created simulators or emulators; what Stim only reports.

  WHAT gc DELETES, BY CATEGORY (N normal, H high, C critical; a level includes
  the ones below it)
  Workspace build outputs and shared caches over their caps
    maintenance caps, N. Kept: in use, pinned, a running build.
  What the age sweep removes after maintenance.olderThanDays (parked devices,
  outputs, idle worktrees when opted in)
    maintenance sweep, N. Kept: recently used, pinned.
  Unused iOS simulator runtimes (xcrun simctl runtime delete <identifier>)
    maintenance sweep, N. Kept: any simulator on the machine uses it, simctl
    does not mark it deletable, it is the only installed runtime, it is the
    newest when none is used, a project's ios.runtime pins it, it has the
    major version of the active Xcode's simulator SDK, simctl's lastUsedAt
    for it is within maintenance.olderThanDays or absent; an unreadable SDK
    version, an unreachable project path or an unparsable .stim.json (reported
    under "Needs a person"); a scoped STIM_HOME; a failed listing.
  Owned simulators whose runtime is gone
    maintenance sweep, N, through centralized teardown. Kept: not in this
    home's ledger. A user-created unavailable simulator is never touched and
    Stim never runs simctl delete unavailable.
  Registry entries, workspace directories, owned devices and records of removed
  projects; stale ledger entries, gone homes, stale build claims, expired
  leases, status caches
    maintenance prune, N. Kept: path absence cannot be proven (invariant 8),
    holder alive.
  Workspace logs over their cap; recordings and archives past retention;
  parked hosted devices; orphaned EAS sessions of the current project
    maintenance prune, N. Kept: live session, live recording.
  Finished linked worktrees (branch merged, pull request merged or closed, or
  no commits of their own), after gc.worktreeGraceMinutes
    maintenance worktree check, N. Kept: uncommitted (archived first) or
    unpushed work, in use, leased, locked, pinned, cannot prove finished.
  Workspace idle idle.dormantDays (default 1): build outputs (android/build,
  android/.gradle, .build, .cxx, .dd DerivedData, an Exact app's target/ beside
  exact.mjs), owned devices, logs archived
    dormant reduction, N. Kept: running dev server or build, booted device,
    leased, driven, locked, hosted, pinned, idle.minutes 0.
  The same: node_modules and ios/Pods of a linked worktree, recorded so the next
  Stim command restores them with worktree warm, or asks for an install
    dormant reduction, N. Kept: source checkout, under 256 MB of its own (a
    copy-on-write clone), in use, a running process inside, pinned.
  Idle dev servers and their outputs (idle 2 minutes)
    idle stage and rung 1, H. Kept: as above.
  Parked devices
    rung 2, H until the level clears, C all.
  Shared caches trimmed to half their caps; at C every registered cache emptied,
  the fingerprint index and memo
    rung 3, H and C. Kept: entries a running build protects, report-only
    caches.
  Dormant stage at 10 minutes (H) or 2 minutes (C)
    rung 4, H. Kept: as the dormant reduction.
  node_modules and Pods of linked worktrees idle 1 hour (H) or 2 minutes (C)
    rung 5, H. Kept: worktree warm cannot restore the same versions, a
    copy-on-write clone, in use, pinned.
  Idle Gradle and Kotlin daemons, unused watchman, unpinned Gradle versions (C:
  all unpinned), TMPDIR leftovers, worktree trash
    rung 6, H. Kept: a build running, a project pins it, modified within 24
    hours.
  Clean finished worktrees after gc.worktreeGraceMinutes (H), without it (C);
  clean pushed worktrees idle 7 days (C)
    rung 7, H and C, only while maintenance.removeFinishedWorktrees is true;
    the idle pushed ones go only while maintenance.removeIdleWorktrees is
    true. Kept: dirty, unpushed, in use, leased, locked, pinned.
  Every device recording and archived logs, recordings and agent actions
    rung 8, C. Kept: a recording being written, those of a workspace pinned
    with maintenance.keep or in use (checked again under the workspace's
    native-run claim); worktree archives and archive records.
  Caches Stim does not own: npm (npm cache clean --force), Yarn (yarn cache
  clean), pnpm (pnpm store prune), CocoaPods (pod cache clean --all), Gradle
  caches/modules-2, caches/transforms-N and caches/build-cache-N
    rung 9, C only, never in a STIM_HOME-scoped home or in the in-process
    ladder a build runs at disk.hardFloorGb; only the stim-daemon (at most
    hourly, while the disk is still short) and stim gc run it. stim gc with
    no --pressure that measures critical measures free disk again after the
    earlier rungs and runs it only if the disk is still under the critical
    level; stim gc --pressure critical always runs it. Each through the
    tool's own command, listed with its size before and after. Kept: the tool
    is not installed, a process of that tool runs, processes cannot be
    listed. Gradle (modules-2, transforms-N, build-cache-N) and SwiftPM have
    no command, so Stim renames each directory aside to a .stim-delete-*
    sibling and deletes it, only while no Stim build lock or build slot is
    live or unresolved and no matching tool process runs (rung 6 stops idle
    daemons first); a cache directory that is itself a symbolic link is kept
    with a remedy to remove its target yourself. npm is found by
    npm_config_cache (or NPM_CONFIG_CACHE), else ~/.npm; Yarn by
    YARN_CACHE_FOLDER or the platform default; pnpm by PNPM_HOME/store or the
    platform default, so no package manager runs on a dry run; only an acting
    run executes the clean commands, with COREPACK_ENABLE_NETWORK=0.
  Android NDKs (sdkmanager --uninstall "ndk;<version>"), Android system images
  no AVD uses (the sdkmanager command), ~/.cache/exact
    rung 9, reported only, with the command, never deleted.

  The dormant reduction and the dormant stage are the same work: a workspace
  with no activity for idle.dormantDays is reduced to its minimal size, by
  stim gc at every level and by the stim-daemon. Its node_modules and
  ios/Pods go only in a linked worktree, are recorded, and the next Stim
  command in it restores them with \`stim worktree warm\`, or, when warm cannot
  restore the same versions (its lockfile differs from the source checkout's,
  or the source checkout's dependencies were not installed from its own
  lockfile), refuses with STIM_DEPS_FAILED and asks for an install. The source
  checkout's node_modules is never deleted. Only git-ignored regenerable
  directories are deleted: a real directory inside the checkout whose files git
  ignores, with no tracked or unignored file, not reached through a link.

  Concurrency: an acting stim gc takes the same exclusive maintenance claim as
  the stim-daemon's maintenance pass. While one holds it the other refuses at
  once with STIM_CLAIM_REFUSED naming the holder (pid, start, trigger); retry
  after it ends. A dry run takes no claim.
  Full disk: gc gives back the 1 MiB maintenance disk reserve
  ($STIM_HOME/maintenance/disk-reserve) before taking its claim, so it can
  start at 0 bytes free, and writes it again when the run ends.

PARKED HOSTED DEVICES
On a hosting Mac, gc --dry-run lists parked hosted iOS/Android devices by session,
client id, device label, parked time and private-home ledger ownership.
An acting gc takes each session claim and deletes through the packaged stop worker
in that session's home, at every level; held claims, changed sessions and unverified ownership
keep the device. Android deletion also requires the AVD to be visible from this
shell; otherwise run gc with the server's ANDROID_AVD_HOME/HOME. Devices no longer
listed in their session ledger are already removed and skipped. An unreadable
journal keeps every hosted device. The CLI never writes
the server journal: stim-server reconciliation clears the parked marker after
successful deletion leaves the session ledger empty.

OTHER STIM HOMES (REPORT ONLY)
Every Stim home other than ~/.stim that creates a workspace or a device lists
itself once in ~/.stim/machine/homes/homes.json, which ignores STIM_HOME: its
path, creation time, last-seen time (refreshed at most every ten minutes) and
the simulator UDIDs and AVD names its created-devices ledger lists. Homes
inside ~/.stim, such as the private homes of hosted sessions, are not listed.
A list that cannot be read or written never fails the command that tried.
gc --dry-run lists the other homes that still exist: their private size, workspace
count, last-seen time, the devices their ledgers name (owned by that home,
never this one) and the exact commands that tear each down, from the root of
each linked worktree, or from the project folder in a source checkout:
\`STIM_HOME=<home> stim worktree remove\`, then
\`STIM_HOME=<home> stim gc\`, then removing the directory. A scoped
STIM_HOME lists nothing: it owns only its own ledger.
A home whose directory is gone from a mounted volume is listed as gone, and
its last-known devices that are still on this machine appear as "orphaned from
<home>" with the command that deletes each by hand. On a volume that is not
mounted nothing is claimed and the entry stays. gc never deletes or tears down
another home. \`gc\` removes only the list entry of a gone home with no
device left on this machine, after re-checking it under the list lock.

AGENT-DEVICE (REPORT ONLY)
gc --dry-run reports agent-device runner builds by platform and entry, last use,
agent-device and Xcode versions, sessions, logs, other state, workspace state
and hosted driver state. Stim never selects this state as a cache.
Stim never trims or deletes the shared runner builds, sessions, logs and other
state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.
A live owner or runner lease marks an entry in use. A lock marks it in use only
when its owner is live or unknown. Unreadable lock owners and unreadable or unknown
leases conservatively mark entries in use. Dead lock owners and leases do not.
Use agent-device's own tooling or remove directories yourself to clear unused
state.

SWIFTPM CACHE
gc --dry-run also reports the user-level SwiftPM cache after agent-device:
~/Library/Caches/org.swift.swiftpm on macOS, or org.swift.swiftpm under
XDG_CACHE_HOME (default ~/.cache) elsewhere. It is shared by every SwiftPM
build on this machine, so it is never in caches and never changes actionable.
Only the last rung, 9, removes it, at critical: for a measured critical only
while its volume is still under the critical level after the earlier rungs,
and under --pressure critical whatever its volume, and only while no Stim build lock or build slot is
live or unresolved and no swift-build, swift-package, swift-frontend,
xcodebuild or SourceKitService process runs. It renames the directory aside on
the same volume and deletes the renamed copy.

GRADLE VERSIONS
\`stim gc --dry-run\` lists, and \`stim gc\` at high or critical removes, the
caches/<version> and wrapper/dists/gradle-<version>-* directories under
GRADLE_USER_HOME of each Gradle version no registered project pins, read from
the wrapper of each project's Android Gradle root and root. Nothing is deleted
while a process that may be Gradle using this home runs: a Gradle main
class, a Gradle wrapper or distribution jar, or a java process naming a path
under the home, unless it names no such path and every gradle.user.home or
-g it names is an existing Gradle home elsewhere, while ps fails, while no Stim config
exists, while a registered project is missing or its pin cannot be read,
while a Gradle directory cannot be listed, or while caches, wrapper or
wrapper/dists is a symlink or resolves outside the home;
sections.gradleVersions.blocked names the reason. A version is also kept
when one of its paths is not a plain directory inside the home, when an
entry under it cannot be listed or stat'd, when it holds more than 500000
entries, or, at high, when anything under it changed within
maintenance.gradleVersionIdleDays days (critical ignores that age).
Right before removal gc lists processes and reads pins again, then renames
each directory to a .stim-delete-* sibling and deletes it. A later gc at high
or critical finishes any .stim-delete-* left by a failed
removal, even while the versions are blocked (not while the home is outside
a scoped STIM_HOME or its layout is unsafe), since nothing uses those
directories, and reports it again when that fails; automatic maintenance
never touches them. Rung 9 uses the same convention for modules-2,
transforms-N and build-cache-N in caches/ and for the SwiftPM cache: a later
gc finds and finishes a leftover in Gradle's caches/ or the SwiftPM cache's
parent and measures it, and a removal that fails after the rename is reported
as failed with the bytes still left aside. jdks and the other shared Gradle caches are never
deleted; modules-2, transforms-N and build-cache-N go only in rung 9 (THE
PRESSURE LADDER).
With STIM_HOME set, gc deletes nothing in a Gradle home outside it. Pressure
ladder rung 6 (daily in the age sweep, at once under disk pressure, and in
gc at high or critical) first stops
the idle Gradle and Kotlin daemons using the common identity, idle and build
checks, then deletes versions unmodified for maintenance.gradleVersionIdleDays
days (7; 0 keeps the versions) once every Gradle process that keeps one was
such a daemon.

OTHER TOOLS' MACHINE-WIDE CACHES
gc --dry-run also reports large caches other tools keep for the whole machine,
each with its size and the owning tool's own remedy. Rung 9 and the runtime
cleanup (THE PRESSURE LADDER, RUNNING GC) delete only what they name; every
other entry here is report only:
- Gradle version caches and wrapper dists under GRADLE_USER_HOME (default
  ~/.gradle) for versions no registered project pins in the
  gradle/wrapper/gradle-wrapper.properties of its Android Gradle root
  (android.gradleRoot, default android, relative to the app, inside the
  repository; a custom root must hold settings.gradle and the module's build
  script) or of the project root, and caches/modules-2. A registered project
  that is missing, whose settings cannot be resolved, or whose wrapper cannot
  be read or names no Gradle version is named, since it may still pin a
  listed version; every version a readable wrapper of it pins still counts as
  pinned. A directory that cannot be listed adds a notice and marks the
  section incomplete.
  Gradle removes version caches and modules-2 entries unused for 30 days on
  its own. The remedy for a version is stim gc --pressure high
  (see GRADLE VERSIONS); modules-2, transforms-N and build-cache-N go only in
  rung 9. A listed
  version's caches/<version>/transforms directory is shown on its own with its
  size, the part deleting it frees ("its own" on APFS) and the manual remedy
  rm -rf <dir>; Gradle extracts the transforms again on the next build. The
  transforms of a version a registered project pins are not listed.
- iOS simulator runtimes with their simulator count. Only a deletable
  runtime no simulator uses gets xcrun simctl runtime delete <id>, which gc
  runs at every level; the only installed runtime stays.
- Xcode device support entries under ~/Library/Developer/Xcode/*DeviceSupport.
  Xcode copies an entry again when that device next connects.
- Xcode DerivedData directories (~/Library/Developer/Xcode/DerivedData) whose
  info.plist WorkspacePath is gone from a mounted volume, with the size, the
  recorded path and the remedy rm -rf <dir>; Xcode builds the project again if
  it returns. A directory without a readable WorkspacePath, with a relative
  path, or whose path is on a volume that is not mounted is not listed.
- agent-device runner builds grouped by agent-device and Xcode build version,
  compared with the installed agent-device and Xcode. agent-device has no
  prune command; remove an entry not in use by hand.
$STIM_HOME/machine-cache-usage.json caches the sizes, simulator runtimes and
tool versions for 10 minutes and measures again when the measured
directories change. Stim deletes none of these but the unused runtimes and the
rung 9 caches. They are never in caches and never change actionable.

LINKED WORKTREES
  \`stim worktree remove\` works with any linked worktree, warmed or not.
  Git registration identifies the worktree; a Stim registry entry is not
  required. Before it reclaims anything, the command refuses a worktree git
  has locked (unlock it first; --force does not override) and, without
  --force, uncommitted or unpushed work and initialized submodules. It then
  reclaims any owned resources it finds and removes the linked checkout.
  Before git removes it, the command renames the worktree's ignored
  directories (node_modules, ios/Pods, build outputs) into
  $STIM_HOME/trash/<entry>, so git removes a light tree, and a detached,
  low-priority rm deletes the entry after the command returns. Disk is freed
  when that rm finishes. Through the programmatic API (createStim), the entry
  is deleted before the call resolves. A directory that does not rename stays
  for git to delete as before; on Windows, or when $STIM_HOME is on another
  volume, nothing is renamed. When git refuses the removal, the directories
  are moved back. Each entry holds an ownership claim while the command or its
  rm uses it; gc reports every directory under trash with its size ("deleting"
  while a removal holds it) and, for an entry Stim wrote, its source worktree.
  gc at high or critical deletes only a remove-* entry with a valid trash.json whose
  claim is free and whose worktree path is gone, which finishes a removal that
  was interrupted, and keeps any other directory. An entry whose worktree path
  still exists, as after a removal killed between the rename and git, stays
  with the reason; if that worktree is the one the entry came from, run
  \`stim worktree remove\` on it to finish the removal.
  gc never moves the directories back. Warm uses the same trash for the
  known paths it deletes from a copy (such as a copied .pnpm-store); gc
  at high or critical deletes such an entry (trash.json kind warm) once its claim is free,
  whatever the state of the worktree.
  When git still refuses the removal, the kept ownership record no longer
  names the devices that were parked or deleted. A workspace that is in use
  (see IN USE below) keeps its directory, devices and registry entry, and the
  command reports why. Git-created
  branches stay. A branch with an existing Stim ownership record is deleted
  only when it has no unique commits.

IN USE
  gc and worktree remove never delete a workspace's directory or checkout
  while it is in use: its dev server supervisor is running or
  cannot be verified, a \`stim ios\`, \`stim android\` or \`stim stop\` run
  holds its native-run.lock, a live or unresolvable build lock or slot names it,
  or its managed tunnel or managed remote lock is held. Build outputs follow
  the narrower rule in WORKSPACE BUILD OUTPUTS (\`guide cleanup disk\`): only
  a build, a running macOS app, or an ios, android or macos run in the last
  15 minutes keeps them. The deletion holds
  native-run.lock itself, so no native run can start partway through. A lock
  that names no workspace blocks nothing, because every build also holds its
  own workspace's native-run.lock; gc lists it with the command that removes
  it. \`worktree remove\` re-checks uncommitted and unpushed work under its
  removal locks, just before it reclaims anything. It refuses, even with
  --force, a worktree that an installed stim service runs from
  (STIM_WORKTREE_SERVICE; see guide errors). A project root whose
  existence cannot be read (a permission error) is never treated as deleted.

SWEEPING FINISHED WORKTREES
  Every \`gc\` looks at every registered project root,
  every workspace.json root, and every linked worktree \`git worktree list\`
  shows for a registered project's repository. It groups them by git worktree
  and reports each linked worktree with the reason it is removed or kept. A
  worktree is managed when a registered project or a workspace.json root lies
  in it, or when discovery finds it (DISCOVERED CHECKOUTS below); a linked
  worktree of a scoped STIM_HOME that none of these names is reported as
  not-registered and kept, however merged or idle; \`worktree remove\` still
  removes it on request. A worktree is finished when
  its branch is merged into the default branch, or its pull request was
  merged or closed (PULL REQUESTS below). A clean worktree with no commits
  of its own counts as finished once idle (NO COMMITS OF ITS OWN below).
  At critical gc also removes
  one that is idle: no recorded use for 7 days; a
  worktree whose last use is unknown is kept, unless it has no commits of its
  own beyond the default branch (NO COMMITS OF ITS OWN below). Each needs a
  clean state, except a finished one whose changes are archived;
  a worktree is kept when it is the source checkout, bare, locked, pinned by maintenance.keep, holds
  another worktree (worktree remove refuses it too), in use (the sweep also
  counts a running Claude Code session, or a Codex thread active in the last
  30 minutes, whose working directory is in the worktree),
  not known to this Stim home (not-registered: no project, workspace.json root
  or discovery source of this Stim home names it, which in a scoped STIM_HOME
  includes every worktree outside maintenance.discoverRoots),
  dirty and not finished, or dirty and finished when its changes cannot be
  archived (ARCHIVED CHANGES below; untracked files count; pod install churn and
  watchman's untracked \`.watchman-cookie-*\` files alone do not), unpushed
  (commits no remote-tracking ref or other local branch reaches), or has
  initialized submodules. The report leaves out the
  source checkout and roots outside git.

  Each worktree line also shows its in-tree build state: the size of the
  build and dependency directories the pressure ladder clears (DISK PRESSURE
  above) and a root .pnpm-store, largest first (APFS clones count in full).
  A directory laid out as Xcode DerivedData under another name than .dd, such
  as a rn-tester build-device, is listed too, marked "xcodebuild output,
  never deleted" (JSON reportOnly: true); gc and the idle stage never delete
  it, and a .dd or android/.cxx of a worktree that is no registered
  workspace is listed and never deleted either. DerivedData, CMake output,
  node_modules and Pods also show what deleting them frees as "its own".
  A size comes from the disk-usage cache while it is under an hour old and
  no entry was added to or removed from its directory since (a build that
  only grows files deeper inside shows within the hour); otherwise gc runs
  one du per directory, 4 at once, 10 seconds each, and a directory du did
  not finish shows "size unknown". du counts hard links shared between two
  directories in both. gc never deletes them on their own;
  the JSON field is buildState. Only directories of this worktree count,
  not those of a worktree nested inside it.

  A directory directly under a registered repository's .worktrees/ that
  \`git worktree list\` does not show and that no git knows (no .git, or a
  .git file whose gitdir is gone, as after a prune) is listed under "Directories under .worktrees that git does
  not list as worktrees" with its size and the rm -rf command, and never
  removed: gc cannot check it for uncommitted work. Look through it first.

  IN USE means its dev server supervisor runs, a stim ios, android or stop
  run holds its native-run lock, a live build lock or slot names it, a
  managed tunnel or remote lock is held, an owned simulator or emulator of
  the workspace is booted (an agent-device session needs one), or it holds
  an unexpired device lease. When the simulator or emulator list cannot be
  read, the worktree counts as in use. A device left booted keeps the
  worktree until \`stim stop\` in it, or its idle stage, shuts the device
  down. A simulator that \`stim stop\` left booted for its grace period
  (\`guide lifecycle pool\`) does not keep it. A worktree that holds the running stim or the realpath of
  the \`stim\` on PATH is in use too, and \`stim worktree remove\` refuses it
  even with --force, as it refuses an installed stim service's checkout.

  RECENT ACTIVITY keeps a worktree gc would otherwise remove until
  gc.worktreeGraceMinutes (120 by default, \`guide settings\`) have passed
  since the latest of: a write to its git index, HEAD or HEAD reflog, a write
  to its Stim workspace state or log files, and, for a merged branch, the
  committer date of the commit that brought it into the default branch, or
  the time its pull request was merged or closed, and, for a dirty finished
  worktree, the newest change to its uncommitted or untracked files. That
  window is when an agent that just merged runs \`stim stop\` and \`stim
  worktree remove\` itself. The reason is recent-activity, and the report
  and the JSON eligibleAt field say when it becomes removable. When that
  activity cannot be read, the worktree is kept (reason activity-unknown).
  0 turns the grace period off.

  FRESH STATE: an acting \`gc\` and the maintenance worktree check fetch the
  default branch and ask gh as MERGED and PULL REQUESTS below describe. The
  worktree check runs in the background when a stim command starts a
  maintenance pass that has it due, every maintenance.worktreeCheckMinutes;
  plain gc never starts one. It writes each pull request lookup into the
  cache \`status --watch\` also writes. A dry run (gc --dry-run) runs no
  fetch and no gh: it judges merges from the existing origin/<default> ref and
  takes a pull request from that cache when it records the worktree's current
  branch and HEAD. Both count as fresh while they are younger than twice the
  worktree check interval, and never less than 10 minutes. A merge found
  against the existing ref stays true as the default branch moves on, so a
  report calls a worktree removable only on facts fresh state keeps, with
  three exceptions: a force-push that dropped the merge from the default
  branch, a pull request reopened since the lookup, and the grace period of a
  pull request merged or closed after its merge commit was made. A kept worktree whose
  verdict fresher state could change says "merge state not refreshed", and
  its reason not-merged becomes merge-unknown. With daemon.mode off or
  maintenance.removeFinishedWorktrees false the check never runs, and only
  an acting \`gc\` refreshes. It always collects fresh state
  before it removes anything; \`stim worktree remove\` run from a report
  checks only for uncommitted and unpushed work.

  MERGED means, with the default branch taken from origin/HEAD, after a
  \`git fetch origin <default>\` per repository (30s timeout, no credential
  prompt; skipped when that checkout fetched in the last 10 minutes; FRESH
  STATE above for a report):
  - HEAD is reachable from origin/<default> through a merge commit, and the
    branch's reflog shows a commit made on it that HEAD contains. A branch
    with no commit of its own -- fresh, cut from another branch, or reset
    onto one -- is not merged.
  - the branch changes the tree, and either it has no merge commits and every
    commit since the merge base has the same \`git patch-id --verbatim\` as a
    commit on the default branch (a rebase merge), or its whole diff since the
    merge base has the same verbatim patch id as a commit there, compared on
    the files the branch changes (a squash merge).
  From git alone, a squash merge whose content changed during the merge (a
  conflict resolution, a suggested edit, even whitespace) does not match, and
  neither does a fast-forwarded branch or a stacked pull request merged after
  the one below it; the pull request check covers those. When origin/HEAD is not set, the fetch fails, or git
  cannot answer, the state is unknown and never counts as merged (reason
  merge-unknown, with the remedy); at critical an idle worktree is still
  removed. A squash- or rebase-merged branch whose upstream is gone (deleted
  after the merge and pruned locally) has commits only it reaches; they do
  not block removal, because their change is on the default branch, and the
  branch is kept.

  NO COMMITS OF ITS OWN: a worktree whose HEAD the default branch contains
  and whose branch has no commit made on it (fresh, cut from another
  branch, reset onto one, or a detached HEAD; the MERGED rule above) holds
  nothing git would lose, but looks the same as one just made by git
  worktree add. gc and the maintenance worktree check remove a clean
  one without an open pull request once the RECENT ACTIVITY sources above
  are older than gc.worktreeGraceMinutes and maintenance.protectRecentHours
  (2 hours by default), and never younger than 5 minutes (reason
  recent-activity until then, activity-unknown when they cannot be read).
  Removal re-checks, under the removal locks, that
  HEAD did not move and the worktree is still idle, and \`stim worktree
  remove\` still refuses dirty or unpushed work. A process Stim does not
  track, such as a benchmark run from a detached build, does not keep it.

  ARCHIVED CHANGES: a dirty worktree that is otherwise finished, idle past
  RECENT ACTIVITY and not in use is archived, then removed, by gc
  and the maintenance worktree check. Under the removal locks Stim writes
  \`git diff --binary HEAD\` (staged and unstaged changes together) to
  tracked.patch, the untracked files git does not ignore to untracked.tar,
  HEAD's commits the default branch lacks to head.bundle,
  with a manifest.json naming the branch, HEAD, pull request and files, in
  $STIM_HOME/archive/worktrees/<repository>/<branch-or-dir>-<timestamp>/.
  Ignored files (node_modules, build output) are not saved. It verifies the
  patch with \`git apply --check -R\`, the tarball's file list, and that no
  archived file changed, again just before git removes the worktree; any
  failure keeps the worktree and deletes the archive. It also keeps a
  worktree whose archive.enabled is false, or false for a project registered
  inside it, with archive.maxAgeDays or
  archive.maxTotalGb 0, whose untracked files or patch exceed
  archive.maxTotalGb, whose archive would leave less free disk than
  disk.hardFloorGb, whose staged version of a file differs from its
  working tree, or that holds an untracked nested repository. Archives are 0700 and 0600 with no
  redaction, so an untracked secret such as a .env file that git does not
  ignore is saved; use archive.enabled false for a sensitive repository. A
  \`git status\` or editor refresh that rewrites the index restarts RECENT
  ACTIVITY. The removal line and the gc
  and maintenance logs name the archive and the restore commands; head.bundle
  exists only when the default branch lacks HEAD, and lets the restore work
  after the branch is deleted:
    git -C <repository> bundle unbundle <archive>/head.bundle    (with a bundle)
    git -C <repository> worktree add --detach <path> <HEAD>
    git -C <path> apply <archive>/tracked.patch
    tar -xf <archive>/untracked.tar -C <path>
  Archive retention, which runs before and after each new worktree archive
  and after each removal that archives a workspace, deletes worktree archives
  older than archive.maxAgeDays. A new archive that would not fit beside the
  others in archive.maxTotalGb keeps its worktree instead, so the oldest are
  deleted for size only after that cap is lowered. An archive whose removal
  is still running holds an ownership claim and is never deleted. Plain \`stim worktree remove\` never archives; it
  refuses dirty work as before.

  PULL REQUESTS: with fresh state, gc runs one \`gh api graphql\` query per
  repository that asks for the 20 newest pull requests of each linked worktree's branch, as
  \`gh pr list --head <branch> --state all\` would, and for each worktree
  takes the pull request whose head is HEAD, else one whose head contains
  HEAD. A pull request whose head HEAD is past ("PR #12 merged, and HEAD has
  commits it does not"), one unrelated to HEAD (an older use of the branch
  name), and one from a fork that is not one of the repository's own remotes
  (a stranger's fork reusing the branch name) do not count; a pull request
  opened from the user's own fork counts like any other. A merged or closed
  one makes the worktree finished under the same clean state. Merged, its
  commits are kept on GitHub, so local commits whose remote branch was
  deleted do not block removal. Closed, they do: a closed pull request whose
  remote branch is gone keeps the worktree as unpushed. An open pull request
  never makes a worktree finished. When gh is
  not installed, not signed in, rate limited, or fails, the JSON pullRequestUnknown field
  and the report say why, and gc judges from git alone. A detached HEAD is
  not looked up. \`stim worktree remove\` makes the same check when
  local-only commits alone would refuse the removal, and accepts a merged
  pull request whose head is or contains HEAD.
    stim gc --dry-run    # report merged worktrees from local state
    stim gc              # refresh, then remove them
    stim gc --pressure critical   # also the finished ones without the grace period, and the clean idle ones while maintenance.removeIdleWorktrees is true
  An acting gc runs the \`stim worktree remove\` pipeline, never --force,
  on each removable worktree. That pipeline re-inspects the worktree and
  re-checks use and recent activity under the removal locks, and idleness
  for an idle worktree, an unchanged HEAD for a merged one, or both for one
  with no commits of its own, then parks
  devices through the same teardown and handles the
  branch exactly as a manual \`stim worktree remove\`, which keeps the
  checkout when its HEAD moves while devices are reclaimed. A worktree that
  changed since the report is kept with the reason. A worktree that fails is
  reported, gc exits 1, and the sweep continues.

THE PRESSURE LADDER
  \`gc\` runs one maintenance pass now at the level the machine measures, or
  at \`--pressure <normal|high|critical>\`, and deletes. \`gc --dry-run\` reports
  what that run would delete, action by action with what each would free, and
  deletes nothing. Its sizes are apparent sizes, while
  a run reports how much free disk actually rose, so files APFS shares with a
  clone, such as node_modules a warm copied, can free 0K.
  Every level runs the automatic maintenance plan: workspace build outputs and
  shared caches over their caps, the age sweep, orphaned workspace
  directories, registry entries and owned devices of removed projects, stale
  records, archives past retention, workspace logs over 8 MiB, parked hosted
  devices, orphaned EAS sessions of the current Expo project, unused iOS
  simulator runtimes, and finished linked worktrees past
  gc.worktreeGraceMinutes; and it reduces every workspace idle for
  idle.dormantDays (1) to its minimal size (the table under RUNNING GC).
  Above normal it forces the ladder (\`guide lifecycle budget\`) to the level, every
  rung to its end:
    0  booted parked simulators
    1  idle outputs: the idle stage for every workspace idle 2 minutes or more
    2  parked devices (high until the level clears, critical all)
    3  shared caches: trimmed to half their caps at high; at critical emptied
       (compilation cache, ccache, build cache except entries in use, Metro
       cache, macOS artifacts, React Native and Android caches), with the
       fingerprint index and memo
    4  the dormant stage: workspaces idle 10 minutes (high) or 2 minutes
       (critical)
    5  node_modules and Pods of idle linked worktrees, at high (idle 1 hour)
       and critical (idle 2 minutes), only those worktree warm can
       restore
    6  idle Gradle and Kotlin daemons, an unused watchman, unpinned Gradle
       versions (critical: all unpinned), TMPDIR leftovers, the worktree trash
    7  worktrees, only while maintenance.removeFinishedWorktrees is true:
       clean finished ones after gc.worktreeGraceMinutes (high) or without it
       (critical); at critical also clean pushed ones no Stim command used for
       7 days, only while maintenance.removeIdleWorktrees is true (false
       means never, at any level). The daemon's tick uses the pull request lookups the worktree
       check cached; stim gc looks them up again
    8  critical only: every device recording not being written, except those
       of workspaces pinned with maintenance.keep or in use (checked again
       under each workspace's native-run claim), and archived logs,
       recordings and agent actions; worktree archives and archive records
       stay
    9  the last rung, at critical only, never in a STIM_HOME-scoped home and
       never in the in-process ladder a build command runs at
       disk.hardFloorGb: caches Stim does not own, each through the tool's
       own command only when that tool is installed and no process of that
       tool runs, each listed with its size before and after: npm cache clean
       --force, yarn cache clean, pnpm store prune, pod cache clean --all, and
       Gradle's version-independent caches (caches/modules-2,
       caches/transforms-N and caches/build-cache-N under GRADLE_USER_HOME,
       which Stim removes itself because Gradle has no command, and SwiftPM's
       cache, both only while no Stim build lock or build slot is live or
       unresolved and no matching tool process runs, by renaming the directory
       aside to a .stim-delete-* sibling on the same volume and deleting it;
       rung 6 stops idle daemons first; a cache directory that is itself a
       symbolic link is kept with a remedy to remove its target yourself).
       npm is found by npm_config_cache (or NPM_CONFIG_CACHE), else ~/.npm,
       Yarn by YARN_CACHE_FOLDER or the platform default and pnpm by
       PNPM_HOME/store or the platform default, so no package manager runs on
       a dry run; only an acting run executes the clean commands.
       Reported only, never deleted, with the command: Android NDKs
       (sdkmanager --uninstall "ndk;<version>"), Android system images no AVD
       uses (the sdkmanager command) and ~/.cache/exact.
  Only the stim-daemon and stim gc run rung 9. The daemon runs it at most
  hourly, while the disk is still short. stim gc with no --pressure that
  measures critical measures free disk again after the earlier rungs and runs
  rung 9 only if it is still under the critical level. An explicit
  stim gc --pressure critical is the free-everything command and always runs
  it.
  It runs whatever daemon.mode says and covers every registered workspace,
  the one gc runs in included: its dev server stops and its devices shut
  down after 2 idle minutes, its owned devices are deleted after 10 at high,
  and a linked worktree's node_modules and Pods after an hour at high. It never touches
  a workspace with a blocker (a build, a driver, a lease or lock, a live web
  share, a hosted placement, unreadable evidence), and maintenance.keep
  protects a workspace. Report-only caches and what Stim never deletes (other
  DerivedData, Android NDKs, system images, ~/.cache/exact) are never touched;
  the SwiftPM cache goes only with rung 9, at critical. Caches whose loss slows the next build go only for an idle
  workspace or at critical. An acting run appends each item to
  $STIM_HOME/gc/gc.ndjson. \`stim revive\` resumes an idle workspace; the next
  \`stim ios\` or \`stim android\` creates the devices of a dormant one.
    stim gc --dry-run                 # what a run at the measured level would delete
    stim gc --pressure high           # the ladder at high
    stim gc --pressure critical       # the ladder at critical, rung 9 included

ORPHANED WORKSPACE DIRECTORIES
  A worktree deleted with \`git worktree remove\`, \`rm -rf\` or a /tmp wipe
  leaves its $STIM_HOME/workspaces/<name> directory behind with no registry
  entry. \`gc\` reads each directory's workspace.json and reports it under
  "Orphaned workspace directories" when the recorded project root is gone,
  its volume is mounted, no registry key equals it or sits under it, and the
  workspace is not in use. \`gc\` re-checks each one, then removes
  it. A directory with an unparseable workspace.json, or a root on an
  unmounted volume, is reported under Skipped and never deleted.
  A directory with no workspace.json that holds only leftovers of a removed
  workspace is reported the same way: maintenance.ndjson, log-error-index.json,
  ended-agents.json, empty lock files and an agent-device directory with no
  running daemon. It counts as gone when it is empty, or when the project
  root its maintenance log names maps to the directory name and is gone. Any
  other file (state.json, for one), a held lock or a log naming no root keeps
  it under Skipped. The empty directory report has no project root.

DISCOVERED CHECKOUTS
A checkout no stim command ran in is managed like a registered workspace once
discovery finds it: direct children of the folders that hold the checkouts of
registered projects, direct children of the folders in maintenance.discoverRoots
(a machine setting: absolute paths below the home folder, a leading ~ expanded;
the home folder and / are refused, and doctor reports one that is not a folder), and linked worktrees (git worktree list) of their
repositories. A child counts only when Stim's project detection recognises it as
a project it handles, itself or through a direct child of its apps, examples or
packages folder; any other folder is ignored. A linked worktree is acted on only
inside its repository's main checkout folder, a folder holding a known project,
or a maintenance.discoverRoots folder; every other worktree (another tool's
home, a pin checkout) is listed by stim gc --dry-run as outside the folders Stim
manages and gets no action of any kind. Nothing under the system temporary
directory or a dot-folder directly inside the home directory is ever touched.
A worktree nested in a registered root is left to that workspace. The home
directory and / are never a folder that holds known projects. A scoped
STIM_HOME discovers only from its own maintenance.discoverRoots. Discovery
registers nothing, writes nothing and recomputes each run; no git fetch runs in
a discovered repository and pull requests come from the cache.
  stim settings set maintenance.discoverRoots '["~/Developer"]' --scope machine
Idle, with no Stim activity record, means the newest of its source file writes
(git-ignored files included; node_modules, Pods and nested worktrees skipped,
and build, dist, target, .cache and similar folders skipped only where git
ignores them), its last commit and its git writes, for idle.dormantDays. A
process running from or working in it, an agent session in it, a pin by
maintenance.keep, more source files than the scan reads, or evidence that
cannot be read keeps it. Its regenerable build outputs go when it is idle; a
linked one also loses node_modules and Pods, a main checkout keeps them. A
target directory at a checkout root whose CACHEDIR.TAG starts with the standard
CACHEDIR.TAG signature line and whose files git ignores counts as build output
for every checkout.
Removing a discovered worktree needs a clean one whose work is merged or whose
pull request ended, and, at every pressure level with no zero grace, that same
idleness, no process or agent session, and every git-ignored file present byte
for byte in the main checkout, except inside regenerable folders: directories
git reports as ignored that are named node_modules or like build output (build,
dist, target, .next, .turbo, .expo and the rest of the source scan's list) or
that the stages recognise; the files inside them are deleted with the worktree.
An ignored file elsewhere that the main checkout lacks, even inside a tracked
dist folder, keeps it (more than 200 files or 16 MB to compare also keeps it).
Any change to a tracked file, even Podfile.lock or project.pbxproj, is dirty
work and keeps it, as does any tracked file marked assume-unchanged or
skip-worktree, which hides edits from git status. A worktree inside a
dot-folder of its main checkout other than .worktrees (.claude/worktrees) is
managed by another tool and is never removed, though its outputs are reduced.
Dirty work is never archived.
stim gc --dry-run lists the discovered checkouts and what each
would lose, or why it is kept; one over the scan bound is listed under Needs a
person.

DELETED WORKTREES STILL REGISTERED
  A worktree deleted outside Stim keeps its registry entry; \`stim status\`
  marks it pathMissing. \`gc\` prunes every such entry whose folder is
  gone from a mounted volume. \`stim worktree remove <path>\` prunes one entry,
  and the projects registered under that path, the same way. Both keep an
  entry whose volume is not mounted, since the folder may come back.

TMPDIR LEFTOVERS
  \`gc --dry-run\` reports recognized entries directly in the user's TMPDIR
  under "TMPDIR leftovers", with their count, size and a remedy: Stim temp
  directories (stim-claim-*, stim-host-*, stim-fakehome-*,
  stim-hosted-macos-*, stim-server-*, stim-ws-*), xctrace recordings
  (instruments*.ktrace), SwiftPM temp directories (TemporaryDirectory.* with a
  six-character suffix, left by swift and xcodebuild) and Jest's
  jest_<uid in base 36> cache. \`gc\` at high or critical checks them again and deletes a
  Stim temp directory, recording or SwiftPM temp directory only when nothing in
  it changed for 24 hours. It keeps a Stim temp directory that contains or
  sits inside a registered project, holds a live or unverifiable ownership
  claim or a .lock directory that is not a claim set, or cannot be listed. It
  keeps a recording or SwiftPM temp directory that cannot be read, every
  recording while an xctrace or Instruments process runs, and every SwiftPM
  temp directory while a swift or xcodebuild process runs, or when the process
  list cannot be read. Stim's own SwiftPM macOS builds run swift with the
  ambient TMPDIR, because SwiftPM keeps the locks for its shared caches there,
  so their temp directories land here too. Jest's cache and every other entry
  are never deleted. gc never follows a symlink and never acts outside TMPDIR.
  With STIM_HOME set it neither reports nor deletes them, because TMPDIR is
  shared by every Stim home. Pressure ladder rung 6 runs the same deletion
  daily in the age sweep, and at once under disk pressure.

STALE STATUS CACHE ENTRIES
  \`stim status\` caches each folder's size under $STIM_HOME/disk-usage and
  each worktree's pull request under $STIM_HOME/pull-requests, which the
  maintenance worktree check and \`gc\` also write. The merge check
  caches each worktree's verdict under $STIM_HOME/git-merge. \`worktree
  remove\` drops the entries of the worktree it removed (its checkout,
  node_modules and workspace folder, its pull request and its merge
  verdict), not the size
  entries of its owned devices' data folders. \`gc\` reports the
  entries of a folder or worktree that was removed some other way under "Stale
  status cache entries", and \`gc\` removes them. An entry counts as
  stale only when the path it records is gone and its volume is mounted (a
  measured node_modules folder follows its checkout). An entry that records no
  readable path, one whose path cannot be checked, and one on an unmounted
  volume are kept and counted under Skipped. \`status\` measures a folder again
  if it comes back.

NAMED SERVER PORTS
  worktree remove, gc and automatic maintenance release named
  allocations without signalling their listeners. gc reports named
  allocations for missing workspaces; gc releases them. Unmounted or
  unresolved paths stay registered. Only ports stop stops a named listener,
  and stim stop does not touch named ports. See guide ports.

ON THE SOURCE CHECKOUT
  git cannot remove a repository's main working tree, and deleting the source
  checkout is not what anyone meant -- so there, and only there,
  \`worktree remove\` reclaims the ENVIRONMENT and nothing else: the owned
  devices are parked or deleted, the Metro port freed, the registry entries
  (including nested monorepo app dirs) dropped, and the global workspace
  directory deleted. The tree itself is never touched, which is also why the
  dirty-tree and unpushed guards do not apply on that path.
  Run from the checkout root it reclaims every registered project under the
  checkout. Run from a subfolder (for example apps/mobile) it reclaims only
  the nearest registered project at or above that folder and the projects nested
  under it, leaves the other
  projects' devices, ports and records alone, and refuses with exit 1 when no
  project is registered at or above it.
  It ends with:
    Reclaimed the environment; the working tree stays (it is the source checkout).
  A registered project directory that is not a git repo at all gets the same
  environment reclaim -- there is nothing else remove could mean there.
  Either reclaim archives each workspace it removes, as removal of a linked
  worktree does.

FROM A SUBFOLDER OF A LINKED WORKTREE
  A linked worktree is removed only when the target is its root: run from the
  worktree root, or pass the root path. Run from a subfolder (for example
  apps/mobile), or given one, \`worktree remove\` reclaims only the nearest
  registered project at or above that folder and the projects nested under it,
  leaves the tree and the other projects alone, and refuses with exit 1 when no
  project is registered at or above it. It ends with:
    Reclaimed the environment; the working tree stays (it was run from a subfolder of the worktree).

The delete paths and \`stop\` do not check simulator occupancy. An explicit
\`stim stop\` shuts down this workspace's Stim-owned simulator, including a
simulator used by a UI-test runner. It never shuts down an unowned simulator.

If a delete fails, the device's config record is KEPT and the command reports
it. A record is what makes the device findable again, so it outlives a failed
teardown rather than turning it into an orphan.

WHICH stim-* DEVICES gc DELETES
  A \`stim-\` name is not proof that this Stim home made a device: every
  STIM_HOME names its devices the same way. gc deletes an unreferenced device
  only when this home created it: the device is listed in
  $STIM_HOME/created-devices.json, where Stim records every simulator and AVD
  it creates, or it predates that ledger and this home's config records it in
  the device pool or in a project as owned. gc lists any other stim-* device,
  including those another STIM_HOME created, under
  "Unrecognized stim-* devices" with the command that deletes it
  (\`xcrun simctl delete <udid>\`, \`avdmanager delete avd -n <name>\`, or
  \`rm -rf <dir>\` for AVD data with no registration), and
  never runs it. Boot, shutdown and teardown re-check ownership by the same
  rule, so a device that stops matching is left alone.
  Deleting an owned simulator also removes its launchd folder,
  /private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>, which holds the
  simulator's launchd.log and its SimSlim overrides and which simctl delete
  leaves behind. gc lists such folders whose UDID has no simulator in Xcode's
  device set under "Simulator launchd folders with no simulator", with sizes,
  and never deletes them: a simulator in another simctl device set is not in
  that list, and removing its folder would drop its SimSlim overrides.
  With STIM_HOME set, gc skips the device sweep because simulators and AVDs
  are machine-global, but pruning a dead project still deletes the devices its
  record marks as owned. gc lists them as to be deleted under "Device sweep
  notices"; every other stim-* device is reported as not touched.

ANDROID DATA WITHOUT A REGISTRATION
  \`gc\` also reports stim-*.avd directories whose .ini registration is
  gone. \`gc\` rechecks the directory, emulator process locks, and
  current workspace and pool references before removing that data. A registration
  under any name that points at the directory protects it. User AVDs, symlinks
  and unverifiable storage stay. The no-config and scoped-STIM_HOME
  sweep guards apply to these directories too.
  A partial avdmanager deletion is a failure even if the tool exits successfully.
  The owning workspace or pool record stays for a retry. If removing orphan
  data fails, its remaining directory is reported as stim-gc-<id>.avd on the
  next sweep.

BUILD LOCKS
  \`gc\` also reports the single-flight build locks (above): the ones whose
  builder is no longer running are debris a reboot or a kill left behind, and
  \`gc\` clears them. A lock whose builder IS running is a build in
  progress -- it is named in the report and touched by nothing, because
  removing it would put a second workspace on the same compile.
  \`gc\` also removes the empty directories under ~/.stim/process-locks
  that removed projects and worktrees leave behind; it never touches a lock
  that holds a claim. The daily age sweep removes them too.

DEVICE LEASES
  A workspace can hold a timed lease on a physical device. The lease is one
  file under ~/.stim/device-locks, and it expires on its own. \`gc\` reports
  the lease files whose expiry has passed; \`gc\` removes those
  files, re-reading each one under its own lock first, so a lease renewed in
  the meantime survives. The daily age sweep removes them the same way, and
  keeps one whose workspace is pinned with maintenance.keep or in use. Two
  kinds are reported and KEPT: a file that does
  not parse, which no run may take the device around, and an unexpired lease
  whose holder directory is gone. \`stim status\` lists every lease file with
  its holder and expiry, including holders no config knows. \`stop\` and
  \`worktree remove\` release the leases of the workspace they act on, and
  nothing else deletes a lease file but the daily age sweep, for an expired
  one: never remove another workspace's.
  They also remove the \`adb reverse\` that an \`android --device\` run added
  for this workspace's Metro port on that phone, using the serial and port the
  run recorded in its workspace state; any other reverse on the phone stays.

A device leaks when a project is abandoned WITHOUT either delete path -- the
sim survives with nothing pointing at it. \`stim gc --dry-run\` (writes
nothing, always safe) reports those; \`gc\` reaps them, and in the same
run drops the dead config ENTRIES those projects left behind and frees their
Metro ports. \`stim gc --dry-run --json\` prints the same report as one payload
(\`guide facts gc\`); show the user its sections before \`gc\`.

Ctrl-C stops pending GC actions and drains verified owned children before exiting
130. Completed actions remain applied. Unverifiable child cleanup keeps its
ownership claims and prints STIM_CLAIM_UNAVAILABLE with a recovery remedy.
With --json, cancellation prints one STIM_CANCELLED payload, or the cleanup
refusal when cleanup cannot be verified.

REMOTE EAS SESSIONS
  \`stim gc --dry-run\` stops nothing. \`gc\` can stop active stim-* EAS
  sessions of the current Expo project after workspace state is missing. The stop needs verified
  project, name, platform, and status ownership. The same run also cleans the
  local state that it can prove is stale.

  A fixed ownership record and lock live under ~/.stim/machine/eas,
  independent of STIM_HOME. Unclaimed sessions are never stopped.
  Missing config.json does not authorize cleanup.
  The exact recorded workspace state path must prove that the session ID is
  absent.
  If claim removal fails after a verified stop, the session is stopped, but the
  workspace record is kept for reconciliation.

  If a registered root is missing or unreadable, the EAS sweep fails closed and
  leaves the remote EAS session running. Independent local cleanup continues
  for entries it proves stale.

THE MIRROR IMAGE: A STALE DEVICE RECORD
  A device deleted out from under a LIVE project (by hand, or by Xcode) leaves
  the opposite problem: the record points at a sim that is not on the machine,
  and \`stim status\` warns about it on every run. \`gc\` reports these under
  "Stale device records", and \`gc\` clears the RECORD -- only the
  record. There is no device left to shut down or delete, so nothing is issued
  at simctl or avdmanager, and the project keeps its entry, its label and its
  Metro port. The next \`ios\` / \`android\` creates a fresh owned device.

  The ledger of devices Stim created (created-devices.json) keeps a
  simulator's UDID after the simulator is deleted outside Stim. \`gc\`
  reports such UDIDs under "Stale device ledger entries" when a complete
  simctl listing, unavailable simulators included, does not show them, and
  \`gc\` forgets them under the ledger lock. If the listing fails,
  nothing is reported or forgotten, and like the device sweep it is skipped
  without a config or under a scoped STIM_HOME. UDIDs are never reused, so a
  forgotten entry cannot belong to a later simulator.

  Android ledger entries are AVD names, and names are reused: another
  STIM_HOME can later create an AVD with the same name. \`gc\` reports an
  AVD name as stale only when \`emulator -list-avds\` answered, the first AVD
  root exists (a missing one may be an unmounted volume), no AVD root holds
  <name>.ini or <name>.avd, and no unfinished setup reserves the name.
  \`gc\` takes that AVD's claim, then re-checks and forgets the name
  under the config and ledger locks, so a setup in progress or an AVD
  recreated since the report keeps its entry. A name reused before \`gc\`
  runs still counts as this home's; run \`gc\` after deleting a Stim AVD by
  hand.

  The machine EAS session ledger (~/.stim/machine/eas/sessions.json) can hold
  entries that no EAS session ever had, such as ids written by a test
  fixture. \`gc\` reports an entry under "Stale EAS ledger entries" only when
  its id is not a UUID AND its workspace root is an absolute path that is
  missing on a mounted volume. A valid id, an existing root, or a root on an
  unmounted volume keeps the entry. \`gc\` re-checks each entry and
  removes it under the ledger lock; it never contacts EAS.

THE ONE CASE GC WILL NOT REAP
  If the config is gone entirely (deleted ~/.stim, or a throwaway
  STIM_HOME), gc cannot tell your stale devices from another config's LIVE
  ones, so it refuses to delete anything. It still NAMES the stim-* devices
  it found, so you can judge. Delete them yourself:
    xcrun simctl delete <udid>
    avdmanager delete avd -n <name>`,
    },
    collector: {
      summary: 'log collector reaping: an unproven collector pid, and why the app on a phone closed',
      body: () => `WHAT ELSE STOP REAPS
  The device-log collectors (\`simctl log stream\` / \`adb logcat\`) that
  \`ios\` / \`android\` attach after launch. They are recorded in
  the global workspace state.json, and nothing outside this workspace can name them,
  so \`stop\` is what stands between a teardown and a log stream that outlives
  the device it was reading. A fresh \`ios\` / \`android\` run replaces the
  previous stream, or shares it when the same device and app use another slot.
  An automatic engine update waits while any device stream is active. Run
  \`stim stop\` in that workspace to end its streams and let the update proceed.

  A PHYSICAL IPHONE'S COLLECTOR IS THE SAME PROCESS with one difference: on
  hardware the collector IS the launch. \`devicectl\` connects an app's
  streams only when it is the process that starts the app, so the collector
  runs \`devicectl device process launch --console\` itself rather than
  attaching after the fact. Each physical iPhone launch starts its own console,
  and \`stop\` ends it. Unlike simulator and Android streams, this console has
  no historical launch-log backfill, so launch verification remains unverified
  even when the app starts and the console records output.

  THE APP'S LIFETIME IS BOUND TO THAT COLLECTOR, and this is the one place a
  phone behaves worse than a simulator. \`devicectl device process launch
  --console\` keeps the app attached to the launching process, so anything that
  ends the collector ends the APP ON THE PHONE: \`stop\`, \`gc\`,
  \`worktree remove\`, a fresh \`ios --device\` run stopping its predecessor,
  a crash, the host sleeping, or the cable coming out. Measured: SIGTERM to the
  collector alone terminates the app. The phone has no owned-device registry
  entry. \`stop\` closes the app and releases this workspace's leases.
  Nothing is uninstalled, and the next \`ios --device\` starts it again.

  A sandbox-attached stimd ends with its host command, so Stim refuses a
  physical iPhone launch before installation when that is the active daemon.
  Run \`stim serve\` in a foreground terminal, then retry the launch.

  Unplugging the phone ends devicectl, which ends the collector: it unregisters
  itself and exits either way. A separately held \`device lock\` lease survives
  collector exit until released or expired; \`gc\` can remove its
  expired lease file.
  WHICH record it writes on the way out depends on devicectl's exit code, and
  that code is unverified until someone pulls a cable: a zero exit is
  collector_stopped, a non-zero one is collector_failed, because on hardware
  a non-zero devicectl exit is the only evidence a launch or console failed.
  See \`guide logs\` for what it can and cannot carry.

  Stim checks ownership before signalling a recorded collector. If it cannot
  verify the previous collector, it refuses to replace it: "The previous iOS
  log collector (pid <pid>) cannot be verified" (or Android). Android and
  simulator runs can continue with a warning; a physical iPhone cannot launch
  without its console. Verify whether that pid is still running. Once it has
  stopped, run \`stim stop\` and retry. Stim keeps the unverified record
  until it can confirm the collector is gone.
  A stream whose ownership claim is missing refuses with "The device log stream
  <id> has no verifiable claim"; inspect the stated claim and confirm the stream
  is gone before removing its record. On Windows, a daemon crash or a stream
  that exits on its own can leave a pending child marker: verify the daemon,
  launcher and descendants have stopped, then use the exact marker removal
  command in the refusal and retry.

  A different exact OS start identity proves PID reuse: the recorded collector
  is gone, and the unrelated process is never signalled. A missing, malformed,
  or unreadable identity leaves the record unverified and kept for a retry.
  Wall-clock timestamps and command names are not ownership proof.`,
    },
    memory: {
      summary: 'watchman and Gradle and Kotlin daemon memory in gc, and when gc stops them',
      body: () => `MEMORY
  Every \`gc --dry-run\` reports the long-lived helpers that grow while
  they run: the shared watchman daemon, Gradle daemons and Kotlin compile
  daemons. Each line gives the pid, physical footprint (the measure status
  uses; resident size when the footprint cannot be read), uptime and whether
  it is idle, and a kept one says why. The reclaimable line totals what
  the commands below would free now.

  \`gc\` at high or critical runs the pressure ladder with memory
  treated as under pressure, whose rung 6 stops an unused watchman of 1 GiB
  or more and the idle Gradle and Kotlin daemons, with no local build
  running, including iOS, whatever daemon.mode says. An unreadable macOS
  signal keeps daemons.
  Manual reports never record history.
  Automatic maintenance shares the pressure decision; the ladder's Gradle version cleanup
  remains independent of memory pressure. Their common build checks allow known
  iOS builds that cannot use these daemons:
    stim gc --pressure high
      watchman                    runs \`watchman watch-del\` on each stale root
                                  with no subscription or trigger, then
                                  \`watchman shutdown-server\` only when
                                  \`debug-status\` lists no client but gc's own
                                  call, every root's subscriptions and
                                  triggers were readable and no root has a
                                  trigger; otherwise the daemon is kept and
                                  the report names each client, as the Stim
                                  workspace whose dev server it belongs to
                                  where it can
      Gradle and Kotlin daemons   stops each Gradle daemon its own
                                  \`gradle --status\` reports IDLE, then each
                                  Kotlin compile daemon with no open client
                                  connection once every Gradle daemon is idle

  A stale watch root is one whose directory is gone from a mounted volume, or
  that sits in a linked worktree git pruned while its directory stayed.
  Watchman drops a root itself when its directory is deleted, so stale roots
  are rare. Removing one stops its recrawls but does not shrink the daemon;
  only a restart returns its memory. After a shutdown the next client that
  needs watchman starts it again and re-watches the roots in its state file.
  Every watchman call uses --no-spawn, so gc never starts the daemon.
  Shutting it down under a Metro that uses watchman would break that Metro's
  file watching, which is why any connected client keeps it. A Metro that
  subscribed to watchman is always a connected client (\`debug-status\` lists
  it with its pid and name), a Metro that does not use watchman is not and
  loses nothing, so gc needs no signal for a bundle in flight. Bare React
  Native Metro uses watchman whenever it is installed, but subscribes only
  when it watches files: not when CI is set. Expo SDK 56 and later use it only
  when metro.config.js sets resolver.useWatchman to true. A Metro that lost its
  connection reconnects, but a file changed before it subscribes again is
  never seen, and a Metro whose reconnect fails exits.

  Automatic maintenance shuts down an unused watchman too, by pressure ladder
  rung 6 in the age sweep and under memory pressure: when its footprint is over
  2 GiB, or over 1 GiB while the host is under memory pressure, and the same
  check gc applies finds it unused again right before the shutdown.
  A Stim dev server that started less than 60 seconds ago keeps it, since a
  Metro connects some seconds after it starts. Maintenance removes the stale
  roots first, waits for the daemon to exit (a large one took 3 to 20 seconds;
  it is reported only once its process is gone), and does nothing while
  STIM_HOME is set. The next client that needs watchman starts it again, and
  it re-crawls every root in its state file. A tool outside Stim that kept no
  connection open and used watchman starts it again the same way.

  gc finds a Gradle daemon's Gradle user home from the daemon log it holds
  open (lsof), and asks the daemon's own distribution for its status with
  that home and the daemon's Java. When every daemon that status lists for a
  home and version is idle, gc runs that distribution's \`gradle --stop\`;
  otherwise it sends SIGTERM to each idle daemon, after checking the pid still
  has the same start time. A build that picks a daemon between gc's last
  check and the stop fails and must be run again, so gc re-checks the build
  locks and the daemon's status right before each stop. Manual daemon GC also
  rechecks pressure, current settings and all build locks and slots, including
  iOS, before each stop. A build can still begin after the final check.
  The common disk and maintenance path keeps its Android or unknown-build gate.
  stim-server stops the daemons of
  offloaded builds (\`guide settings\`), so
  while it runs gc keeps those. A daemon whose home, distribution or status cannot be read is
  kept. Gradle stops an idle daemon itself after 3 hours and Kotlin after 2
  hours by default.

  With STIM_HOME set, gc skips them: they are machine-global.
  \`stim doctor\` notes a watchman footprint over 2 GiB.

  A checkout that holds its linked worktrees inside it, such as
  .worktrees/<name>, makes a watchman root there crawl every worktree's files,
  node_modules and build output. \`stim doctor\` reports each such checkout
  whose .watchmanconfig ignore_dirs does not exclude them, as
  ${WATCHMAN_NESTED_WORKTREES}, and says when watchman watches it now.
  \`stim doctor --fix\` merges the worktrees' shared parent (.worktrees) when
  git tracks nothing in it, otherwise each worktree path, into that
  checkout's .watchmanconfig and keeps every other key; it refuses a file
  that is not a JSON object or whose ignore_dirs is not an array. Watchman
  matches entries literally: \`.worktrees/\` or \`./.worktrees\` ignores
  nothing. Commit the file. Watchman reads ignore_dirs only from a root's
  .watchmanconfig, never from a global config, and only when it adds the
  root, so an existing root needs \`watchman watch-del <root>\` before the
  ignore applies. Doctor never runs watch-del or shutdown-server; a watch-del
  plus a watchman restart frees the memory now.`,
    },
    disk: {
      summary:
        'disk usage, workspace build outputs, logs and device recordings, AVD and build-log sizes, the data partition, trimming the shared caches',
      body: () => `DISK
  Logs, state, pidfiles and Xcode DerivedData are under the global workspace
  directory, and \`worktree remove\` reclaims them. \`gc\` clears
  the build outputs of workspaces idle 2 minutes or more at high or critical,
  and, at every level, those of every
  workspace over its cap or past the age sweep that is not building and did
  not run a native command in the
  last 15 minutes (WORKSPACE BUILD OUTPUTS below). Gradle retains its normal
  project build directories while sharing task outputs through its build cache.

  Android AVDs normally live under ~/.android/avd, and a booted owned AVD can
  use several GB. \`worktree remove\` parks the workspace's owned AVD with its
  user data and snapshots kept, or deletes it when the pool is off or full;
  \`gc\` at high or critical deletes parked AVDs;
  plain \`stop\` only shuts it down for reuse. Stim uses Android's default Quick Boot
  unless displayless Linux requires software rendering, where snapshots are
  disabled. The first boot and a boot after the emulator, system image, or AVD
  settings change are cold, while later supported boots load the one automatic
  snapshot saved on exit. \`stop\` waits for the emulator process and, when
  enabled, the snapshot save to finish. An emulator that ignores \`adb emu
  kill\` or is unreachable over adb is signalled once its identity is verified;
  one that still runs fails the teardown and keeps its record (see \`stim guide
  errors teardown\`).
  New owned AVDs default to an 8 GiB data partition, though project settings can
  change it. When enabled, Quick Boot keeps one automatic snapshot until the AVD is
  wiped or deleted.
  \`gc\` prints the on-disk size beside an orphaned or stale owned Android AVD
  when its content directory can be read, and beside an orphaned or stale
  owned simulator the data size simctl reports for it.

  So are the logs, and one of them is not small: build-ios.ndjson /
  build-android.ndjson hold the whole xcodebuild or gradle transcript at debug
  level, which for a cold build is tens of megabytes (74 MB measured on one
  first iOS build of a real app). They are worth that -- a build that fails at
  minute nine is unreadable any other way -- and they are per workspace, not
  global, so \`worktree remove\` reclaims them along with everything else in
  the global workspace directory. Each build starts its transcript file over, so the log
  holds one run and a workspace you keep building in does not accumulate them.
  A failed build also leaves a copy of its transcript (<log>.failed) that the
  next failed build replaces; \`gc\` does not trim it, \`worktree remove\` does.

  Simulators are large and live in the CoreSimulator device set, not in your
  project. If the disk is filling up, Stim's own devices are usually not the
  bulk of it -- Apple's default simulators and runtimes in use are. gc deletes
  the runtimes no simulator uses. Useful:
    xcrun simctl delete unavailable     # yours to run: deletes every unavailable
                                        # simulator, user-created ones included;
                                        # Stim never runs it
    xcrun simctl list devices           # see everything
    stim gc --dry-run                 # report dead entries, orphans, caches
  Xcode recreates default simulators on demand, so deleting them is safe.

New owned Android AVDs use an 8 GiB data partition by default. This leaves room
for repeated app installs while capping userdata growth below the 10 GiB
setting measured on the selected API 36 profile. Set
\`android.dataPartitionSizeGb\` to a whole number from 6 through 16384 when a
project needs another size. Android userdata grows but does not shrink, so the
setting applies only to a newly created AVD; recreate the environment to adopt
a changed value.

WORKSPACE BUILD OUTPUTS
  Each workspace directory holds derived-data/, gradle-build/, android-cas/,
  cache-provider/, js-swap-tmp/, macos/build, the staged macos/<Product>.app and macos/staging-*
  leftovers. The project's own android/app/build, android/build,
  android/.gradle, .build, the CMake directories android/.cxx and
  android/<module>/.cxx, a .dd directory laid out as Xcode DerivedData
  (a Build/ directory beside ModuleCache.noindex or Logs/), and an Exact
  app's Cargo target/ (beside its exact.mjs; or any target/ directly in the checkout with Cargo's CACHEDIR.TAG; kept while
  another process, such as a shell or an exact.mjs command, runs from or
  works in the app, and on Windows, where processes cannot be listed) count
  with them
  when git ignores every file in the directory and tracks none; one that
  fails that check, or is not in a
  git checkout, stays, and \`gc\` prints why when the check fails
  between the report and the deletion. ios/build stays: React Native's pod
  install writes podspec facades and codegen output there that only pod
  install recreates. \`gc --dry-run\` reports them as one
  detected cache, "Workspace build outputs", with a per-workspace size, last
  use and verdict. An acting \`gc\` clears them for a workspace over
  maintenance.workspaceOutputsMaxGb or unused for maintenance.olderThanDays,
  for a workspace idle for idle.dormantDays (1) at every level, and through the
  pressure ladder at high or critical: for a workspace with
  nothing running idle 2 minutes or more, and in the idle stage of a running
  one. It prints the bytes freed per category.
  A workspace whose worktree is locked with git worktree lock is never
  lightened: not its outputs, not its project's build directories, at any
  disk pressure level, including the age sweep and the pressure ladder, and gc and
  the maintenance log name the lock. The outputs also stay when git lists
  nothing for a project inside a git checkout (code lock-unknown). A
  running dev server, a booted or hosted simulator or emulator and a managed
  tunnel no longer keep them. They stay while the workspace is building (its
  native-run.lock is held, a live or unresolvable build lock or slot names
  it, or its build claim is live), while its macOS app or build runs or cannot
  be verified, and for 15 minutes after its last ios, android or macos run,
  cache hits included, as recorded in state.json's build records. Dev server
  starts, reloads and logs do not count as a native run. The shared build
  cache, the Xcode compilation cache, the Gradle caches and the Metro cache
  are never touched here; the age sweep keeps a workspace whose last use is
  unknown. macos/ itself,
  macos/runtime.lock and its claim set, workspace.json, state.json, logs/,
  other macOS files, locks and device records stay. The workspace keeps its
  devices, ports and running dev server. The pressure ladder's idle stage
  (stim guide lifecycle budget) clears them for a workspace idle 2 minutes
  under disk pressure. A running, building, unverified or hosted macOS app
  keeps its workspace untouched.
  Last use is the newest of the lastUsedAt that start, ios, android, reload,
  logs and worktree warm record in state.json, lastBuild.startedAt,
  supervisor.startedAt and the mtimes under logs/, so a dev server that keeps
  logging keeps its workspace in use.
  A workspace with none of those was last used when its workspace.json was
  written, which happens once, when the workspace is created; only a
  workspace with no readable workspace.json has an unknown last use. The
  same time decides the age sweep and automatic device
  deletion, and a workspace whose last use is unknown keeps its device.
  The next build of an unchanged app installs from the shared build cache.
  After a native change the Xcode compilation cache speeds the rebuild, but on
  React Native 0.86 Swift does not use it (explicit modules are off), so that
  build recompiles Swift. The next \`stim macos\` rebuilds its scratch from
  nothing (a full Swift build) and restages the app.

WORKTREE DEPENDENCIES
  A linked worktree that has a Stim workspace loses its node_modules and
  ios/Pods, at the root or a project root, never the source checkout's, in
  two ways: the dormant reduction at every level once its workspace has been
  idle for idle.dormantDays (1 day), and pressure ladder rung 5 at high (idle
  1 hour) and at critical (idle 2 minutes). A worktree
  locked with git worktree lock keeps them always, so a rollback checkout
  stays runnable. Otherwise a worktree keeps them while it is in use (its
  dev server runs, a native run or build holds it), while it was used within
  the stage's idle time (a git index, HEAD or reflog write, a Stim state or
  log write, or a write at the top of the directory), while git tracks a file in them, while a stim service
  or the stim on PATH runs from it, while a live process has its command
  line or working directory in it, while it holds under 256 MB of its own
  (private) bytes (a copy-on-write clone frees almost nothing), while a
  maintenance.keep pin holds it, and when the running processes cannot be
  listed (always on Windows). It also keeps them when \`stim worktree warm\`
  could not put the same thing back: warm would not copy that directory from
  the source checkout (it is missing there, excluded by .worktreeexclude or
  worktree.exclude, or inside a larger ignored directory such as a wholly
  ignored ios/), the worktree's lockfile (or ios/Podfile.lock for Pods)
  differs from the source checkout's, or the source checkout's own copy was
  not installed from its lockfile. Only a real directory inside the checkout
  whose files git ignores, reached through no link, is deleted. gc records what it deleted in the
  workspace's lightened.json; the next \`stim start\`, \`stim ios\` or
  \`stim android\` there runs \`stim worktree warm\` first to restore it, and
  refuses with STIM_DEPS_FAILED, keeping the record, when those checks no
  longer pass, when warm fails, or when it leaves a directory missing; the
  remedy asks for an install. A
  deletion that stopped part-way is finished before the warm. Other commands, such as a test run, find the directory missing
  until then. .pnpm-store stays: it is all clones and frees nothing.

WORKSPACE LOGS
  \`gc --dry-run\` reports the size of each workspace's logs/ (the workspaceLogs
  section of \`gc --dry-run --json\`). metro.ndjson, client.ndjson and device.ndjson and
  their .1 generations rotate at 8 MiB (\`guide logs\`), but a file written by
  a Stim version before the cap can be hundreds of MB. \`gc\` trims
  each of those six files that is over 16 MiB to its newest 8 MiB, cut at a
  record boundary; a file just past 8 MiB is normal rotation and stays.
  It skips a workspace that is in use (a
  dev server, a native run, a build or a held tunnel) or that has a device
  log collector recorded; \`stim stop\`
  stops the collector. Build transcripts keep the whole run and are never
  trimmed, and nothing else under logs/ is touched.

DEVICE RECORDINGS
  stim-server records owned simulators, emulators and the Stim-owned Chrome
  page while an automation tool drives them or a paired client watches them,
  into recordings/ in the workspace directory (\`guide settings\`). It keeps
  the last 15 minutes of recorded footage per device; idle time and time after
  \`stim stop\` age nothing out, so \`stop\` ends recording and the footage
  stays replayable. Across every workspace of this Stim home it keeps at most
  1 GiB, deleting the oldest footage first. Recordings are deleted by:

    stim worktree remove          that workspace's recordings, with its
                                  workspace directory
    stim gc                       the recordings of dead or orphaned
                                  workspaces, with their workspace directory;
                                  a workspace whose project root cannot be
                                  proven gone keeps them
    stim gc --pressure critical   also every device recording not being
                                  written, except those of workspaces
                                  pinned with maintenance.keep or in use
    recording.enabled false       the recordings of each workspace it turns off

  \`gc --dry-run\` lists them in the recordings section of \`gc --dry-run --json\` with each
  workspace's bytes, what a delete would remove (deleteBytes), and why the rest
  stays.

SHARED BUILD CACHES
  The caches that make a second workspace fast are alive by design and, with
  one exception, not touched by \`gc\` below critical, apart from trimming over
  their caps. The exception is the
  Swift compilation cache (the Xcode CAS under $STIM_HOME/compilation-cache):
  once it is over caches.swiftCompilationCacheMaxGb (default 0, no cap), \`gc\`
  empties it whole, since age trimming would corrupt its
  index. It is kept, with the build named, while an iOS build holds its shared
  claim or that claim is unresolved. Every \`gc --dry-run\` reports them
  anyway, each row tagged (registered) or (detected), with its size:
    stim gc --dry-run                  # report, caches included
    stim gc --pressure high            # trim Build and Metro caches to half their caps
    stim gc --pressure critical        # empty every shared cache Stim registered,
                                         # index-backed ones (the Xcode CAS) included
  $STIM_HOME/ccache (default ~/.stim/ccache) holds the Android C++ objects
  \`stim android\` compiles through ccache. ccache keeps it under CCACHE_MAXSIZE
  on its own, so \`gc\` reports its size and leaves it alone below critical,
  where it empties it whole like the Xcode CAS. That
  bound is Stim's: it sets CCACHE_MAXSIZE on the Gradle run, which wins over
  a max_size written into the cache directory's own ccache.conf.

  The Gradle build cache under GRADLE_USER_HOME (default ~/.gradle) is
  report-only as a registered cache because every Gradle build shares it:
  no level prunes or empties it there. Only the last rung, 9, removes it,
  at critical, with Gradle's other version-independent caches, while no
  Gradle process and no Stim build runs, and never from a home STIM_HOME
  scopes.

  A cache directory that \`gc\` cannot list while trimming (EACCES,
  EPERM or ELOOP, for example) is a failed trim, not an empty one: the run
  prints "N entries in <dir> could not be read or removed", records the cache
  as failed and exits 1. Fix the directory's permissions and run it again. A
  directory that is missing or is not a directory is not a failure.

  Trim rather than empty. Emptying costs the next build in every project the
  time the cache was saving.`,
    },
  },
};

export default cleanup;
