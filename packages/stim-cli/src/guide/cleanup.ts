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

Automatic maintenance has three modes. on (the default) runs the disk actions
below through gc's own removal code and logs each one. report measures, plans
and logs, and never deletes anything. off disables it. It is off in CI and
scoped STIM_HOME homes unless STIM_MAINTENANCE is explicit, so a scratch home
or CI run never deletes on its own.
Commands trigger a detached pass when a check is due: disk and memory pressure
(every minute), idle devices (every 5 minutes, maintenance.idleCheckMinutes),
directory sizes (hourly), finished worktrees (every 15 minutes) and the age
sweep (daily). guide, settings, help and every gc
invocation do not trigger it; gc without --delete prints the maintenance plan
itself.
status --watch and every running dev server supervisor also trigger checks
each minute, so the disk check runs while no command does.
Size, idle, worktree and sweep checks defer under high load. Attempts back off for at
least one minute. Measured directories are workspace build outputs and Stim's
shared native, Metro, ccache, Swift compilation and registered caches. The size
check also records the disk of each owned and parked simulator and emulator
(category owned-devices); status prints the total as "owned devices".
Pressure checks read free disk on the Stim home, projects and worker root
volumes. On macOS the memory signal is the sysctl pressure level, with no
signal if sysctl fails. Other platforms use os.freemem(); macOS never falls
back to it. Memory pressure is recorded only; stopping devices, dev servers
and helpers for memory is not automatic. The idle check shuts down (never
deletes) owned simulators and emulators idle for their workspace's
devices.idleShutdownMinutes, also with no supervisor running, through the
supervisor's idle rules and records (guide lifecycle budget). While the level is warning or critical, the
check also names abnormally large processes (guide lifecycle simslim) in
status's maintenance block and the maintenance log.

IDLE STOP: the idle check, and gc --delete unless maintenance.mode is off (its
dry run lists them in the maintenance plan), stop a workspace whose dev server
runs, whose owned simulator or emulator is booted, or whose device is hosted on a remote Mac once it has had no real
activity for maintenance.idleStopHours (default 6; 0 never; machine or project
layers; STIM_MAINTENANCE_IDLE_STOP_HOURS overrides; fractions work). Six hours
outlasts a lunch break, a meeting or an agent's pause between tasks, and still
frees the memory overnight. Real activity is the newest of: a Stim command in
the workspace (start, ios, android, macos, web, reload, logs, worktree warm),
the end of its last native build, the start, progress or end of a Metro
bundle or manifest request, or an HMR update, in metro.ndjson, an agent-device command in the workspace's
agent-device sessions, and an open stim-server live view of its device.
Device and system log lines, in-app console logs, dev server output,
collector writes and maintenance's own records never count, and an app that
only stays connected does not either. The stop is stim stop's: the dev
server stops, the owned devices shut down through centralized teardown
(never deleted), and the port is released; device leases stay. A build, a
held native-run or metro-start lock, a build lock or slot, a running macOS
app, a remote (EAS) session, an unexpired device lease, a managed tunnel
or remote lock, a running owned Chrome, a device driver other than
agent-device, a live agent-device claim with no session activity to judge,
device activity, an emulator list or an emulator's AVD name that cannot be read keeps
the workspace;
the check decides again under the native-run and metro-start locks. Each stop
is a maintenance_action line naming the idle time (gc --delete records itself
as the requester), each workspace kept past the window a maintenance_skip line
with the reason. The port is released, so status shows the workspace idle as
after stim stop, and the supervisor_stopped line in metro.ndjson names
automatic maintenance and the idle time as the requester. The next start, ios or android starts it
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
never; STIM_MAINTENANCE_IDLE_STOP_HOURS overrides), only while its maintenance.mode is on;
a project value or maintenance.keep on the client does not reach it. Server downtime is not
counted. It uses the stop a person uses, never touches a session whose journal state is
preparing, stopping or unknown, or one with a native operation or a claim it cannot prove free
(a session a crashed server left ready counts once its claim is proven free),
and writes the reason to the server log and the session's idleStop journal field.
The count is per client, not per session. A dev server that may still run after its supervisor
exited is kept until stim stop ends it. So is a dev server whose requests Stim
does not record: an Expo project before SDK 54, which cannot load Stim's Metro config
adapter, or a dev server an older Stim started, until stim stop and stim start
restart it. Unlike the other actions, it can stop the workspace whose dev server
supervisor or status --watch timer started the pass; a pass a command starts,
gc --delete included, never stops the command's own workspace.
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
     below the free-disk floor, or unused for maintenance.olderThanDays
  3. build-cache and Metro entries, least recently used first, down to
     maintenance.capTargetPercent of caches.buildCacheMaxGb or
     caches.metroCacheMaxGb, and entries unused for olderThanDays
  4. the Swift compilation cache, emptied whole, only below
     budget.hardFloorDiskGb, and kept while an iOS build holds its shared
     claim (taken for each xcodebuild run that compiles with it) or that
     claim is unresolved; the emptying holds the exclusive claim
  5. linked worktrees whose branch or pull request finished (gc's finished
     worktree rules and gc.worktreeGraceMinutes; maintenance.removeFinishedWorktrees),
     a dirty finished one after archiving its uncommitted files (ARCHIVED
     CHANGES in stim guide cleanup gc), clean ones with no commits of their
     own (NO COMMITS OF ITS OWN there), and, with
     maintenance.removeIdleWorktrees (off by default), in the age
     sweep clean, pushed ones unused for olderThanDays, as gc --delete
     --worktrees --older-than removes them, git-ignored files included; never
     an unfinished dirty one, one with unpushed commits, the source checkout,
     a locked one, or one whose last use is unknown
  6. parked simulators and emulators unused for olderThanDays in the age
     sweep, through centralized teardown with ownership checked again
  7. owned simulators and emulators of a finished worktree that is kept, such
     as a dirty one (not one locked with git worktree lock), once it finished
     and was idle for gc.worktreeGraceMinutes (at least protectRecentHours),
     and of any
     workspace idle for maintenance.deviceIdleDays (3; 0 turns it off) in the
     age sweep. Devices are recreated on the next run.
The age sweep runs every maintenance.sweepHours (24) in the background of
commands, never at a set hour.
maintenance.olderThanDays (7) is its age for steps 2, 3, 5 and 6; with 0 the
sweep removes nothing in them by age, while step 1, step 7, finished
worktrees and the cap and disk-driven parts of steps 2 and 3 still run.
Disk-driven steps stop once free space is back above the floor. Kept for
every pass: a workspace that is in use, holds a lock, was used within
maintenance.protectRecentHours, is pinned with maintenance.keep, or is the
workspace of the command that started the pass; cache entries used within
protectRecentHours, named by a project's last builds, a parked device or a
live build lock, or in a Metro store with a running or unverifiable dev
server. Anything the pass cannot verify is kept. A device is deleted only when
its workspace is idle: no dev server, native run, build, lease, managed lock,
driven or busy device, and no recorded use within the window. Below disk
pressure level 3 a pass stops a dev server only by IDLE STOP above and never
stops watchman; removing a
finished worktree or orphaned directory does tear down that workspace's own
dev server, owned devices and Chrome profile, as gc --delete does. ccache evicts by itself under
caches.ccacheMaxGb.

DISK PRESSURE LEVELS
  Level 1 is free disk under the floor above (budget.minFreeDiskGb, 20 GB).
  Level 2 is under maintenance.urgentFreeDiskGb (12), and level 3 is under
  maintenance.criticalFreeDiskGb (6) or budget.hardFloorDiskGb, where builds
  refuse. When level 1 leaves free disk under the floor, a pass goes on with
  level 2, which runs until free disk is back above the floor; level 3 runs
  only while free disk stays under the level 3 floor. At levels 2 and 3 the
  protection window is maintenance.pressureProtectMinutes (10) instead of
  protectRecentHours, except for the build outputs and build directories of
  level 2, which follow the lightening rule of gc --delete (WORKSPACE BUILD
  OUTPUTS): a running dev server, a booted or hosted device and a managed
  tunnel do not keep them, a build or a running macOS app does, and they stay
  for 15 minutes after the workspace's last ios, android or macos run.
  Each step re-measures first and stops once free disk is back above its
  level's floor, cheapest to rebuild first.
  Level 2:
    1. build outputs of workspaces, with the lightening rule above
    2. parked simulators and emulators, deleted through centralized teardown
    3. build directories of worktrees with a Stim workspace, by the same
       rule: android/app/build, android/build, android/.gradle and .build, at
       a project root, the worktree root, or apps/* and packages/*. ios/build
       stays: React Native's pod install writes the codegen output and
       podspec facades there that only pod install recreates
    4. owned simulators and emulators of workspaces idle for the short window
    5. Stim temp directories, xctrace recordings and SwiftPM temp directories
       in TMPDIR unmodified for 24 hours, with gc --delete's checks (see stim guide cleanup gc)
  Level 3:
    1. the Swift compilation cache, emptied whole under the same build rule;
       when a build keeps it, the last pass's blocked reasons name its size
       and the build
    2. finished worktrees, and clean, pushed worktrees with no commits of
       their own beyond the default branch, with the short window as grace
       period and idle window (maintenance.removeFinishedWorktrees still applies)
    3. workspaces whose dev server runs but that are otherwise inactive for
       the short window: their dev server stops and their owned simulators
       and emulators are deleted
    4. node_modules and ios/Pods at the root or a project root of idle linked
       worktrees, never the source checkout, with the running-process checks
       of WORKTREE DEPENDENCIES; when worktree warm can restore them they are
       recorded for the next start, ios or android to restore
    5. idle Gradle and Kotlin daemons, stopped as gc --delete --cache
       gradle-daemons stops them (never during a Stim build, never a busy or
       unverified one, never with STIM_HOME set), only when every Gradle
       process that keeps step 6 from running is such a daemon; the pass
       waits up to 3 seconds for them to exit
    6. Gradle version caches and wrapper distributions no registered project
       pins, once unmodified for maintenance.gradleVersionIdleDays days (7;
       0 turns steps 5 and 6 off), with the same checks as gc --cache
       gradle-versions, run again after step 5 so a daemon that did not exit
       still keeps them
  A directory is cleared only when it is a real directory inside its
  worktree, git tracks nothing in it, its worktree is not in use, is not
  locked with git worktree lock, holds no build lock and is not pinned, and, for the node_modules and ios/Pods of
  level 3, nothing under it, nor the worktree's git index, HEAD or Stim
  state, changed within the short window. A build directory of level 2 also
  stays in a worktree where no Stim workspace has recorded any state; a build
  that Stim did not run is not detected. A dirty or
  unpushed worktree can still be stopped and have these directories cleared;
  only its removal is refused. Caches of other tools (pnpm and npm stores,
  CocoaPods, SwiftPM, the shared Gradle caches) are never deleted.
  status shows the level and, at level 3, the shortfall in the last pass;
  every command prints one stderr line while the last check, at most 10
  minutes old, measured level 3.

  stim status                     last checks, plan and running pass
  stim status --json              maintenance observations and recent records
  stim logs --source maintenance  this workspace's maintenance records
  stim gc                         live pressure and cached-size preview
  stim settings set maintenance.mode off     turn automatic cleanup off
  stim settings set maintenance.mode report  plan and log, delete nothing

The machine log is $STIM_HOME/maintenance/maintenance.ndjson, rotated at
maintenance.logMaxMb with the old generation retained for
maintenance.logRetentionDays. Child crashes use maintenance/child.log.
In report mode actions and explaining skips are logged only when newly
planned; in on mode every action taken, failure and explaining skip is logged
with its bytes, and a pass record carries the bytes freed. Removal of a
worktree or orphaned directory is logged to the machine log only.
An iOS build that fails on a corrupt compilation cache logs the emptying,
or why Stim left the cache alone, with trigger "ios build", in every mode;
see \`stim guide errors STIM_COMPILATION_CACHE_CORRUPT\`.
maintenance.logChecks enables debug observations; default false.
status and doctor report invalid settings and unresolved claims with a removal
command to run only after confirming the holder is gone. Invalid cache caps
fall back to their own defaults; invalid maintenance settings disable passes.
Pin a workspace with \`stim settings set maintenance.keep true\` in its project.
The run claim serializes passes with gc --delete; gc refuses a held claim
with the holder and recovery guidance instead of waiting.
Each pass keeps a 1 MiB file, maintenance/disk-reserve. When taking the run
claim fails with ENOSPC or EDQUOT, the pass deletes it and retries once, so a
pass starts at zero free disk as long as an earlier pass left the reserve; the
pass writes it again at its end.

WHAT WAS CLEARED
Every run that deletes or changes something appends one record per item to
the machine gc log, $STIM_HOME/gc/gc.ndjson: gc --delete with any flags, gc
--idle, gc --cache --delete, each maintenance action taken, and what the budget gate
reclaims before stim start, ios or android. A dry run writes nothing, and a
gc run that only kept items writes nothing. Failed and kept items carry their
reason. The file rotates at maintenance.logMaxMb and its old generation is
kept for maintenance.logRetentionDays, like the maintenance log.
  stim logs --source gc           the retained records, oldest first
  stim logs --source gc --json    one record per line
  stim logs --source gc --errors  only the items that failed
gc works from any directory because the log is machine-wide; it cannot be
combined with other --source values and --source all leaves it out. Fields
(\`guide logs\`, GC LOG): runId, trigger (manual, desktop, maintenance or
budget), options, kind, status (done, kept or failed), label, id, path,
bytes, detail.

CLEANUP AND DISK

worktree remove stops the agent-device daemon when the workspace's
agent-device/daemon.json exists, then removes its state directory with the
workspace. If agent-device is missing or the stop fails, it keeps the directory
and reports the retry command: agent-device daemon stop --state-dir <dir> --clean.
A daemon.json whose process is gone is stale and does not block removal.
gc --delete of a finished worktree does the same.
stop closes owned-device sessions in that directory without deleting it.
See stim guide logs for AGENT_DEVICE_STATE_DIR examples.

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    parks eligible owned simulators and emulators
                            (\`guide lifecycle pool\`); deletes them when
                            parking is disabled, their setup cannot be
                            verified, or free disk is at pressure level 2 or 3
  stim gc --delete        sweeps devices this Stim home created that no project
                            references (\`guide cleanup gc\`), clears
                            verified parked simulators and emulators, and
                            runs \`stim worktree remove\` on every clean
                            linked worktree of a registered repository whose
                            branch is merged,
                            or whose pull request was merged or closed, and
                            that shows no activity within
                            gc.worktreeGraceMinutes, and deletes the owned
                            devices of a finished worktree it keeps (dirty,
                            unpushed, locked) when its workspace is idle for
                            that grace and not pinned by maintenance.keep
  automatic maintenance   deletes the owned devices of idle workspaces
                            (MAINTENANCE above)
  stim gc --delete --older-than <days>
                            also reaps the device of a workspace no Stim
                            command has used in that long, even though the
                            project is still on disk, and clears only the
                            devices parked at least that long
  stim gc --cache parked --delete
                            ERASES (never deletes) verified parked simulators
                            and wipes parked emulators' user data; they stay
                            parked for adoption (\`guide lifecycle pool\`)
  stim gc --delete --worktrees
                            also runs \`stim worktree remove\` on every clean,
                            idle, Stim-managed linked worktree
                            (\`guide cleanup gc\`)
  stim gc --idle <duration>
                            shuts DOWN (never deletes) owned devices with no
                            driver, claim or activity for that long

\`gc --delete --cache watchman\` and \`gc --delete --cache gradle-daemons\`
stop shared helper processes, not devices (\`guide cleanup memory\`).

\`worktree remove\` and \`gc --delete\` are the only two commands that delete;
\`gc --delete\` deletes worktrees only through \`worktree remove\`. \`gc
--delete\` also clears workspace build outputs, trims oversized workspace logs
(\`guide cleanup disk\`) and removes orphaned workspace directories, never a
checkout. Device recordings can also go without either: stim-server prunes
them, and turning recording.enabled off deletes them (\`guide cleanup disk\`). \`stim stop\` shuts a device
DOWN and leaves it assigned, which is what makes returning to a branch cost a
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
  exists. It deletes records past their age or count limit first, then expires
  recordings, agent actions and logs by age from removedAt; trims per-workspace
  logs (oldest rotated generations, then build logs, then oldest other files);
  and removes the largest kind of the oldest archive while over total caps.
  Archives with expired artifacts keep their record until the record limit. recording.enabled false at machine scope deletes archived
  recordings on the next retention pass. Sizes are binary GB/MB; 0 keeps none.
  See stim guide settings for the nine archive.* keys and overrides.

  stim gc --cache archived                     list ids, kinds, bytes and expiry
  stim gc --delete --cache archived             delete every archive
  stim gc --delete --cache archived --older-than 14
                                                only removed at least 14 days ago
  stim gc --delete --cache archived:<id>         delete one; ignores --older-than
  stim gc --delete --cache archived-logs        delete logs, keep records
  stim gc --delete --cache archived-recordings  delete recordings, keep records
  stim gc --delete --cache archived-agent       delete agent actions, keep records
  stim gc --delete --cache archived-logs:<id>   one kind of one archive, keep its record
  (archived-recordings:<id> and archived-agent:<id> likewise; they ignore --older-than;
  an unknown id refuses with STIM_BAD_ARG)
  Per-kind selectors without an id also accept --older-than, measured from removedAt.
  Normal gc, --cache all, --worktrees and unscoped --older-than exclude archives.
  Archive scopes report abandoned staging directories and delete only those
  with no live or unresolved claim. An unresolved claim names its removal command.

  Directories are 0700 and files 0600. No redaction is applied; logs and agent
  actions can contain secrets. Use archive.enabled false for a sensitive repo.
  Archived logs and replay are not exposed through CLI or app readers yet.`,
    },
    gc: {
      summary:
        'what gc and worktree remove delete, keep and refuse: orphans, stale records, locks, leases, EAS sessions',
      body: () => `PARKED HOSTED DEVICES
On a hosting Mac, unscoped gc lists parked hosted iOS/Android devices by session,
client id, device label, parked time and private-home ledger ownership.
gc --delete takes each session claim and deletes through the packaged stop worker
in that session's home; held claims, changed sessions and unverified ownership
keep the device. Android deletion also requires the AVD to be visible from this
shell; otherwise run gc with the server's ANDROID_AVD_HOME/HOME. Devices no longer
listed in their session ledger are already removed and skipped. An unreadable
journal keeps every hosted device. --older-than
filters by parked time; --cache scopes omit hosted sessions. The CLI never writes
the server journal: stim-server reconciliation clears the parked marker after
successful deletion leaves the session ledger empty.

AGENT-DEVICE (REPORT ONLY)
Unscoped gc reports agent-device runner builds by platform and entry, last use,
agent-device and Xcode versions, sessions, logs, other state, workspace state
and hosted driver state. Stim never selects this state as a cache.
Stim never trims or deletes the shared runner builds, sessions, logs and other
state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.
A live owner or runner lease marks an entry in use. A lock marks it in use only
when its owner is live or unknown. Unreadable lock owners and unreadable or unknown
leases conservatively mark entries in use. Dead lock owners and leases do not.
Use agent-device's own tooling or remove directories yourself to clear unused
state. --cache scopes omit this report, including --cache all.

SWIFTPM CACHE (REPORT ONLY)
Unscoped gc also reports the user-level SwiftPM cache after agent-device:
~/Library/Caches/org.swift.swiftpm on macOS, or org.swift.swiftpm under
XDG_CACHE_HOME (default ~/.cache) elsewhere. It is shared by every SwiftPM
build on this machine. Stim reports it and never deletes it. It is never in
caches, never changes actionable, and --delete and --older-than never select
it. Any --cache scope, including all, omits measurement and reports
sections.swiftpmCache: null. Only stats and unscoped gc measure it.

GRADLE VERSIONS
\`stim gc --cache gradle-versions\` lists, and with --delete removes, the
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
entries, or, with --older-than <days>, when anything under it changed within
that many days.
Right before removal gc lists processes and reads pins again, then renames
each directory to a .stim-delete-* sibling and deletes it. A later gc
--delete --cache gradle-versions finishes any .stim-delete-* left by a failed
removal, even while the versions are blocked (not while the home is outside
a scoped STIM_HOME or its layout is unsafe), since nothing uses those
directories, and reports it again when that fails; plain gc --delete and
automatic maintenance never touch them. modules-2, build-cache-1, jdks and
other shared Gradle caches are never deleted, and --cache all never includes these versions.
With STIM_HOME set, gc deletes nothing in a Gradle home outside it. At disk
pressure level 3 automatic maintenance first stops the idle Gradle and Kotlin
daemons gc --delete --cache gradle-daemons would stop, only when every Gradle
process that keeps a version is such a daemon, then does the same for
versions unmodified for maintenance.gradleVersionIdleDays days (7; 0 turns
both off). A manual gc --delete --cache gradle-versions never stops daemons.

OTHER TOOLS' MACHINE-WIDE CACHES (REPORT ONLY)
Unscoped gc also reports large caches other tools keep for the whole machine,
each with its size and the owning tool's own remedy:
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
  its own. The remedy for a version is stim gc --delete --cache
  gradle-versions (see GRADLE VERSIONS); modules-2 stays report only.
- iOS simulator runtimes with their simulator count. Only a deletable
  runtime no simulator uses gets the remedy xcrun simctl runtime delete <id>.
- Xcode device support entries under ~/Library/Developer/Xcode/*DeviceSupport.
  Xcode copies an entry again when that device next connects.
- agent-device runner builds grouped by agent-device and Xcode build version,
  compared with the installed agent-device and Xcode. agent-device has no
  prune command; remove an entry not in use by hand.
$STIM_HOME/machine-cache-usage.json caches the sizes, simulator runtimes and
tool versions for 10 minutes and measures again when the measured
directories change. Stim never deletes any of these. They are never in
caches, never change actionable, and --delete and --older-than never select
them. Any --cache scope omits measurement and reports sections.machineCaches:
null.

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
  gc --delete deletes only a remove-* entry with a valid trash.json whose
  claim is free and whose worktree path is gone, which finishes a removal that
  was interrupted, and keeps any other directory. An entry whose worktree path
  still exists, as after a removal killed between the rename and git, stays
  with the reason; if that worktree is the one the entry came from, run
  \`stim worktree remove\` on it to finish the removal.
  gc never moves the directories back. Warm uses the same trash for the
  known paths it deletes from a copy (such as a copied .pnpm-store); gc
  --delete deletes such an entry (trash.json kind warm) once its claim is free,
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
  --force, a worktree that an installed stim-server service runs from
  (STIM_WORKTREE_SERVICE; see guide errors). A project root whose
  existence cannot be read (a permission error) is never treated as deleted.

SWEEPING FINISHED WORKTREES
  Every \`gc\` without --cache looks at every registered project root,
  every workspace.json root, and every linked worktree \`git worktree list\`
  shows for a registered project's repository, whether or not a stim command
  ever ran in it. It groups them by git worktree and reports each linked
  worktree with the reason it is removed or kept. A worktree is finished when
  its branch is merged into the default branch, or its pull request was
  merged or closed (PULL REQUESTS below). A clean worktree with no commits
  of its own counts as finished once idle (NO COMMITS OF ITS OWN below).
  \`--worktrees\` also removes
  one that is idle: no recorded use for --older-than days, 7 without it; a
  worktree whose last use is unknown is kept, unless it has no commits of its
  own beyond the default branch (NO COMMITS OF ITS OWN below). Each needs a
  clean state, except a finished one whose changes are archived;
  a worktree is kept when it is the source checkout, bare, locked, holds
  another worktree (worktree remove refuses it too), in use,
  dirty and not finished, or dirty and finished when its changes cannot be
  archived (ARCHIVED CHANGES below; untracked files count; pod install churn and
  watchman's untracked \`.watchman-cookie-*\` files alone do not), unpushed
  (commits no remote-tracking ref or other local branch reaches), or has
  initialized submodules. Without --worktrees, the report leaves out the
  source checkout and roots outside git.

  Each worktree line also shows its in-tree build state: the size of the
  build and dependency directories maintenance clears (DISK PRESSURE LEVELS
  above) and a root .pnpm-store, largest first (APFS clones count in full).
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
  worktree until \`stim stop\` in it, or \`gc --idle <duration>\`, shuts
  the device down. A worktree that holds the running stim or the realpath of
  the \`stim\` on PATH is in use too, and \`stim worktree remove\` refuses it
  even with --force, as it refuses an installed stim-server service's checkout.

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

  FRESH STATE: \`gc --delete\` and the maintenance worktree check fetch the
  default branch and ask gh as MERGED and PULL REQUESTS below describe. The
  worktree check runs in the background when a stim command starts a
  maintenance pass that has it due, every maintenance.worktreeCheckMinutes;
  plain gc never starts one. It writes each pull request lookup into the
  cache \`status --watch\` also writes. A report without --delete runs no
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
  its reason not-merged becomes merge-unknown. With maintenance.mode off or
  maintenance.removeFinishedWorktrees false the check never runs, and only
  \`gc --delete\` refreshes. \`gc --delete\` always collects fresh state
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
  merge-unknown, with the remedy); with --worktrees an idle worktree is still
  removed. A squash- or rebase-merged branch whose upstream is gone (deleted
  after the merge and pruned locally) has commits only it reaches; they do
  not block removal, because their change is on the default branch, and the
  branch is kept.

  NO COMMITS OF ITS OWN: a worktree whose HEAD the default branch contains
  and whose branch has no commit made on it (fresh, cut from another
  branch, reset onto one, or a detached HEAD; the MERGED rule above) holds
  nothing git would lose, but looks the same as one just made by git
  worktree add. gc --delete and the maintenance worktree check remove a clean
  one without an open pull request once the RECENT ACTIVITY sources above
  are older than gc.worktreeGraceMinutes and maintenance.protectRecentHours
  (2 hours by default), and never younger than 5 minutes (reason
  recent-activity until then, activity-unknown when they cannot be read). At
  disk pressure level 3 the window is maintenance.pressureProtectMinutes,
  still at least 5 minutes. Removal re-checks, under the removal locks, that
  HEAD did not move and the worktree is still idle, and \`stim worktree
  remove\` still refuses dirty or unpushed work. A process Stim does not
  track, such as a benchmark run from a detached build, does not keep it.

  ARCHIVED CHANGES: a dirty worktree that is otherwise finished, idle past
  RECENT ACTIVITY and not in use is archived, then removed, by gc --delete
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
  budget.hardFloorDiskGb, whose staged version of a file differs from its
  working tree, or that holds an untracked nested repository; disk
  pressure level 3 never archives. Archives are 0700 and 0600 with no
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
  not installed, not signed in, or fails, the JSON pullRequestUnknown field
  and the report say why, and gc judges from git alone. A detached HEAD is
  not looked up. \`stim worktree remove\` makes the same check when
  local-only commits alone would refuse the removal, and accepts a merged
  pull request whose head is or contains HEAD.
    stim gc                                        # report merged worktrees from local state
    stim gc --delete                               # refresh, then remove them
    stim gc --delete --worktrees --older-than 3    # also the clean idle ones
  --cache with --worktrees is refused with STIM_BAD_ARG; run them separately.
  With --delete it runs the \`stim worktree remove\` pipeline, never --force,
  on each removable worktree. That pipeline re-inspects the worktree and
  re-checks use and recent activity under the removal locks, and idleness
  for an idle worktree, an unchanged HEAD for a merged one, or both for one
  with no commits of its own, then parks
  devices through the same teardown and handles the
  branch exactly as a manual \`stim worktree remove\`, which keeps the
  checkout when its HEAD moves while devices are reclaimed. A worktree that
  changed since the report is kept with the reason. A worktree that fails is
  reported, gc exits 1, and the sweep continues.

IDLE DEVICES
  Plain \`gc\` lists booted owned simulators and emulators whose \`status\`
  activity is idle (\`guide facts status\`), with how long. \`gc --idle
  <duration>\` (30m, 2h, 1d) shuts down each one idle at least that long
  through the same teardown as \`stim stop\`: ownership is re-checked, the
  device and its record stay, and the next \`ios\` or \`android\` run boots
  it again. It acts without --delete and never deletes. It skips a device
  that is driven (agent-device, a device lock, a test runner), whose
  activity is unknown, whose idle time is unknown, or whose workspace has a
  build in progress, and re-checks each device just before shutting it down.
  Physical and remote devices are out of scope. --cache with --idle is
  refused with STIM_BAD_ARG.
    stim gc                 # lists idle devices
    stim gc --idle 2h       # shuts down those idle 2 hours or more

ORPHANED WORKSPACE DIRECTORIES
  A worktree deleted with \`git worktree remove\`, \`rm -rf\` or a /tmp wipe
  leaves its $STIM_HOME/workspaces/<name> directory behind with no registry
  entry. \`gc\` reads each directory's workspace.json and reports it under
  "Orphaned workspace directories" when the recorded project root is gone,
  its volume is mounted, no registry key equals it or sits under it, and the
  workspace is not in use. \`gc --delete\` re-checks each one, then removes
  it. A directory with a missing or unparseable workspace.json, or a root on
  an unmounted volume, is reported under Skipped and never deleted.

DELETED WORKTREES STILL REGISTERED
  A worktree deleted outside Stim keeps its registry entry; \`stim status\`
  marks it pathMissing. \`gc --delete\` prunes every such entry whose folder is
  gone from a mounted volume. \`stim worktree remove <path>\` prunes one entry,
  and the projects registered under that path, the same way. Both keep an
  entry whose volume is not mounted, since the folder may come back.

TMPDIR LEFTOVERS
  \`gc\` without --cache reports recognized entries directly in the user's TMPDIR
  under "TMPDIR leftovers", with their count, size and a remedy: Stim temp
  directories (stim-claim-*, stim-host-*, stim-fakehome-*,
  stim-hosted-macos-*, stim-server-*, stim-ws-*), xctrace recordings
  (instruments*.ktrace), SwiftPM temp directories (TemporaryDirectory.* with a
  six-character suffix, left by swift and xcodebuild) and Jest's
  jest_<uid in base 36> cache. \`gc --delete\` checks them again and deletes a
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
  shared by every Stim home. Automatic maintenance runs the same deletion at disk pressure
  level 2.

STALE STATUS CACHE ENTRIES
  \`stim status\` caches each folder's size under $STIM_HOME/disk-usage and
  each worktree's pull request under $STIM_HOME/pull-requests, which the
  maintenance worktree check and \`gc --delete\` also write. \`worktree
  remove\` drops the entries of the worktree it removed (its checkout,
  node_modules and workspace folder, and its pull request), not the size
  entries of its owned devices' data folders. \`gc\` reports the
  entries of a folder or worktree that was removed some other way under "Stale
  status cache entries", and \`gc --delete\` removes them. An entry counts as
  stale only when the path it records is gone and its volume is mounted (a
  measured node_modules folder follows its checkout). An entry that records no
  readable path, one whose path cannot be checked, and one on an unmounted
  volume are kept and counted under Skipped. \`status\` measures a folder again
  if it comes back.

NAMED SERVER PORTS
  worktree remove, gc --delete and automatic maintenance release named
  allocations without signalling their listeners. gc reports named
  allocations for missing workspaces; gc --delete releases them. Unmounted or
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
  With STIM_HOME set, gc skips the device sweep because simulators and AVDs
  are machine-global, but pruning a dead project still deletes the devices its
  record marks as owned. gc lists them as to be deleted under "Device sweep
  notices"; every other stim-* device is reported as not touched.

ANDROID DATA WITHOUT A REGISTRATION
  \`gc\` also reports stim-*.avd directories whose .ini registration is
  gone. \`gc --delete\` rechecks the directory, emulator process locks, and
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
  \`gc --delete\` clears them. A lock whose builder IS running is a build in
  progress -- it is named in the report and touched by nothing, because
  removing it would put a second workspace on the same compile.

DEVICE LEASES
  A workspace can hold a timed lease on a physical device. The lease is one
  file under ~/.stim/device-locks, and it expires on its own. \`gc\` reports
  the lease files whose expiry has passed; \`gc --delete\` removes those
  files, re-reading each one under its own lock first, so a lease renewed in
  the meantime survives. Two kinds are reported and KEPT: a file that does
  not parse, which no run may take the device around, and an unexpired lease
  whose holder directory is gone. \`stim status\` lists every lease file with
  its holder and expiry, including holders no config knows. \`stop\` and
  \`worktree remove\` release the leases of the workspace they act on, and
  nothing else deletes a lease file: never remove another workspace's.
  They also remove the \`adb reverse\` that an \`android --device\` run added
  for this workspace's Metro port on that phone, using the serial and port the
  run recorded in its workspace state; any other reverse on the phone stays.

A device leaks when a project is abandoned WITHOUT either delete path -- the
sim survives with nothing pointing at it. \`stim gc\` (no flag, writes
nothing, always safe) reports those; \`gc --delete\` reaps them, and in the same
run drops the dead config ENTRIES those projects left behind and frees their
Metro ports. \`stim gc --json\` prints the same report as one payload
(\`guide facts gc\`); show the user its sections before \`gc --delete\`.

Ctrl-C stops pending GC actions and drains verified owned children before exiting
130. Completed actions remain applied. Unverifiable child cleanup keeps its
ownership claims and prints STIM_CLAIM_UNAVAILABLE with a recovery remedy.
With --json, cancellation prints one STIM_CANCELLED payload, or the cleanup
refusal when cleanup cannot be verified.

REMOTE EAS SESSIONS
  Plain \`stim gc\` is a dry run. \`gc --delete\` can stop active stim-* EAS
  sessions after workspace state is missing. The stop needs verified
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
  "Stale device records", and \`gc --delete\` clears the RECORD -- only the
  record. There is no device left to shut down or delete, so nothing is issued
  at simctl or avdmanager, and the project keeps its entry, its label and its
  Metro port. The next \`ios\` / \`android\` creates a fresh owned device.

  The ledger of devices Stim created (created-devices.json) keeps a
  simulator's UDID after the simulator is deleted outside Stim. \`gc\`
  reports such UDIDs under "Stale device ledger entries" when a complete
  simctl listing, unavailable simulators included, does not show them, and
  \`gc --delete\` forgets them under the ledger lock. If the listing fails,
  nothing is reported or forgotten, and like the device sweep it is skipped
  without a config or under a scoped STIM_HOME. UDIDs are never reused, so a
  forgotten entry cannot belong to a later simulator.

  Android ledger entries are AVD names, and names are reused: another
  STIM_HOME can later create an AVD with the same name. \`gc\` reports an
  AVD name as stale only when \`emulator -list-avds\` answered, the first AVD
  root exists (a missing one may be an unmounted volume), no AVD root holds
  <name>.ini or <name>.avd, and no unfinished setup reserves the name.
  \`gc --delete\` takes that AVD's claim, then re-checks and forgets the name
  under the config and ledger locks, so a setup in progress or an AVD
  recreated since the report keeps its entry. A name reused before \`gc\`
  runs still counts as this home's; run \`gc\` after deleting a Stim AVD by
  hand.

  The machine EAS session ledger (~/.stim/machine/eas/sessions.json) can hold
  entries that no EAS session ever had, such as ids written by a test
  fixture. \`gc\` reports an entry under "Stale EAS ledger entries" only when
  its id is not a UUID AND its workspace root is an absolute path that is
  missing on a mounted volume. A valid id, an existing root, or a root on an
  unmounted volume keeps the entry. \`gc --delete\` re-checks each entry and
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
  the device it was reading. A fresh \`ios\` / \`android\` run also kills the
  previous collector for that platform before starting its own.

  A PHYSICAL IPHONE'S COLLECTOR IS THE SAME PROCESS with one difference: on
  hardware the collector IS the launch. \`devicectl\` connects an app's
  streams only when it is the process that starts the app, so the collector
  runs \`devicectl device process launch --console\` itself rather than
  attaching after the fact. It registers under the same \`ios\` key, carries
  the same --root in its title, is proven and replaced by the same pid rules,
  and is reaped by the same \`stop\`.

  THE APP'S LIFETIME IS BOUND TO THAT COLLECTOR, and this is the one place a
  phone behaves worse than a simulator. \`devicectl device process launch
  --console\` keeps the app attached to the launching process, so anything that
  ends the collector ends the APP ON THE PHONE: \`stop\`, \`gc --delete\`,
  \`worktree remove\`, a fresh \`ios --device\` run stopping its predecessor,
  a crash, the host sleeping, or the cable coming out. Measured: SIGTERM to the
  collector alone terminates the app. The phone has no owned-device registry
  entry. \`stop\` closes the app and releases this workspace's leases.
  Nothing is uninstalled, and the next \`ios --device\` starts it again.

  Unplugging the phone ends devicectl, which ends the collector: it unregisters
  itself and exits either way. A separately held \`device lock\` lease survives
  collector exit until released or expired; \`gc --delete\` can remove its
  expired lease file.
  WHICH record it writes on the way out depends on devicectl's exit code, and
  that code is unverified until someone pulls a cable: a zero exit is
  collector_stopped, a non-zero one is collector_failed, because on hardware
  a non-zero devicectl exit is the only evidence a launch or console failed.
  See \`guide logs\` for what it can and cannot carry.

  Before signalling a recorded collector pid, \`stop\`, \`gc --delete\`,
  \`worktree remove\`, and a fresh \`ios\` / \`android\` run each read that
  persisted process identity and require it to match the exact process
  registered for this workspace and platform. A pid that cannot be proven is
  reported and left alone: the
  kernel reuses pids, and an unreaped record is a smaller problem than a
  signal delivered to someone else's process. A fresh \`ios\` / \`android\`
  run starts its replacement anyway, leaving the unproven pid to clear on its
  own. A collector started by an older Stim has no process identity token, so
  it reports as unverified until its record clears -- which happens when its
  own device's log stream ends and it unregisters itself, or when the next
  \`ios\` / \`android\` run overwrites the record with its own, whichever
  comes first; the old process itself keeps running until it exits on its own.

  A different exact OS start identity proves PID reuse: the recorded collector
  is gone, and the unrelated process is never signalled. A missing, malformed,
  or unreadable identity leaves the record unverified and kept for a retry.
  Wall-clock timestamps and command names are not ownership proof.`,
    },
    memory: {
      summary:
        'watchman and Gradle and Kotlin daemon memory in gc, and when gc --delete --cache watchman or gradle-daemons stops them',
      body: () => `MEMORY
  Every \`gc\` without --cache, and \`gc --cache watchman\` or
  \`gc --cache gradle-daemons\`, reports the long-lived helpers that grow while
  they run: the shared watchman daemon, Gradle daemons and Kotlin compile
  daemons. Each line gives the pid, physical footprint (the measure status
  uses; resident size when the footprint cannot be read), uptime and whether
  it is idle, and a kept one says why. The reclaimable line totals what
  the two commands below would free now.

  Only these two commands stop anything, and each acts only on its own kind.
  Neither a plain \`gc --delete\` nor \`--cache all\` touches them:
    stim gc --delete --cache watchman
                                  runs \`watchman watch-del\` on each stale root
                                  with no subscription or trigger, then
                                  \`watchman shutdown-server\` only when
                                  \`debug-status\` lists no client but gc's own
                                  call and no root has a trigger; otherwise
                                  the daemon is kept and the report names
                                  each client, as the Stim workspace whose
                                  dev server it belongs to where it can
    stim gc --delete --cache gradle-daemons
                                  stops each Gradle daemon its own
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
  file watching, which is why any connected client keeps it.

  gc finds a Gradle daemon's Gradle user home from the daemon log it holds
  open (lsof), and asks the daemon's own distribution for its status with
  that home and the daemon's Java. When every daemon that status lists for a
  home and version is idle, gc runs that distribution's \`gradle --stop\`;
  otherwise it sends SIGTERM to each idle daemon, after checking the pid still
  has the same start time. A build that picks a daemon between gc's last
  check and the stop fails and must be run again, so gc re-checks the build
  locks and the daemon's status right before each stop. Nothing is stopped while an Android build lock, or a build slot no
  iOS build holds, is live or unresolved. stim-server stops the daemons of
  offloaded builds (server.gradleDaemonIdleMinutes, \`guide settings\`), so
  while it runs gc keeps those. A daemon whose home, distribution or status cannot be read is
  kept. Gradle stops an idle daemon itself after 3 hours and Kotlin after 2
  hours by default.

  --older-than does not apply to these kinds and is refused with
  STIM_BAD_ARG. With STIM_HOME set, gc skips them: they are machine-global.
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
  directory, and \`worktree remove\` reclaims them. \`gc --delete\` lightens
  every workspace that is not building and did not run a native command in
  the last 15 minutes, clearing its build outputs (WORKSPACE BUILD OUTPUTS
  below), and keeps the rest. Gradle retains its normal
  project build directories while sharing task outputs through its build cache.

  Android AVDs normally live under ~/.android/avd, and a booted owned AVD can
  use several GB. \`worktree remove\` parks the workspace's owned AVD with its
  user data and snapshots kept, or deletes it when the pool is off or full;
  \`gc --cache parked --delete\` wipes a parked AVD's user data and snapshots;
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
  bulk of it -- Apple's default simulators and old runtimes are. Useful:
    xcrun simctl delete unavailable     # sims for runtimes you removed
    xcrun simctl list devices           # see everything
    stim gc                           # report dead entries, orphans, caches
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
  android/.gradle and .build count with them when git ignores every file in
  the directory and tracks none; one that fails that check, or is not in a
  git checkout, stays, and \`gc --delete\` prints why when the check fails
  between the report and the deletion. ios/build stays: React Native's pod
  install writes podspec facades and codegen output there that only pod
  install recreates. \`gc\` reports them as one
  detected cache, "Workspace build outputs", with a per-workspace size, last
  use and verdict. Plain \`gc --delete\` lightens every workspace, before
  anything else, by clearing them, and prints the bytes freed per workspace.
  A workspace whose worktree is locked with git worktree lock is never
  lightened: not its outputs, not its project's build directories, at any
  disk pressure level, including gc --older-than and the budget, and gc and
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
  are never touched. \`--older-than <days>\` limits that to
  workspaces idle at least that long, and keeps one whose last use is
  unknown. \`--cache workspaces\` acts on them alone, except in the workspace
  directories that plain \`gc --delete\` removes whole (dead projects and
  orphaned directories); \`--cache all\` includes them. macos/ itself,
  macos/runtime.lock and its claim set, workspace.json, state.json, logs/,
  other macOS files, locks and device records stay. The workspace keeps its
  devices, ports and running dev server. Automatic maintenance at disk
  pressure level 2 clears them by the same rule (DISK PRESSURE LEVELS); level
  1 keeps its own rules. A running, building, unverified or hosted macOS app
  keeps its workspace untouched.
    stim gc --delete --cache workspaces --older-than 7
  Last use is the newest of the lastUsedAt that start, ios, android, reload,
  logs and worktree warm record in state.json, lastBuild.startedAt,
  supervisor.startedAt and the mtimes under logs/, so a dev server that keeps
  logging keeps its workspace in use.
  A workspace with none of those was last used when its workspace.json was
  written, which happens once, when the workspace is created; only a
  workspace with no readable workspace.json has an unknown last use. The
  same time decides \`--older-than\` device reaping and automatic device
  deletion, and a workspace whose last use is unknown keeps its device.
  The next build of an unchanged app installs from the shared build cache.
  After a native change the Xcode compilation cache speeds the rebuild, but on
  React Native 0.86 Swift does not use it (explicit modules are off), so that
  build recompiles Swift. The next \`stim macos\` rebuilds its scratch from
  nothing (a full Swift build) and restages the app.

WORKTREE DEPENDENCIES
  Plain \`gc --delete\` also lightens linked worktrees: it deletes the
  node_modules and ios/Pods at the root or a project root of a linked
  worktree that has a Stim workspace, never the source checkout. A worktree
  locked with git worktree lock keeps them always, so a rollback checkout
  stays runnable. Otherwise a worktree keeps them while it is in use (its
  dev server runs, a native run or build holds it), while it was used in
  the last 15 minutes (a git index, HEAD or reflog write, a Stim state or
  log write, or a write at the top of the directory), while git tracks a file in them, while a stim-server service
  or the stim on PATH runs from it, while a live process has its command
  line or working directory in it, and when the running processes cannot be
  listed (always on Windows). It also keeps them when \`stim worktree warm\`
  could not put the same thing back: warm would not copy that directory from
  the source checkout (it is missing there, excluded by .worktreeexclude or
  worktree.exclude, or inside a larger ignored directory such as a wholly
  ignored ios/), the worktree's lockfile (or ios/Podfile.lock for Pods)
  differs from the source checkout's, or the source checkout's own copy was
  not installed from its lockfile. gc records what it deleted in the
  workspace's lightened.json; the next \`stim start\`, \`stim ios\` or
  \`stim android\` there runs \`stim worktree warm\` first to restore it, and
  refuses with STIM_DEPS_FAILED, keeping the record, when those checks no
  longer pass, when warm fails, or when it leaves a directory missing. A
  deletion that stopped part-way is finished before the warm. Other commands, such as a test run, find the directory missing
  until then. .pnpm-store stays: it is all clones and frees nothing.

WORKSPACE LOGS
  \`gc\` reports the size of each workspace's logs/ (the workspaceLogs
  section of \`gc --json\`). metro.ndjson, client.ndjson and device.ndjson and
  their .1 generations rotate at 8 MiB (\`guide logs\`), but a file written by
  a Stim version before the cap can be hundreds of MB. \`gc --delete\` trims
  each of those six files that is over 16 MiB to its newest 8 MiB, cut at a
  record boundary; a file just past 8 MiB is normal rotation and stays.
  \`--older-than\` does not limit it. It skips a workspace that is in use (a
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
    stim gc --delete              the recordings of dead or orphaned
                                  workspaces, with their workspace directory;
                                  a workspace whose project root cannot be
                                  proven gone keeps them
    stim gc --delete --older-than <days>
                                  also footage recorded before that many days
                                  ago, in every workspace
    stim gc --delete --cache recordings
                                  every workspace's recordings, and nothing
                                  else; --cache all includes them
    recording.enabled false       the recordings of each workspace it turns off

  \`gc\` lists them in the recordings section of \`gc --json\` with each
  workspace's bytes, what a delete would remove (deleteBytes), and why the rest
  stays.

SHARED BUILD CACHES
  The caches that make a second workspace fast are alive by design and never
  included in a plain \`gc --delete\`. Every \`gc\` run reports them anyway,
  each row tagged (registered) or (detected), with its size:
    stim gc                            # report, caches included
    stim gc --delete --older-than 30   # trim entries nothing has used
    stim gc --delete --cache all       # empty them whole, index-backed ones
                                         # (the Xcode CAS) included
  $STIM_HOME/ccache (default ~/.stim/ccache) holds the Android C++ objects
  \`stim android\` compiles through ccache. ccache keeps it under CCACHE_MAXSIZE
  on its own, so \`gc\` reports its size and leaves it alone; --older-than
  skips it, and \`--cache all\` empties it whole like the Xcode CAS. That
  bound is Stim's: it sets CCACHE_MAXSIZE on the Gradle run, which wins over
  a max_size written into the cache directory's own ccache.conf.

  The Gradle build cache under GRADLE_USER_HOME (default ~/.gradle) is
  report-only because every Gradle build shares it. Stim reports its size
  but never prunes or empties it, including with --older-than or --cache all.

  A cache directory that \`gc --delete --older-than\` cannot list (EACCES,
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
