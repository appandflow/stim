# LLP 0004: Checkouts Stim never ran in

**Type:** Decision
**Status:** Active
**Systems:** Cleanup
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0002, LLP 0005

## Discovery

Maintenance and `stim gc` also manage checkouts no `stim` command ran in. They
find them in three places: linked worktrees of the repositories of registered
projects (`git worktree list`), direct children of the folders that hold
registered checkouts, and direct children of the folders in
`maintenance.discoverRoots`. A child counts only when Stim's project detection
recognises it, itself or through a direct child of its `apps`, `examples` or
`packages` folder. Discovery registers nothing, writes nothing, recomputes each
run and never runs `git fetch`. Two more sources, the common tool folders and the
full scan (see "Tool folders and the full scan"), add checkouts that are only
reduced.

Reason: checkouts no `stim` command ran in can hold most of a disk; an audit of
one MacBook on 2026-11-11 found 119 of 151 checkouts, 248 GB, unknown to Stim,
among them a 150 GB Cargo `target/`.

Maintainer decision: "sounds good lets do it for automatic discovery! lets also
allow customizing by adding folders to look for projects in config", 2026-11-11.

Maintainer decision: "should be same rules as registered workspace",
2026-11-11, for discovered checkouts.

Which folders count as sources, the `apps`, `examples` and `packages` rule,
and the absence of any write or fetch were chosen by the coordinator and the
review of #5519, not by the maintainer.

## Scope

A discovered linked worktree is acted on only inside its repository's main
checkout folder, a folder that holds a known project, or a
`maintenance.discoverRoots` folder. Nothing under the system temporary directory
or a dot-folder directly inside the home directory is ever touched, unless it
lies inside a `maintenance.discoverRoots` folder: a path inside such a folder
is never a protected location, matched after symlinks resolve. The one other
exception is `~/.codex/worktrees`, whose worktrees are reduce-only (see "Tool
folders and the full scan"). The home
directory and `/` are never a folder that holds known projects. A scoped
`STIM_HOME` discovers only from its own `maintenance.discoverRoots`.

Reason: `git worktree list` also returns worktrees other tools own, such as
`~/.codex/worktrees`, pin checkouts under a home dot-folder and agent scratch
folders under the temporary directory. Stim cannot tell what those tools still
need, so it removes none of them; it reduces only the outputs of the
`~/.codex/worktrees` ones. A scratch home must not reach the repositories of the real one.

Maintainer decision: "Def need to fix it if its the case, paths added to
discover root need to always be considered", 2026-11-14 (#5757), about a folder
named in `maintenance.discoverRoots` under a home dot-folder. Applying it to
the temporary directory as well was the coordinator's reading of "always", not
the maintainer's words.

Everything else in this section was chosen by the coordinator and the review of
#5519, not by the maintainer.

## Tool folders and the full scan

Discovery also reads two more sources, and what they find is reduce-only: Stim
reduces its build outputs and its `node_modules` and Pods (a linked worktree's
after `idle.dormantDays`, a source checkout's after `idle.sourceDormantDays`) by
the discovered-checkout rules, and never removes the checkout or worktree. The
hold that keeps a worktree inside a dot-folder of its main checkout
(`.claude/worktrees`) applies to it.

- Common tool folders: linked worktrees of known repositories in
  `~/.codex/worktrees`. The list is one constant with that one path.
- The full scan: a pruned walk of the home folder for checkouts that Stim's
  project detection recognises and discovery does not reach. The daemon runs it
  weekly and, while the disk level is above normal, when no scan has run for an
  hour; a command never runs it. It reads `~/Documents`, skips `~/Desktop`, `~/Downloads`,
  `~/Library`, other media folders, symlinks, other volumes, dependency, build
  and cache folders, dot-folders below the first level and the named tool homes
  among the home folder's dot-folders (see below), and the Stim home, stops at a recognised project and goes
  seven levels deep. A folder the system refuses is skipped and recorded, never
  an error. The result is stored in `maintenance/discovery-scan.json` under the
  Stim home (when it ran, what it found, what it could not read) and discovery
  reads that file, so a maintenance pass or `stim gc` never walks the disk.
- Every reduce-only checkout is evaluated on every pass, like a sibling-discovered
  checkout, and classified from the complete discovery list. A window of 40 per
  pass was built and removed: filtering by it before classification changed
  what was protected, twice (a worktree grouped with a nested discover root lost
  its reduce-only status). Bounding per-pass cost for many checkouts belongs to
  #5531; the finished-worktree check (`collectWorktreeSweep`) inspects every
  discovered worktree with git (status, activity, HEAD, unpushed), measured at about
  0.14 seconds each on one MacBook.
- An existing scan file that cannot be read (any error other than it not existing)
  stops the scan for that tick and writes nothing, as an unreadable config does;
  one that reads but does not parse, or is another version, is treated as no
  result, since its contents are unusable either way.
- The stored result keeps the schedule (last attempt, last attempt that did not
  fail, last attempt at low disk) and the finds. A failed or truncated scan
  keeps the previous finds, and a finished one keeps those under a folder it
  could not read, so a worse result never replaces a better one. A read the system
  denies during the project checks (a manifest, a nested listing) is not a
  structural fact: it lists the folder unreadable, runs no detection on it or
  below it, leaves the scan untruncated and keeps its finds; in revalidation it is
  `pending`. Discovery
  revalidates each find before using it: a real folder, not a symlink, on the
  home volume, below no skipped folder, still recognised.
- The scan runs after a maintenance pass has acted, so it never delays cleanup.

A folder named in `maintenance.discoverRoots` keeps the full rules. A scoped
`STIM_HOME` discovers nothing from either source.

Reason for entering home dot-folders: checkouts live there too, for example
about 18 checkouts and 80 GB of Cargo `target/` under `~/.exact/exact2` (#5757),
so a blanket skip of dot-folders would never even report the layout that started
this work. The scan records them; it does not act on them (see below).
The scan enters a dot-folder directly in the home folder unless it is in a
named prune list of tool homes, package and build caches and runtimes
(`.git`, `.npm`, `.yarn`, `.bun`, `.gradle`, `.cargo`, `.rustup`, `.nvm`,
`.rvm`, `.cache`, `.android`, `.vscode`, `.cursor`, `.agent-device`, `.claude`,
`.codex` and others in `HOME_DOT_PRUNED`, and by prefix every `.stim*` folder: the Stim
home and other Stim state, where the build worker's client checkouts must never become
reduce-only) or named like a cache (`*-cache`).
The list comes from entry counts to depth four on one machine, led by `.gradle`
(67 thousand), `.agent-device` (45 thousand), the two Metro cache folders
(25 and 17 thousand), `.npm`, `.bun`, `.rvm` and `.yarn` (15 thousand each).
`.codex` is reached through its worktrees folder, and the Stim home is never
scanned. The version managers and package caches `.volta`, `.asdf`, `.mise`,
`.fnm`, `.pyenv`, `.rbenv`, `.sdkman`, `.deno`, `.pub-cache` and `.fvm` are
pruned too: their installs hold thousands of files and no checkouts, and one
large one could truncate the walk on every run. Dot-folders deeper down
(`.worktrees`, `.claude/worktrees`) are skipped because git reaches their
worktrees.

The coordinator's decision following the review of #5764, not the maintainer's
words: what the scan finds under a home dot-folder is recorded in the result
(`dotFolderFound`) and never selected by discovery, so no pass acts on it. The
protection rule for home dot-folders applies to scan finds in full; the only
ways into a home dot-folder stay `maintenance.discoverRoots` and the tool folder
list. Reason: Stim cannot tell an installed tool from a checkout there, for
example a Swift CLI cloned under `~/.mytool` whose launcher on PATH points into
its ignored `.build/release`; clearing that output once idle would break the
installed command. The record lets doctor report what the folder holds and the
command that adds it to `maintenance.discoverRoots`; the listing is described in
"The doctor listing and the low-disk line".

The scan has a 45 second budget (and a 200 thousand folder cap, and an abort),
checked before every read it makes, including every read of the safety checks
below: when it runs out the folder is not recognised and the scan ends truncated
as `budget`, keeping the previous finds. It can overrun the budget by at most one
read's 3 second timeout plus the time detection itself takes on the folder it is
recognising, which is synchronous and not interruptible. Revalidation has no total
budget; each read has the 3 second timeout, and the number of reads is bounded by
detection's own caps (50 children per container, the home folder and up to seven below it).

Project detection (`recognises`) reads files synchronously, and a stalled mount,
an iCloud file waiting for a download or a FIFO would block the thread. Before
detection runs on a folder, the scan or the revalidation proves its reads cannot
block, as far as this list goes. For the folder, each ancestor from the home
folder down (`folderSafety`), and each folder detection inspects below it
(`nestedSafety`: each `apps`, `examples` and `packages` container and up to 50
children of each), with every name compared case-insensitively on every volume:
a detection file (`package.json`, `settings.gradle(.kts)`, `gradlew(.bat)`,
`Package.swift`, `exact.mjs`, `app.json`) that is not a regular file makes the
folder unsafe; so does an `ios` or `android` entry that is not a real directory
(detection resolves them with `realpath` as React Native's owned roots), an Xcode
container with no app dependency in `package.json` (detection parses the project
files it names), and a symlinked container; every regular `package.json` is read
once through the bounded reader first. An unsafe folder, or an unsafe result for
anything detection inspects below it, makes its whole subtree unrecognisable: no
detection runs on it or below it, and the walk does not descend. A read that does
not answer ends the scan truncated with the folder unreadable (`truncation: read`),
or leaves a cached find unselected and in the file. Revalidation applies the same
functions to the chain from the home folder to the entry, memoised per discovery
call, and reads the entry's own metadata (`lstat`, `stat`, `realpath`) through the
bounded reader. Not bounded, and stated as such: the ancestor reads above the home
folder (`/Users` and `/`); a file that becomes unreadable between the bounded read
and detection; the `ios` and `android` directories of the folder and of each
ancestor, which detection resolves with `realpath` without the walk entering
them (the gate checks that each is a real directory, not that it answers, so a
stalled mount point there is not detected; the walk's own bounded `readdir` covers
only the folders it enters, and the `apps`, `examples` and `packages` containers
and their children are listed through the bounded reader by the gate); and everything a pass later reads synchronously inside a checkout
once it is discovered (artifact collection, app roots, state), which is the same
for registered and sibling-discovered checkouts today. Registered projects and
sibling discovery recognise as before. An Xcode container without an app
dependency is not a scan checkout, though sibling and root discovery still
recognise it.

A scan find outside a home dot-folder can also be an installed tool. Every route
that deletes outputs, dependencies or Cargo data of a reduce-only checkout keeps
the checkout while an executable reachable through a PATH directory is a symlink
that resolves into it: the idle stage (`discoveredEvidence`, and again under the
locks in `clearStoppedOutputs`), the artifact and dependency passes
(`artifactReads` into `keptReason`, which `collectArtifactsAsync`,
`clearArtifact` and the source dependency trees all pass through), and the Cargo
target measurement, the pressure plan and the acting trim
(`regenerableDirProblem` with the launcher reader). The directories read are
those on PATH and the per-user bin folders a daemon started by launchd does not
list: `~/.local/bin`, `~/bin`, `~/.cargo/bin`, `~/.bun/bin`, `~/.volta/bin`,
`~/Library/pnpm`, the active nvm bin, `/usr/local/bin` and `/opt/homebrew/bin`.
A launcher resolving into a path is the same kind of fact as a process executing
from it, so a deletion route reads it at the same moment as the running-process
evidence, with a reading of its own, never the pass's planning reading (which
can be minutes old and is shared by the operation). The Cargo trim adds the
launcher targets under its target to the paths in use at each of its three
process reads. The artifact and dependency routes read the launchers in
`artifactReads`, after the process read and after their slow checks, in the same
`keptReason` that decides the deletion. `clearStoppedOutputs` reads them with
the idle evidence and again after measuring sizes, immediately before each
removal (`deleteOutputs`). The plan-time whole-checkout keep stays. The window
that remains is the one for a process that starts executing from the path after
the last evidence read: Stim accepts it for processes and gives launchers no
larger one. A Cargo target is checked against its owning checkout, not its app
folder. Each call to a directory has 3 seconds to answer, and a timeout ends the
reading as incomplete at once. A native read cannot be cancelled, so at most one
read that timed out is outstanding per JavaScript isolate, shared by the launcher
readings and the home scan (`bounded-read.ts`): while it is pending, no further
launcher or scan read starts, every launcher reading reports incomplete
immediately naming the folder, and a scheduled scan is skipped. A hung mount
therefore holds one libuv thread per isolate, and reduction of reduce-only
checkouts stays off until that read settles. Two isolates in the daemon can
read launchers, the main thread and the passes thread, so up to two reads can be
outstanding there; the scan runs only on the passes thread, and CLI commands are
separate processes. A scan stops at the first read that times out: the result is
truncated and the previous finds are kept. A scan that failed or ended on a timed-out
read is retried after an hour whatever the disk level; one that stopped at the folder
cap or the time budget follows the weekly schedule (hourly while the disk level is above
normal), since a retry would hit the same limit.
A directory or entry that does not exist, and a dangling symlink, is no
launcher. Any other failure to inspect a directory (permission, I/O, a timeout)
keeps every reduce-only checkout for that operation, with a reason naming the
directory. A wrapper script that only names a path is not followed.

Every source (main) checkout, registered or discovered by any route (siblings,
`maintenance.discoverRoots` children, tool folders, the scan), follows the
existing dormant rule and loses `node_modules` and Pods after
`idle.sourceDormantDays` (7), a linked worktree's after `idle.dormantDays` (1)
(`daemon/dependencies.ts` `takeIdleDependencies`, over `idleStageCandidates`'
discovered list); the maintainer has not confirmed that consequence for the scan
finds, and the guide wrongly said a main checkout keeps them before this change.

Reason: on one MacBook `~/.codex/worktrees` held 53 worktrees and 12 GB that
Stim listed once as outside the folders it manages, with no size and no way
forward.

Maintainer decision, 2026-11-14 (#5762), verbatim:

> ok so lets do:
> discovery - current logic + common paths + full scan once in a while (also triggered more often on low disk), full scan can try to be fast, ie like not scan places we know theres gonna be no projects and lots of files so can keep it fast ish, prob will trigger permission promts for Documents folder prob the only one it makes sense to scan but I guess its fine.
>
> discovered workspaces - cleaned using our safer rules we have already, doctor lists them and suggest adding as managed path or delete if idle for long time

Earlier the same evening, on including common tool folders by default: "Could
these common paths just be included by default in Discovered checkout".

The coordinator's reading, not the maintainer's words, for the points the
decision leaves open:

1. Checkouts found only through a common path or the full scan are reduced and
   never removed by Stim: build outputs, tagged caches, and a linked worktree's
   `node_modules` and Pods go by the discovered-checkout rules, and the checkout
   or worktree itself stays. This is the rule that already applies to a worktree
   in a dot-folder of its main checkout (`.claude/worktrees`). Removal is what
   doctor suggests to the person. A folder named in `maintenance.discoverRoots`
   keeps the full discovered rules, removal of finished worktrees included.
   (Added by the implementing lane, not part of the recorded reading: the rule
   in force also removes a source checkout's `node_modules` and Pods after
   `idle.sourceDormantDays`, as the section that states it describes.)
2. Common paths start with `~/.codex/worktrees`. Other tools' folders are added
   only with evidence that the tool uses that path.
3. "Once in a while" is weekly. On low disk the scan runs when a volume's level
   rises above normal, at most once an hour.
4. Doctor reads the last scan's result and does not run the scan, so it stays
   fast.
5. The line Stim commands print on low disk also names what the scan found, its
   size and the command that adds it.
6. `~/Desktop` and `~/Downloads` are not scanned. Other volumes are not scanned.
7. "Idle for a long time" has no number yet.

Chosen by the implementing lane, not by the maintainer or the coordinator: the
depth of seven, the folders
pruned, `~/Library`, `~/Movies`, `~/Music`, `~/Pictures`, `~/Public` and
`~/Applications` left out, the low-disk scan running hourly while the daemon's disk level is above
normal (high or critical, `disk.minFreeGb`) and no scan ran for an hour, the
retry after an hour of a scan that failed or ended on a read that timed out, while one that stopped at the folder cap or the time budget counts as finished (`truncation` records which), the scan running only in the daemon
after the pass, and the PATH launcher keep. The scan is not deferred under host
load; it takes about a second and a half on one MacBook.

Points 4, 5 and 7 are implemented in "The doctor listing and the low-disk line".

## The doctor listing and the low-disk line

Maintainer direction, 2026-11-14 (#5762), verbatim, on the line Stim commands
print when the disk is low: "do stim commands when low on disk space already log
smt", then "could be part of that", then "smt like low disk space, found projects
not managed by stim taking x space , command to add to discover roots". On the
first of the two points it records for doctor, the decision above says: "doctor
lists them and suggest adding as managed path or delete if idle for long time".
Maintainer statement, 2026-11-14, as the issue records it (comment of 2026-11-15),
verbatim: "like maybe not part of doctor since it could be slow". It was said about the
scan itself, so doctor never walks the disk.

What these words state: doctor lists the finds Stim does not fully manage and
suggests adding the folder as a managed path, or deleting what has been idle a
long time; the low-disk line carries how much they hold and the command that adds
them; the scan stays out of doctor.

Chosen by the implementing lane and the coordinator's brief, not by the
maintainer:

- The daemon writes the result. After a scan it classifies the scan's finds from
  the complete discovery list and measures their recognised build output into
  `maintenance/discovery-census.json`. Doctor and the low-disk line read that
  file, the scan file and the `maintenance.discoverRoots` setting, and walk nothing.
  Only the classification drops an entry, and only with evidence that a route
  manages it; the report never hides a census entry, it chooses how to present it.
  A group whose folder is a root discovery uses, or the setting names now, is shown
  with no adopt command and words saying why its entries are listed. A group in a
  root discovery ignores (a broad one such as `~`) is an ordinary group.
- Two kinds, worded differently because they are different facts: reduce-only
  scan finds (Stim reduces their outputs and never removes them), and finds under
  a home dot-folder (Stim does nothing with them). Both are grouped by the
  folder that holds them, the only folder `maintenance.discoverRoots` can name to
  adopt them, with a command built from the current value plus that folder and
  quoted for the shell. The home folder and a folder holding it cannot be named, so
  such a group gets words and no command. The command adds the folder to the full
  discovered-checkout rules, finished-worktree removal included, and for a
  dot-folder find lets Stim act where it did not; the listing says so.
- Size is the recognised build output only (the build directories maintenance
  clears, a Cargo target with `CACHEDIR.TAG` or Exact's), not `node_modules` or
  Pods, and not proof that a directory is deletable. It goes through
  `refreshMeasure` and the disk-usage cache: one walk at a time on the machine, 10
  seconds per directory, at most 25 checkouts and 90 seconds per run; a checkout
  measured within a day is carried over, and what a run leaves is measured by the
  next one an hour later. A walk that failed or timed out is "could not be
  measured" and a directory not reached is "not measured yet", never zero; a total
  with either is "at least".
- Every read of a checkout's layout goes through the shared bounded reader
  (`answered`: 3 seconds, one outstanding timed-out read, none while one is
  pending) with the abort and the run's budget checked first, driving the same
  directory rules the deleting passes use. A path that does not exist is absent; a
  denied or timed-out read is "could not be measured", never zero. Walks and their
  bounds are the ones above. Idle evidence is not read: it walks a checkout's
  source with no bound the census could apply without changing code the deleting
  passes use, so doctor says Stim has not checked whether a checkout is in use or
  holds uncommitted or unpushed work, and leaves deleting one to the person.
- What is and is not bounded on the census path. Bounded (`answered`): the scan's
  safety gate for each folder (`folderSafety`, `nestedSafety`), the census's own
  layout reads and the git activity reads. Not bounded by the shared
  reader, found by reading `computeDiscovered`, `unmanagedScanFinds`, `scanSkipper` and
  `childrenOf` (the callees of project recognition and of the git helpers were not
  traced): synchronous `existsSync` on each configured `maintenance.discoverRoots`
  entry, each registered project root and each worktree entry of a repository;
  synchronous `realpathSync` (through `canonicalPath`) on those, on the repository
  folders, on the home folder, on every child `childrenOf` lists, on the known roots
  and, in `scanSkipper`, on the Stim home, the build worker root and the temporary
  directories (with a config read under the Stim home); `isProtectedLocation`
  (`realpathSync`) on every worktree path and on every candidate child outside a
  configured root, scan finds included; project recognition (`recognises`:
  `projectRegistry.selectDoctor(path)` and a synchronous `readdirSync` of the folder's
  `apps`, `examples` and `packages`) in `childrenOf` and at the end of
  `scanEntryValid`; the `childrenOf` listings, which are raced against 3 seconds
  rather than going through the shared reader; and git subprocesses
  (`git worktree list` and `git symbolic-ref`, through the exec wrapper, abortable
  and bounded by their own timeouts) in `resolveSourceCheckoutAsync`. The passes run
  discovery the same way; what this change adds is that project recognition now also
  runs on finds under home dot-folders.
- Instead of idle, the census records one bounded fact per checkout, the last git
  activity: the newest modification time of `HEAD`, `index` and `logs/HEAD` in the
  checkout's git directory. That is `<checkout>/.git` for a main checkout, and for a
  linked worktree the directory its `.git` file names after `gitdir:`, accepted
  only when absolute and ending in `.git/worktrees/<name>`. The reads are `lstat`
  and a 512 byte prefix of a regular `.git` file, through `answered`, under the
  run's budget and abort checks; no symlink is followed and no git process runs.
  Commits, checkouts, staging and reflog writes change the date; editing files
  without touching git does not, so it never proves a checkout unused. A missing
  or unusual git directory, a failed or timed-out read or a spent budget is
  unknown, shown as unknown and never as old. Doctor lists each checkout with the
  date, oldest first, unknown last, in text and as an ISO string or null in the
  JSON, with no threshold and without the word idle: the date is the fact and the
  person judges. Chosen by the implementing lane and the coordinator, not by the
  maintainer.
- The git directory is tied to the checkout the way git records it: a linked
  worktree's `.git` file names a directory (a relative name resolves against the
  checkout) ending in `.git/worktrees/<name>` that holds a regular `gitdir` file
  naming this checkout's `.git` file, and its canonical path (bounded
  `realpath`) equals its normalised path, so no component is a symlink; a `logs`
  that is not a real directory gives unknown.
- A scan find whose revalidation did not answer is neither managed nor gone: the
  census carries it as `unchecked` with any earlier measurement and its age,
  stays pending (retried within the hour, as is a checkout whose layout read
  failed), and doctor prints "every checkout it found is managed" only for a
  finished scan, a census made from it and no unchecked find.
- The measuring walk is told the directory exists (`knownToExist`), because the
  census established that through the bounded reader; `refreshMeasure` makes no
  other synchronous call on the measured path (its cache, failure and claim files
  are under the Stim home). Discovery's own reads of configured roots and
  registered projects (`existsSync`, `realpath`) are the ones the passes already
  make.
- The per-command critical-disk hook makes no filesystem call on a configured
  root or a find. It reads the daemon snapshot, the scan file, the census file and
  the config (all under the Stim home), compares strings with the canonical roots
  the census recorded, and adds no line once `maintenance.discoverRoots` changed
  since the census. `stim doctor`, which a person runs on purpose and which already
  canonicalises roots elsewhere, resolves symlinks of the configured roots with
  `realpath`. The census writes its file under a directory lock in the state
  directory.
- The census classifies a discovery computed from the scan result it records
  (not the per-operation memo the passes share) and records that `ranAt`; a census
  from an older scan than the scan file shows its checkouts as not measured yet.
  An unverified child cleanup propagates out of the pass unchanged (LLP 0007);
  any other census error is contained and logged once as `maintenance_failure`.
- The low-disk line is a second stderr line after the existing one, at critical
  only, never on stdout or in JSON. It gives the total (with "at least" while some
  is unmeasured) and the command for the largest reduce-only folder; a dot-folder
  group counts in the total and is never the one named.
- Doctor shows it as a section outside the findings, so it never changes a PASS or
  the count, and carries it in `--json` as `discovery`, an internal field. Doctor
  runs only inside a project, so the section does too.
- The worktrees in `~/.codex/worktrees` reach discovery through git as reduce-only
  worktrees and are not scan finds, so they are not listed.

Open for the maintainer: whether the last git activity date is enough for "delete if
idle for long time", or Stim should offer more (it states no number and does not
read source activity); whether
the low-disk line also appears at the high level; whether listing the
`~/.codex/worktrees` worktrees belongs here; whether `stim status` and Stim
Desktop show the listing.

## Removing a discovered worktree needs more evidence

A discovered linked worktree follows the registered-workspace rules for build
outputs and dependencies. Removing the worktree itself needs more than a
registered worktree does, at every pressure level, critical included:

- no activity for `idle.dormantDays` by the full evidence (source writes
  including git-ignored files, last commit, git's own writes, a completed
  scan), with no zero grace, checked again under the removal locks;
- no process running from it and no agent session in it;
- no change to any tracked file. A registered worktree may lose a
  `Podfile.lock` change proven to be `pod install` output (LLP 0002); a
  discovered one gets no such exclusion;
- no tracked file marked `assume-unchanged`, or `skip-worktree` with the file
  on disk;
- every git-ignored file present byte for byte in the main checkout, except
  inside directories git ignores that are named like build output or
  `node_modules`;
- not inside a dot-folder of its main checkout other than `.worktrees`, such
  as `.claude/worktrees`, which another tool manages.

A dirty discovered worktree is kept, never archived. A checkout whose source
scan exceeds its bound is never reduced and is listed under "Needs a person".

Reason: Stim has no record of what it put in a discovered worktree. It did not
run `pod install` there, did not copy its ignored files with `worktree warm`,
and has no activity record for it, so a change it cannot explain may be a
person's work: a hand-written `.env`, a project file edited by hand, an edit
hidden from `git status`.

Chosen by the coordinator and the reviews of #5519, not by the maintainer.

## Known limits of the listing

A find that contains, or lies inside, a registered project or a discovered checkout
is treated as managed and is not listed, although only that project or checkout is
managed. This is the symmetric coverage rule `selectDiscovered` applies to the
deleting passes; a monorepo root with a registered app inside it is the common case.

A find whose layout read is permanently denied is re-measured each run and takes one
of the 25 slots (`looked`) of every run until it is fixed or leaves the scan result.
A find whose metadata read is denied is carried as unchecked without taking a slot,
but the census stays pending and reruns discovery every hour. A find that stays
unreadable or unchecked keeps the list from ever being called complete, and doctor
says so each time: it prints that the list may be incomplete and never that
everything is managed. The census
file is read without a lock (it is replaced atomically under a lock, so a reader
sees the old or the new file). A `du` that exits non-zero (denied files) is recorded
as a measured lower bound: its bytes count and the totals read "at least".

## Links

- Issues: #5512, #5515, #5757, #5762. Pull request: #5519.
- Code: `packages/stim-cli/src/workspace/discovery.ts`,
  `packages/stim-cli/src/workspace/discovery-scan.ts`,
  `packages/stim-cli/src/workspace/discovery-census.ts`,
  `packages/stim-cli/src/workspace/discovery-report.ts`,
  `packages/stim-cli/src/workspace/discovered-removal.ts`,
  `packages/stim-cli/src/workspace/protected-locations.ts`,
  `packages/stim-cli/src/workspace/hidden-edits.ts`,
  `packages/stim-cli/src/commands/gc/worktrees.ts`.
