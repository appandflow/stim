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
reduces its build outputs and, in a linked worktree, `node_modules` and Pods by
the discovered-checkout rules, and never removes the checkout or worktree. The
hold that keeps a worktree inside a dot-folder of its main checkout
(`.claude/worktrees`) applies to it.

- Common tool folders: linked worktrees of known repositories in
  `~/.codex/worktrees`. The list is one constant with that one path.
- The full scan: a pruned walk of the home folder for checkouts that Stim's
  project detection recognises and discovery does not reach. The daemon runs it
  weekly and, while the disk level is above normal, at most hourly; a command
  never runs it. It reads `~/Documents`, skips `~/Desktop`, `~/Downloads`,
  `~/Library`, other media folders, symlinks, other volumes, dependency, build
  and cache folders, dot-folders below the first level and the named tool homes
  among the home folder's dot-folders (see below), and the Stim home, stops at a recognised project and goes
  seven levels deep. A folder the system refuses is skipped and recorded, never
  an error. The result is stored in `maintenance/discovery-scan.json` under the
  Stim home (when it ran, what it found, what it could not read) and discovery
  reads that file, so a maintenance pass or `stim gc` never walks the disk.
- At most 40 reduce-only checkouts are handled per discovery, in a window over
  them that moves every 15 minutes.

A folder named in `maintenance.discoverRoots` keeps the full rules. A scoped
`STIM_HOME` discovers nothing from either source.

Reason for entering home dot-folders: checkouts live there too, for example
about 18 checkouts and 80 GB of Cargo `target/` under `~/.exact/exact2` (#5757),
so a blanket skip of dot-folders would miss the layout that started this work.
The scan enters a dot-folder directly in the home folder unless it is in a
named prune list of tool homes, package and build caches and runtimes
(`.git`, `.npm`, `.yarn`, `.bun`, `.gradle`, `.cargo`, `.rustup`, `.nvm`,
`.rvm`, `.cache`, `.android`, `.vscode`, `.cursor`, `.agent-device`, `.claude`,
`.codex` and others in `HOME_DOT_PRUNED`) or named like a cache (`*-cache`).
The list comes from entry counts to depth four on one machine, led by `.gradle`
(67 thousand), `.agent-device` (45 thousand), the two Metro cache folders
(25 and 17 thousand), `.npm`, `.bun`, `.rvm` and `.yarn` (15 thousand each).
`.codex` is reached through its worktrees folder, and the Stim home is never
scanned. Dot-folders deeper down (`.worktrees`, `.claude/worktrees`) are
skipped because git reaches their worktrees. The scan's finds under a home
dot-folder pass the protection rule for the system temporary directory only:
the scan itself decides which dot-folders to enter, so the dot-folder part of
`isProtectedLocation` does not apply to them, and they stay reduce-only.

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
bound of 40 reduce-only checkouts per discovery in a window that moves every 15
minutes (not "least recently handled first"), the depth of seven, the folders
pruned, `~/Library`, `~/Movies`, `~/Music`, `~/Pictures`, `~/Public` and
`~/Applications` left out, the low-disk scan running once per rise of the disk
level (the daemon's high or critical disk level, `disk.minFreeGb`) at most
hourly rather than hourly for as long as the disk stays low, and the scan
running only in the daemon.

Not part of this change: points 4, 5 and 7, which belong to the doctor listing
and the low-disk line.

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

## Links

- Issues: #5512, #5515, #5757, #5762. Pull request: #5519.
- Code: `packages/stim-cli/src/workspace/discovery.ts`,
  `packages/stim-cli/src/workspace/discovery-scan.ts`,
  `packages/stim-cli/src/workspace/discovered-removal.ts`,
  `packages/stim-cli/src/workspace/protected-locations.ts`,
  `packages/stim-cli/src/workspace/hidden-edits.ts`,
  `packages/stim-cli/src/commands/gc/worktrees.ts`.
