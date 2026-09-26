export default {
  summary: 'The normal coding-agent workflow, safety rules, and topic routing',
  body: () => `AGENT WORKFLOW

Use Stim to run React Native and Expo apps without sharing a Metro port or
device with another workspace. Prefer plain output: it streams each phase and
ends with the facts the next step needs. Use --json only when a script must
parse a stable payload.

TWO WORKFLOWS

SINGLE CHECKOUT: work in place, on whatever branch the task needs, in one
directory. start, ios, android, logs, stop, and never a linked worktree. That
directory is your workspace, and no rule below about keeping the source checkout
fit as a seed applies to it.

WORKTREE: the checkout you cloned is a seed. It stays clean and on the default
branch, and every task gets a linked worktree warmed from it. In this workflow
the source checkout is infrastructure, not a workspace: you edit, build, and run
in the worktree, and you keep the seed fit to copy. Every rule below about the
source checkout's fitness as a seed belongs to this workflow.

MULTIPLE DEVICES

Use ios/android --slot <name> to retain multiple devices in one workspace,
including several of the same model. Reuse the same slot name on subsequent
runs. Read guide lifecycle options for the complete slot workflow. Use the
reported device ID for UI interaction. All slots share Metro; reload can reach
multiple devices, and a shared bundle request does not prove a slot launched.
Use stop --slot <name> for one slot, or plain stop for the whole workspace.

NORMAL WORKFLOW

Work in the current checkout by default. When the task needs another branch or
an isolated environment, take the worktree workflow: create a linked worktree
with Git and warm its ignored state. If a harness already created this linked
worktree, run stim worktree warm here instead of creating another one. It
copies missing ignored paths from the source checkout, including eligible .env
and local configuration files. It preserves the branch, tracked files, and
every existing destination entry; existing ignored directories are skipped
whole, not filled in. Add --refresh to fast-forward the source checkout and
install what moved there before the copy; it refuses a source checkout with local
work and never switches branches. Read guide lifecycle options for exclusions
and incomplete-copy remedies.

Wait for warm to exit successfully (exit code 0) before running stim start,
stim ios, stim android, or a dependency install in that worktree. If the shell
tool returns a running session or job ID, poll or wait for that job to finish;
the ID is not completion. Concurrent writes to the destination are unsafe:
warm checks for existing entries before copying, not during the copy. Do not
edit files, install dependencies, or run another warm in that worktree until
it finishes; concurrent files can be overwritten or removed.
If warm fails or reports incomplete, resolve the reported failure first.
A warm that cannot record its ownership claim refuses before copying. Follow
the printed remedy and keep concurrent runs on the same STIM_HOME.

Before native work, run doctor for the platform in scope when the STATUS block
at the top of this topic says it is due. No block means doctor is current and
Stim is up to date. In the worktree workflow, run it from the linked worktree
so it also checks the source checkout. Follow each finding's printed remedy,
and read the routed topic below before acting on one you do not understand. If
the stim resolved from PATH is older than another installation, fix PATH or the
installation before continuing so commands and guidance match. Under host
memory pressure, stop only devices in workspaces you own; ask before closing
other apps or other workspaces' devices.

  stim doctor --platform ios          # or: --platform android

  # Skip Git creation if the harness already created this linked worktree.
  git worktree add -b <branch> <worktree-path> HEAD
  cd <worktree-path>
  stim worktree warm

  stim start
  stim ios                             # or: stim android, or: stim web

For the web target, stim web opens the page in a Stim-owned headless Chrome
and captures its console and errors in stim logs. Expo web needs no setup;
any other web server needs web.url. Read stim guide web first.

For a project using EAS development builds, read stim guide lifecycle eas to
select a profile from eas.json for the requested target, then run
stim ios --eas-profile <name> or stim android --eas-profile <name>.
Ask the user if the profile choice is ambiguous. A miss stops with
STIM_EAS_BUILD_MISSING and an EAS build command. Run that command only when the
session authorizes the potentially billable build, then retry Stim. The
presence of eas.json does not select EAS or authorize building.
Physical --device targets are supported. Follow EAS device-registration and
rebuild remedies only when the session authorizes those account changes.

To learn whether the next build is a cache hit and how long it should take,
without building, run stim ios --plan (or stim android --plan); see stim guide
lifecycle builds.

Read stim guide lifecycle concurrency when a build waits on another workspace
or a build call times out. A native build can outlive a shell timeout; if the
tool call timed out, retry the same command and follow its printed remedy if
waiting times out.

  # Reproduce the affected behavior and capture the baseline errors.
  stim logs --errors

  # If a native process exits with no report, inspect the captured device output.
  # An empty query is not proof that a crashed app was healthy.
  # See guide logs for JS/native symbolication and capture limits.

  # Edit JavaScript or TypeScript; Fast Refresh applies the change.
  # For UI work, wait for the expected UI and repeat the affected interaction
  # on the reported device. Keep using the existing automation session, if any.
  stim logs --errors
  # Retain proof before cleanup: a screenshot, recording, or relevant runtime output.

  stim stop
  stim worktree remove

RULES DURING THE LOOP

- Run Stim from the app directory: the one whose package.json depends on
  react-native or expo. Anywhere else -- a monorepo root, a tools package --
  start, ios and android refuse with STIM_NO_PROJECT naming that package.json,
  and doctor reports it as a finding.
- Put runtime .stim.json beside that app's package.json. Monorepo apps do not
  inherit a repository-root runtime file. Keep repository-wide worktree-copy
  rules at the source checkout root; see guide settings for the two scopes.
- A debug ios or android run starts this workspace's dev server when it is
  not running, including after it stopped itself for an hour with no use
  (guide metro). Running start first is optional; it lets Metro warm up while
  you do other work.
- Run ios or android again after a native input changes. A JavaScript-only
  change does not need one.
- For stale Metro transforms or file-map state, use stim start --reset-cache.
  It restarts only this app's verified owned Metro, preserving devices and other
  apps' caches. See guide lifecycle for reset scope.
- Reload is not part of the normal workflow. Use stim reload on an owned local
  simulator or emulator when an error screen remains after the fix, and on
  Android after a failed first bundle load. It reloads JavaScript and never
  restarts the app. An iOS app whose first bundle failed never connects to
  Metro, so reload cannot reach it and says to use the device's own Reload
  control. For a physical device that reached Metro, use agent-device metro
  reload with the reported port. The detected iOS Local Network first-load
  remedy uses UI automation instead because that app never established a Metro
  connection.
- A successful stim reload confirms that the request was sent, not that new
  JavaScript loaded or the screen recovered. Verify the expected UI on the
  reported device and inspect stim logs --errors before claiming recovery.
- If launch reports an app error but also says the native process is alive,
  the app did not crash. Fix JavaScript or TypeScript and use Fast Refresh. If
  the error screen remains, follow the printed reload remedy instead of
  running ios or android again. If launch says FATAL because the app process exited,
  fix the crash and run the platform command again; Metro cannot restart it.
- ios and android install the app, launch it, and check readiness. Trust the
  exact device, app, Metro, and launch facts in the final summary. Use the full
  reported device ID. Never assume a simulator named booted belongs to this
  workspace.
- After each ios or android run, give the user one compact result: exact device,
  app id, launch state, cache result, total duration, and whether stim logs
  --errors passed. Include a remedy only when action remains. Do not repeat the
  phase transcript.
- An OK summary with no launch qualifier proves the launch. "bundle requested,
  still building" means Metro has not finished; wait and query the logs. For
  launch UNVERIFIED, follow the printed remedy before claiming success. JSON
  reports these as true, "bundling", and "unverified" in launched.
  WARNING means the native launch completed with app errors, or an app readiness
  signal was expected but not confirmed; inspect the output before claiming a healthy UI.
- A clean logs --errors check requires exit code 0 AND no matching errors in
  captured logs. Exit code 0 alone means the query succeeded, even when errors
  were printed. Human output shows "No matching log records" on stderr for
  zero matches; JSON mode prints zero bytes. A workspace with no captured
  timeline refuses with STIM_NO_PROJECT and, in a monorepo, names the nearest
  registered descendant app with logs. Do not read the NDJSON files directly.
- Use stim status when resuming a workspace or recovering missing device,
  port, server, or build facts. A normal start and platform run already print
  them. Use stim doctor when a build is unexpectedly slow or the environment
  looks incomplete. If status reports a changed Android serial, rerun stim
  android with the same build options to restore forwarding, then reopen your automation
  session on the reported serial (guide lifecycle). Each status issue names a
  remedy to run from its workspace (guide facts status).

OWNERSHIP AND DELETION

Stim creates, boots, and deletes only devices it created. Owned simulators use
the stim-<label> (<model> <runtime>) name. Never point Stim at a user-created
emulator or simulator.

worktree remove parks the workspace's simulator or emulator for later adoption.
Before owned-device teardown, Stim best-effort closes local agent-device sessions
on that exact device; failures warn and teardown continues (guide cleanup).
A parked device is Stim-owned: never delete one by hand. gc --delete clears verified
entries and keeps failures; see guide lifecycle pool. First launch on a
physical iPhone can need the one-time taps named by the remedy.

stim android --device [serial] and stim ios --device [udid] install on a
connected physical device. Stim never creates, boots, shuts down, or deletes
hardware. It records a temporary lease, not an owned-device registry entry.

A --device run leases that device for the run. stim device lock ios --for 10m
holds it across runs; stim device unlock gives it back. Never delete another
workspace's lease file under ~/.stim/device-locks; gc --delete removes expired
ones.

stop and worktree remove release this workspace's leases. On a physical
iPhone, stop also closes the app by ending its log collector; it does not
shut down the phone or uninstall the app.

Treat a refusal as an ownership or state mismatch: read its code and remedy.
Never reach for --force first.
Stim leaves externally started Metro servers alone. Stop them with their original
tool; neither a matching Metro port nor --force grants process ownership.
Named ports are separate: ports stop kills TCP listeners on the workspace's
reserved named ports, even outside the workspace. Read guide ports before use.

Ask the user before these actions:

- worktree remove, because it deletes the worktree and gives up its owned
  device. It works with any linked worktree, warmed or not, without requiring
  a Stim registry entry. Git-created branches are kept; a branch with an
  existing Stim ownership record is deleted only when it has no unique commits.
- worktree remove --force, because it also discards uncommitted and untracked
  files.
- gc --delete, because it deletes orphaned resources, removes clean linked
  worktrees whose branch or pull request is merged (or whose pull request
  was closed), and clears the build outputs of every
  workspace not in use. Run stim gc --json first and show
  the user the entries its sections list (guide facts gc). gc --delete
  --cache all empties the shared build caches and those outputs instead, and
  gc --delete --cache workspaces clears only the outputs; both inspect
  nothing else.
- gc --delete --worktrees, because it runs worktree remove on every clean,
  idle linked worktree Stim manages, across projects.
- stop when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, stop shuts it down but does not
  delete it. An explicit stop shuts down a Stim-owned simulator even when
  another process uses it. It never shuts down an unowned simulator. It also
  cancels an ios or android run still building for the device it stops
  (guide lifecycle).

LEAVE THE MACHINE CLEAN

Run stim stop when you pause or finish a task, and stim worktree remove once
it is merged or abandoned. Never create a simulator or emulator by hand;
every device comes from Stim. Before starting a new workspace, check stim
status for an idle workspace to reuse and confirm capacity headroom instead of
adding another. Never quit Device Hub or Simulator.app: on Xcode 27
(confirmed on 27A266a), quitting Device Hub by default shuts down every booted
simulator on the machine, including ones it never opened a window for and
ones other workspaces or agents are using. Use stim stop on workspaces you
own instead.

SANDBOXES

An agent harness that sandboxes shell commands usually permits writes inside
the project and little else. Stim also needs writes to STIM_HOME (~/.stim by
default), simulator service access, and local access to the adb server. When
those sit outside the harness allowlist, the failure looks like an unwritable
directory or unavailable device service rather than a broken machine. Decide
at the start of a session whether to run Stim outside the sandbox or ask the
user to allow those operations. guide errors sandbox lists the exact
requirements.

LOAD ADVANCED GUIDANCE WHEN NEEDED

Read the matching guide before acting in these situations:

| Situation                                             | Read                             |
| ----------------------------------------------------- | -------------------------------- |
| Build waiting on another workspace or tool timeout    | stim guide lifecycle concurrency |
| --variant, scheme, or several APKs from assembleDebug | stim guide lifecycle options     |
| Refusal with a CODE                                   | stim guide errors <CODE>         |
| Running under a sandbox                               | stim guide errors sandbox        |
| Release configuration or ...Release variant           | stim guide lifecycle release     |
| Web app in an owned Chrome (stim web)                 | stim guide web                   |
| Web or API server ports                               | stim guide ports                 |
| Remote device, custom Metro, or tunnel                | stim guide metro                 |
| Cache miss, bypass, or fingerprint exclusions         | stim guide lifecycle builds      |
| Capacity limits                                       | stim guide lifecycle concurrency |
| budget lines, reclaimed field, or low disk            | stim guide lifecycle budget      |
| Cache statistics from stim stats                      | stim guide facts stats           |
| Worktree carry-over                                   | stim guide lifecycle options     |
| Doctor finding: seed checkout or cross-volume copy    | stim guide lifecycle options     |
| Doctor finding: iOS Debug archs, .cxx, fingerprints   | stim guide lifecycle builds      |
| Temporary storage placement                           | stim guide settings              |
| Read or change a setting (stim settings)              | stim guide settings              |
| Parallel iOS, simulator stall, or memory pressure     | stim guide lifecycle simslim     |
| Android boot timeout                                  | stim guide errors STIM_NO_DEVICE |
| gc or orphaned resources                              | stim guide cleanup gc            |
| worktree remove refusal or --force                    | stim guide errors remove         |
| Cleanup failure or unverified cleanup ownership       | stim guide errors teardown       |
| Unfamiliar state or JSON field                        | stim guide facts payloads        |
| Refusal without a code                                | stim guide errors                |

Use the CODE exactly as printed; codes sharing a header resolve to the same
section. For a refusal without a code, find its quoted message in the errors
index. Ordinary stim stop and an authorized clean stim worktree remove do not
need the cleanup guide. A sectioned topic called without a section prints its
index; choose the narrowest section.

FULL TOPIC LIST

  stim guide                      # list topics
  stim guide errors               # index of every refusal code and message
  stim guide errors <CODE>        # one refusal, e.g. stim guide errors STIM_NO_METRO
  stim guide errors sandbox       # running under a sandboxing harness
  stim guide errors unverified    # launch unverified, and the Local Network reason
  stim guide errors fallbacks     # swap, cache, and install notes on a release cache hit
  stim guide lifecycle            # the ordered flow, consent rules, and capacity
  stim guide lifecycle verification # reproduce, edit, verify the UI, and retain proof
  stim guide lifecycle readiness  # add optional app readiness logs; no package required
  stim guide lifecycle builds     # build optimizations, optional cache warm-up, fingerprints
  stim guide lifecycle concurrency # shared builds, wait timeouts, capacity limits
  stim guide lifecycle budget     # disk and memory budgets, automatic reclaim
  stim guide lifecycle options    # every flag, Android variants, --device-type, --system-image, --device-profile
  stim guide lifecycle devices    # ios --device and android --device on a physical phone
  stim guide lifecycle release    # Release configurations and ...Release variants
  stim guide facts                # the --json payloads
  stim guide facts devmenu        # the Expo dev menu or Tools button over the app
  stim guide web                  # stim web: owned Chrome, page logs, launched, teardown
  stim guide ports                # named ports for web and API servers
  stim guide metro                # supervisor, custom Metro, tunnels, and remote devices
  stim guide logs                 # filters, record shape, and capture limits
  stim guide cleanup              # what reclaims a device, and what deletes
  stim guide cleanup collector    # an unproven collector pid; why the app on a phone closed
  stim guide settings             # configuration files and supported keys`,
};
