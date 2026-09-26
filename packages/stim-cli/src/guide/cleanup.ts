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

CLEANUP AND DISK

WHAT RECLAIMS AN OWNED DEVICE
  stim worktree remove    parks eligible owned simulators and emulators
                            (\`guide lifecycle pool\`); deletes them when
                            parking is disabled or their setup cannot be verified
  stim gc --delete        sweeps devices this Stim home created that no project
                            references (\`guide cleanup gc\`), clears
                            verified parked simulators and emulators, and
                            runs \`stim worktree remove\` on every clean,
                            Stim-managed linked worktree whose branch is merged
                            and that shows no activity within
                            gc.worktreeGraceMinutes
  stim gc --delete --older-than <days>
                            also reaps the device of a workspace no Stim
                            command has used in that long, even though the
                            project is still on disk, and clears only the
                            devices parked at least that long
  stim gc --delete --worktrees
                            also runs \`stim worktree remove\` on every clean,
                            idle, Stim-managed linked worktree
                            (\`guide cleanup gc\`)
  stim gc --idle <duration>
                            shuts DOWN (never deletes) owned devices with no
                            driver, claim or activity for that long

\`worktree remove\` and \`gc --delete\` are the only two commands that delete;
\`gc --delete\` deletes worktrees only through \`worktree remove\`. \`gc
--delete\` also clears workspace build outputs (\`guide cleanup disk\`) and
orphaned workspace directories, never a checkout. \`stim stop\` shuts a device
DOWN and leaves it assigned, which is what makes returning to a branch cost a
boot rather than a create, a provision and a reinstall.

Before shutting down, parking or deleting an owned device, Stim best-effort
closes local agent-device sessions bound to its exact iOS UDID or live Android
serial. An Android session must also name the owned AVD, because the next
emulator on a console port reuses its serial. \`stop\` closes a session only
when agent-device's claim on the device names it and was taken inside this
workspace; sessions from another workspace or claim stay open. Stim rechecks
device ownership and uses agent-device's rejecting session target guard;
sessions on other devices stay open. Physical devices are outside
this cleanup. agent-device is optional: a missing binary skips this step, and a
failed or timed-out list/close prints a device line on stderr while teardown
continues. Cleanup allows at most 15 seconds of agent-device calls per device.
A local daemon that cannot use socket transport or a CLI without the target guard
skips cleanup with a warning; no remote daemon is used.

Neither touches $STIM_HOME/stats.json: \`gc\` never reports or trims the run
counters \`stats\` prints, and there is no reset flag. Delete that one file to
start the counters over. A file this version cannot read -- unparseable, or
written by a newer Stim -- costs one dim line on stderr and is otherwise left
alone; only the next \`ios\` or \`android\` run moves an unparseable one aside
to stats.json.corrupt-<unix ms> and starts a new one.`,
  sections: {
    gc: {
      summary:
        'what gc and worktree remove delete, keep and refuse: orphans, stale records, locks, leases, EAS sessions',
      body: () => `LINKED WORKTREES
  \`stim worktree remove\` works with any linked worktree, warmed or not.
  Git registration identifies the worktree; a Stim registry entry is not
  required. Before it reclaims anything, the command refuses a worktree git
  has locked (unlock it first; --force does not override) and, without
  --force, uncommitted or unpushed work and initialized submodules. It then
  reclaims any owned resources it finds and removes the linked checkout.
  When git still refuses the removal, the kept ownership record no longer
  names the devices that were parked or deleted. A workspace that is in use
  (see IN USE below) keeps its directory, devices and registry entry, and the
  command reports why. Git-created
  branches stay. A branch with an existing Stim ownership record is deleted
  only when it has no unique commits.

IN USE
  gc and worktree remove never delete a workspace's directory, build outputs
  or checkout while it is in use: its dev server supervisor is running or
  cannot be verified, a \`stim ios\`, \`stim android\` or \`stim stop\` run
  holds its native-run.lock, a live or unresolvable build lock or slot names it,
  or its managed tunnel or managed remote lock is held. The deletion holds
  native-run.lock itself, so no native run can start partway through. A lock
  that names no workspace blocks nothing, because every build also holds its
  own workspace's native-run.lock; gc lists it with the command that removes
  it. \`worktree remove\` re-checks uncommitted and unpushed work under its
  removal locks, just before it reclaims anything. A project root whose
  existence cannot be read (a permission error) is never treated as deleted.

SWEEPING FINISHED WORKTREES
  Every \`gc\` without --cache looks at every registered project root and
  every workspace.json root, grouped by git worktree, and reports each linked
  worktree with the reason it is removed or kept. A worktree is finished when
  its branch is merged into the default branch. \`--worktrees\` also removes
  one that is idle: no recorded use for --older-than days, 7 without it; a
  worktree whose last use is unknown is kept. Both need the same clean state;
  a worktree is kept when it is the source checkout, bare, locked, in use,
  dirty (untracked files count; pod install churn alone does not), unpushed
  (commits no remote-tracking ref or other local branch reaches), or has
  initialized submodules. Without --worktrees, the report leaves out the
  source checkout and roots outside git.

  IN USE means its dev server supervisor runs, a stim ios, android or stop
  run holds its native-run lock, a live build lock or slot names it, a
  managed tunnel or remote lock is held, an owned simulator or emulator of
  the workspace is booted (an agent-device session needs one), or it holds
  an unexpired device lease. When the simulator or emulator list cannot be
  read, the worktree counts as in use. A device left booted keeps the
  worktree until \`stim stop\` in it, or \`gc --idle <duration>\`, shuts
  the device down.

  RECENT ACTIVITY keeps a worktree gc would otherwise remove until
  gc.worktreeGraceMinutes (120 by default, \`guide settings\`) have passed
  since the latest of: a write to its git index, HEAD or HEAD reflog, a write
  to its Stim workspace state or log files, and, for a merged branch, the
  committer date of the commit that brought it into the default branch. That
  window is when an agent that just merged runs \`stim stop\` and \`stim
  worktree remove\` itself. The reason is recent-activity, and the report
  and the JSON eligibleAt field say when it becomes removable. When that
  activity cannot be read, the worktree is kept (reason activity-unknown).
  0 turns the grace period off.

  MERGED means, with the default branch taken from origin/HEAD, after a
  \`git fetch origin <default>\` per repository (30s timeout, no credential
  prompt; skipped when that checkout fetched in the last 10 minutes):
  - HEAD is reachable from origin/<default> through a merge commit, and the
    branch's reflog shows a commit made on it that HEAD contains. A branch
    with no commit of its own -- fresh, cut from another branch, or reset
    onto one -- is not merged.
  - the branch changes the tree, and either it has no merge commits and every
    commit since the merge base has the same \`git patch-id --verbatim\` as a
    commit on the default branch (a rebase merge), or its whole diff since the
    merge base has the same verbatim patch id as a commit there, compared on
    the files the branch changes (a squash merge).
  Merge state comes from git alone, not from a hosting service. A squash
  merge whose content changed during the merge (a conflict resolution, a
  suggested edit, even whitespace) does not match and is kept, and so is a
  fast-forwarded branch. When origin/HEAD is not set, the fetch fails, or git
  cannot answer, the state is unknown and never counts as merged (reason
  merge-unknown, with the remedy); with --worktrees an idle worktree is still
  removed. A squash- or rebase-merged branch whose upstream is gone (deleted
  after the merge and pruned locally) has commits only it reaches; they do
  not block removal, because their change is on the default branch, and the
  branch is kept.
    stim gc                                        # report merged worktrees
    stim gc --delete                               # remove them
    stim gc --delete --worktrees --older-than 3    # also the clean idle ones
  --cache with --worktrees is refused with STIM_BAD_ARG; run them separately.
  With --delete it runs the \`stim worktree remove\` pipeline, never --force,
  on each removable worktree. That pipeline re-inspects the worktree and
  re-checks use and recent activity under the removal locks, and idleness
  for an idle worktree or an unchanged HEAD for a merged one, then parks
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

NAMED SERVER PORTS
  worktree remove stops TCP listeners on each named allocation and releases
  the ports. gc reports named allocations for missing workspaces; gc --delete
  stops their listeners and releases them. Unmounted or unresolved paths stay
  registered. Failed stops retain their allocations for a later retry.
  stim stop does not touch named ports. See guide ports.

ON THE SOURCE CHECKOUT
  git cannot remove a repository's main working tree, and deleting the source
  checkout is not what anyone meant -- so there, and only there,
  \`worktree remove\` reclaims the ENVIRONMENT and nothing else: the owned
  devices are parked or deleted, the Metro port freed, the registry entries
  (including nested monorepo app dirs) dropped, and the global workspace
  directory deleted. The tree itself is never touched, which is also why the
  dirty-tree and unpushed guards do not apply on that path.
  It ends with:
    Reclaimed the environment; the working tree stays (it is the source checkout).
  A registered project directory that is not a git repo at all gets the same
  environment reclaim -- there is nothing else remove could mean there.

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
  (\`xcrun simctl delete <udid>\` or \`avdmanager delete avd -n <name>\`), and
  never runs it. Boot, shutdown and teardown re-check ownership by the same
  rule, so a device that stops matching is left alone.

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

A device leaks when a project is abandoned WITHOUT either delete path -- the
sim survives with nothing pointing at it. \`stim gc\` (no flag, writes
nothing, always safe) reports those; \`gc --delete\` reaps them, and in the same
run drops the dead config ENTRIES those projects left behind and frees their
Metro ports. \`stim gc --json\` prints the same report as one payload
(\`guide facts gc\`); show the user its sections before \`gc --delete\`.

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
    disk: {
      summary:
        'disk usage, workspace build outputs, AVD and build-log sizes, the data partition, trimming the shared caches',
      body: () => `DISK
  Logs, state, pidfiles and Xcode DerivedData are under the global workspace
  directory, and \`worktree remove\` reclaims them. \`gc --delete\` clears the
  build outputs of workspaces nobody is using (WORKSPACE BUILD OUTPUTS
  below) and keeps the rest. Gradle retains its normal
  project build directories while sharing task outputs through its build cache.

  Android AVDs normally live under ~/.android/avd, and a booted owned AVD can
  use several GB. \`worktree remove\` parks the workspace's owned AVD with its
  user data and snapshots wiped, or deletes it when the pool is off or full;
  plain \`stop\` only shuts it down for reuse. Stim uses Android's default Quick Boot
  unless displayless Linux requires software rendering, where snapshots are
  disabled. The first boot and a boot after the emulator, system image, or AVD
  settings change are cold, while later supported boots load the one automatic
  snapshot saved on exit. \`stop\` waits for the emulator process and, when
  enabled, the snapshot save to finish.
  New owned AVDs default to an 8 GiB data partition, though project settings can
  change it. When enabled, Quick Boot keeps one automatic snapshot until the AVD is
  parked or deleted.
  \`gc\` prints the on-disk size beside an orphaned or stale owned Android AVD
  when its content directory can be read.

  So are the logs, and one of them is not small: build-ios.ndjson /
  build-android.ndjson hold the whole xcodebuild or gradle transcript at debug
  level, which for a cold build is tens of megabytes (74 MB measured on one
  first iOS build of a real app). They are worth that -- a build that fails at
  minute nine is unreadable any other way -- and they are per workspace, not
  global, so \`worktree remove\` reclaims them along with everything else in
  the global workspace directory. Each build starts its transcript file over, so the log
  holds one run and a workspace you keep building in does not accumulate them.

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
  Each workspace directory holds derived-data/, gradle-build/, android-cas/
  and cache-provider/. \`gc\` reports them as one detected cache, "Workspace
  build outputs", with a per-workspace size, last use and verdict. Plain
  \`gc --delete\` clears them for every workspace not in use (see \`guide
  cleanup gc\`), before anything else. \`--older-than <days>\` limits that to
  workspaces idle at least that long, and keeps one whose last use is
  unknown. \`--cache workspaces\` acts on them alone; \`--cache all\` includes
  them. Only those four directories go: workspace.json, state.json, logs/,
  locks and device records stay, so the workspace keeps its devices and ports.
    stim gc --delete --cache workspaces --older-than 7
  Last use is the newest of the lastUsedAt that start, ios, android, reload
  and worktree warm record in state.json, lastBuild.startedAt,
  supervisor.startedAt and the mtimes under logs/, so a dev server that keeps
  logging keeps its workspace in use.
  The same time decides \`--older-than\` device reaping, and a workspace with
  no evidence of use keeps its device.
  The next build of an unchanged app installs from the shared build cache.
  After a native change the Xcode compilation cache speeds the rebuild, but on
  React Native 0.86 Swift does not use it (explicit modules are off), so that
  build recompiles Swift.

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

  Trim rather than empty. Emptying costs the next build in every project the
  time the cache was saving.`,
    },
  },
};

export default cleanup;
