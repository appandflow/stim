export default {
  summary: 'The normal coding-agent workflow, safety rules, and topic routing',
  body: () => `AGENT WORKFLOW

Use Stim to run React Native and Expo apps without sharing a Metro port or
device with another workspace. Prefer plain output: it streams each phase and
ends with the facts the next step needs. Use --json only when a script must
parse a stable payload.

For a native Xcode or Gradle app without React Native or Expo, read guide
lifecycle native-ios or guide lifecycle native-android before running it.

TWO WORKFLOWS

WORKTREE is the default. Take SINGLE CHECKOUT only when the user asks to work in
place, or the task depends on the user's uncommitted changes in the current
checkout; say why.

SINGLE CHECKOUT: work in place, on whatever branch the task needs, in one
directory. start, ios, android, logs, stop, and never a linked worktree. That
directory is your workspace, and no rule below about keeping the source checkout
fit as a seed applies to it.

WORKTREE: the checkout you cloned is a seed. It stays clean and on the default
branch, and every task gets a linked worktree warmed from it. In this workflow
the source checkout is infrastructure, not a workspace: you edit, build, and run
in the worktree, and you keep the seed fit to copy. Every rule below about the
source checkout's fitness as a seed belongs to this workflow.

DISPOSABLE STATE

In every workspace, node_modules, ios/Pods, Xcode DerivedData and the build
directories (android/app/build, android/build, android/.gradle, .build,
android/.cxx, android/<module>/.cxx and a .dd directory laid out as DerivedData) are
disposable. The stim-daemon deletes a workspace's build outputs when it goes
idle, and node_modules and Pods of idle linked worktrees under critical disk
pressure; the next start, ios or android restores them from the build cache
or with worktree warm. Never fix a dependency by editing files inside them:
the change is lost. Put dependency changes in the project's own patch
mechanism, such as patch-package, pnpm patch, yarn patch or a Podfile
post_install hook, and commit them.

MULTIPLE DEVICES

Use ios/android --slot <name> to retain multiple devices in one workspace,
including several of the same model. Reuse the same slot name on subsequent
runs. Read guide lifecycle options for the complete slot workflow. Drive a
slot's device with stim agent-device --slot <name>. All slots share Metro and reload can
reach multiple devices. A launch counts a bundle delivery only when it can
attribute it to its own device; read guide lifecycle options for the rule.
Use stop --slot <name> for one slot, or plain stop for the whole workspace.

HOSTED IOS AND ANDROID

For ios --remote <machine|auto>, read guide lifecycle hosted-ios.
For android --remote <machine|auto>, read guide lifecycle hosted-android. Native
logcat records arrive through stim logs, including --errors and --json;
Desktop and the phone view/control it through the local stim-server relay.
Stop before switching
between a local simulator and a hosting Mac. Hosted Debug requires the local
Metro supervisor; restart a missing or older one with stim stop; stim start.
A named Mac never falls back here; auto can use the local device queue when no
host admits. Auto keeps a live local slot or recorded hosted session. Follow the
placement reason and the reported device. Stop reconciles a recorded host
before changing named placement.
DRIVING THE DEVICE

Drive this workspace's iOS or Android device through stim agent-device, never
agent-device directly. Pass agent-device's own arguments and no device ids:

  stim agent-device open <bundle id>
  stim agent-device snapshot -i --json
  stim agent-device press @e3
  stim agent-device scroll down --slot tablet --platform android

Stim adds the platform, the UDID or serial and AGENT_DEVICE_STATE_DIR, or the
remote config of a hosted iOS or Android session (guide lifecycle hosted-ios or
hosted-android), and the session (stim-<slot>-<platform> unless you pass
--session; a hosted session adds -<8 hex digits of the workspace id>, so two
workspaces on one machine do not share a name).
--slot picks a slot; --platform is needed only when the slot has both. It
revives an idle-stopped workspace before the command (progress on stderr).
For a hosted session, a single-action command (snapshot, press, tap, scroll,
type and the like) that fails with SESSION_NOT_FOUND because the host lost the
agent-device session (it restarted, or no command reached it for an hour) is
retried once after opening the app the workspace last launched on the same session; the command acts on that app's
screen as it is after the reopen, so take a fresh snapshot when a coordinate
gesture matters. Only the final run's output is printed, so --json output stays
one document. Multi-step commands (batch, replay,
test) are never retried.
stim agent-device refuses with STIM_BAD_ARG a UDID, serial, device or remote config that is not
this workspace's, and boot and shutdown: Stim owns the device lifecycle. stdout, stderr and the exit
code are agent-device's, so --json output stays parseable. Take snapshots with
--json so viewers can outline the element each press acts on. It needs
agent-device 0.21.30 or later; it does not drive macOS apps (guide macos).
Without it, set AGENT_DEVICE_STATE_DIR from agentDevice.stateDir in
stim ios|android|macos --json or status --json (guide logs). Do not set
AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH or AGENT_DEVICE_CLAIMS_DIR.

NORMAL WORKFLOW

Create a linked worktree with Git and warm its ignored state. If a harness
already created this linked worktree, run stim worktree warm here instead of
creating another one. It copies missing ignored paths from the source checkout,
including eligible .env and local configuration files. It preserves the branch, tracked files, and
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
so it also checks the source checkout. Doctor never loads fingerprint.config.js
or runs an eas from the project tree; its fingerprint checks can still run
installed Expo packages, including hoisted ones, as a build does. warm,
start, ios and android run project code. Follow each finding's printed remedy,
and read the routed topic below before acting on one you do not understand. If
the stim resolved from PATH is older than another installation, fix PATH or the
installation before continuing so commands and guidance match. Under host
memory pressure, stop only devices in workspaces you own; ask before closing
other apps or other workspaces' devices.

  stim doctor --platform ios          # or: --platform android

  # Worktree workflow. Skip Git creation if the harness already created this
  # linked worktree.
  git worktree add -b <branch> <worktree-path> HEAD
  cd <worktree-path>
  stim worktree warm

  stim start
  stim ios                             # or: stim android, or: stim web

Some Linux command runners reap detached descendants when a call ends, killing
Metro after stim start succeeds. If that happens, read guide metro, LINUX
RUNNERS THAT REAP BACKGROUND PROCESSES, for the user-systemd service recipe.

When Stim Desktop is installed, worktree warm, start, ios, android and web
print "Open in Stim: <link>" on stderr (links.desktop in JSON). The
first time one prints it in a workspace, tell the user once: "You can watch
this workspace in Stim Desktop: <link>". Do not repeat it after later
commands. When no command prints it, do not mention Stim Desktop.

For the web target, stim web opens the page in a Stim-owned headless Chrome
and captures its console and errors in stim logs. It never starts a web
server: start the dev server first, then run stim web. For Expo web the dev
server is stim start, and the app needs the react-dom, react-native-web and
@expo/metro-runtime dependencies. Any other server runs on stim ports get web
and needs web.url. Read stim guide web first.

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

Agents never set STIM_ACCESS_TICKET, run stim-server setup, edit remote.*,
server.* or hosting.* for the user, or approve requests. Read stim guide settings for
Desktop access tickets and person-owned approval.
Read stim guide settings to select a remote machine. Keep a requested named
placement when recovering STIM_OFFLOAD_REFUSED: report its reason and remedy.
When the user mentions slow builds, a busy machine or wanting updates away from the desk, tell them about Stim Desktop > Settings > Connections > This machine uses > Add (or stim remote add <machine> in their terminal) or Connections > Using this machine > Add > Pair a Phone; see stim guide settings.

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
  # with stim agent-device. Keep using the existing session, if any.
  stim logs --errors
  # Retain proof before cleanup: a screenshot, recording, or relevant runtime output.

  stim stop
  # From the worktree root. From an app folder, it reclaims only that app.
  stim worktree remove

RULES DURING THE LOOP

- Agents never run stim-server setup and never approve access requests.
  A person on the worker approves builds and device hosting (guide settings).
- Run Stim from the app directory: the one whose package.json depends on
  react-native or expo. Anywhere else -- a monorepo root, a tools package --
  start, ios and android refuse with STIM_NO_PROJECT naming that package.json,
  and doctor reports it as a finding.
- Put runtime .stim.json beside that app's package.json. Monorepo apps do not
  inherit a repository-root runtime file. Keep repository-wide worktree-copy
  rules at the source checkout root; see guide settings for the two scopes.
- A debug ios or android run starts this workspace's dev server when it is
  not running, including when it stopped itself after 15 minutes with no use
  (guide metro). Running start first is optional; it lets Metro warm up while
  you do other work.
- When the app shows "could not connect", a red or blank screen after a
  pause, run stim revive. After an idle stop it restarts Metro, boots the owned
  simulator or emulator the app last ran on, and relaunches the app from cold,
  so in-app state is gone. It never builds and never starts what the
  workspace did not have; when it refuses, follow its remedy (guide metro).
- Run ios or android again after a native input changes. A JavaScript-only
  change does not need one.
- The build cache counts an installed package by its name and version, so it
  cannot see a file you edit inside node_modules/. Change a dependency's native
  code with a patch (patch-package or pnpm patch), which is hashed, or run ios or
  android with --no-build-cache --remote-build local to compile it here. See
  guide lifecycle builds.
- For stale Metro transforms or file-map state, use stim start --reset-cache.
  It restarts only this app's verified owned Metro, preserving devices and other
  apps' caches. See guide lifecycle for reset scope.
- Reload is not part of the normal workflow. Use stim reload when an error
  screen remains after the fix on an owned local simulator or emulator, a
  physical device (an EAS Simulator session when its app connects to Metro), and on
  Android after a failed first bundle load. It reloads JavaScript and never
  restarts the app. An iOS app whose first bundle failed never connects to
  Metro, so reload cannot reach it and says to use the device's own Reload
  control. With no owned launch recorded, reload goes through this workspace's
  Metro to the apps connected to it, so an app that never connected is not
  reached. The detected iOS Local Network first-load
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
- ios and android install the app, launch it, and check readiness. A running
  copy of the app is stopped and launched fresh, so in-app state does not
  survive the run. Trust the exact device, app, Metro, and launch facts in the
  final summary. Use the full reported device ID. Never assume a simulator
  named booted belongs to this workspace.
- With no matching Android system image, android downloads one (about 2 GB)
  with sdkmanager unless android.installImages is never. It never accepts SDK
  licenses: give the user the refusal's \`sdkmanager --licenses\` command.
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
  android with the same build options to restore forwarding; stim agent-device
  then targets the new serial (guide lifecycle). Each status issue names a
  remedy to run from its workspace (guide facts status).

OWNERSHIP AND DELETION

Stim creates, boots, and deletes only devices it created. Owned simulators use
the stim-<label> (<model> <runtime>) name. Never point Stim at a user-created
emulator or simulator.

worktree remove parks the workspace's simulator or emulator for later adoption.
During owned-device teardown, Stim best-effort closes local agent-device sessions
on that exact device; failures warn and teardown continues (guide cleanup).
A parked device is Stim-owned: never delete or erase one by hand. gc --delete clears
verified entries and keeps failures; gc --cache parked --delete erases them and keeps
them parked; see guide lifecycle pool. First launch on a
physical iPhone can need the one-time taps named by the remedy.

stim android --device [serial] and stim ios --device [udid] install on a
connected physical device. Stim never creates, boots, shuts down, or deletes
hardware. It records a temporary lease, not an owned-device registry entry.

A --device run leases that device for the run. stim device lock ios --for 10m
holds it across runs; stim device unlock gives it back. Never delete another
workspace's lease file under ~/.stim/device-locks; gc --delete removes expired
ones.

stim device provision ios [udid] registers a phone with the project's Apple
Developer team and creates or refreshes its Development profile. It changes
the team's developer account, so never run it, and never pass it --yes,
without the user's explicit go-ahead for that step. When ios --device fails
on signing, report the remedy and ask the user.

stop and worktree remove release this workspace's leases. On a physical
iPhone, stop also closes the app by ending its log collector; it does not
shut down the phone or uninstall the app.

Builds and boots of owned devices take a slot under caps derived from the
machine (concurrency.* overrides them). A run past a cap waits in arrival
order and prints its queue position every 10s. It keeps waiting while the
holders ahead are alive; it refuses with STIM_AT_CAPACITY only after 90m, or
when a holder cannot be verified (or devices cannot be counted) for
max(10m, position x 5m). Use --wait <seconds> to bound a device wait or
--no-wait to refuse at once.
While a run waits to boot, the stim-daemon shuts down one idle device (2m) of
another workspace per tick; it never deletes devices or touches this
workspace, physical, hosted, remote, parked or other homes' devices.
Read the holder names in progress and build.waitingFor in status; do not start
replacement runs while one is queued. See \`stim guide lifecycle concurrency\`.

After idle.minutes (default 15) with no Stim command, native run, Metro
request, agent-device action or input to its devices, the stim-daemon puts the
workspace in the idle stage: Metro stops with its port kept, its owned devices
shut down and its regenerable build outputs are deleted. Device and app logs do
not count. stim status shows the stage; after a pause, run stim revive to
restart Metro, boot the device and relaunch the app before driving it. A device
hosted on a remote Mac keeps its workspace out of the idle stage, and
stim-server stops a hosted session whose client has been gone for
maintenance.idleStopHours; see \`stim guide cleanup\`.

Treat a refusal as an ownership or state mismatch: read its code and remedy.
Never reach for --force first.
Stim leaves externally started Metro servers alone. Stop them with their original
tool; neither a matching Metro port nor --force grants process ownership.
Named ports are separate: ports stop kills TCP listeners on the workspace's
reserved named ports, even outside the workspace. Read guide ports before use.

Ask the user before these actions:

- worktree remove of a worktree you did not create, because it deletes the
  worktree and gives up its owned device. It works with any linked worktree, warmed or not, without requiring
  a Stim registry entry. Git-created branches are kept; a branch with an
  existing Stim ownership record is deleted only when it has no unique commits.
- worktree remove --force, because it also discards uncommitted and untracked
  files.
- gc --delete, because it deletes orphaned resources, removes clean linked
  worktrees whose branch or pull request is merged (or whose pull request
  was closed), and runs the pressure ladder to its end at high: every
  workspace idle 2 minutes or more goes idle (stim revive resumes it),
  parked devices are deleted, shared caches are trimmed, and workspaces idle
  10 minutes or more go dormant, losing their owned devices. That includes
  the workspace you run it from: an app you are not driving right now stops.
  It never touches a workspace that is building, driven, leased, shared
  with stim share, hosted or pinned by maintenance.keep, and keeps
  node_modules and Pods unless --cache all. Run stim gc
  --json first and show the user its sections and its ladder (guide facts
  gc). gc --delete --cache all also empties the shared build caches and the
  build outputs, and runs the ladder at critical, which deletes node_modules
  and ios/Pods of idle linked worktrees (worktree warm restores them).
  gc --delete --cache workspaces clears only the outputs.
- gc --delete --worktrees, because it runs worktree remove on every clean,
  idle linked worktree Stim manages, across projects.
- settings set daemon.mode on in a home where it is off or report, because
  it lets Stim itself stop idle workspaces, delete their build outputs and
  devices, trim caches and remove finished worktrees later, with no command
  from you. It is on by default outside CI. maintenance.keep true pins a
  workspace against that; daemon.mode report or off stops it.
- stop when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, stop shuts it down but does not
  delete it. An explicit stop shuts down a Stim-owned simulator even when
  another process uses it. It never shuts down an unowned simulator. It also
  cancels an ios or android run still building for the device it stops
  (guide lifecycle).

LEAVE THE MACHINE CLEAN

Run stim stop when you pause or finish a task, and stim worktree remove on
the worktree you created once its work is merged or abandoned. Keep scratch
files, test output and downloads outside the worktree: a stray untracked file
blocks that removal, and automatic cleanup then has to archive it. Never create a simulator or emulator by hand;
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

REPORT STIM PROBLEMS

When Stim misbehaves, refuses for a reason its guide does not explain, documents
something that proves wrong, or needs an awkward workaround, offer to report it
to appandflow/stim on GitHub. Finish the user's task first.

1. Search first: gh issue list --repo appandflow/stim --state all --search
   "<code or symptom>". On a match, offer a comment with your new evidence
   (gh issue comment <number> --repo appandflow/stim --body-file <file>)
   instead of filing a duplicate.
2. Draft the issue under the headings of the report template:
   Problem (what happened and what you expected, with the STIM_* code), Evidence
   (the exact command, the relevant output, stim --version, the OS, the Xcode
   or Android tool versions, and the stim doctor findings), Cause (unknown is
   an honest answer) and Fix idea (optional, including the workaround you used).
3. Remove secrets, tokens, passwords, private paths, project names and project
   code, unless the user agrees to include them.
4. Show the user the draft. File the issue or comment only after their OK, since
   it is public and publishes on their behalf: gh issue create --repo
   appandflow/stim --title "<title>" --body-file <file>. Without gh, give them
   the draft and https://github.com/appandflow/stim/issues/new?template=report.md.

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
| User asks to share the running app (stim share)       | stim guide share                 |
| Web or API server ports                               | stim guide ports                 |
| Remote device, custom Metro, or tunnel                | stim guide metro                 |
| Metro stopped and no one ran stim stop                | stim guide metro                 |
| App shows could not connect or blank after a pause    | stim guide metro                 |
| Cache miss, bypass, or fingerprint exclusions         | stim guide lifecycle builds      |
| Capacity limits                                       | stim guide lifecycle concurrency |
| Pressure level, STIM_LOW_DISK, or the dormant stage   | stim guide lifecycle budget      |
| Cache statistics from stim stats                      | stim guide facts stats           |
| Worktree carry-over                                   | stim guide lifecycle options     |
| Doctor finding: seed checkout or cross-volume copy    | stim guide lifecycle options     |
| Doctor finding: iOS Debug archs, .cxx, fingerprints   | stim guide lifecycle builds      |
| Temporary storage placement                           | stim guide settings              |
| Read or change a setting (stim settings)              | stim guide settings              |
| Parallel iOS, simulator stall, or memory pressure     | stim guide lifecycle simslim     |
| Android boot timeout                                  | stim guide errors STIM_NO_DEVICE |
| gc or orphaned resources                              | stim guide cleanup gc            |
| watchman or Gradle daemon memory                      | stim guide cleanup memory        |
| worktree remove refusal or --force                    | stim guide errors remove         |
| Cleanup failure or unverified cleanup ownership       | stim guide errors teardown       |
| Swift Package macOS development                        | stim guide macos                 |
| macOS app on another Mac (stim macos --remote)        | stim guide macos                 |
| Unfamiliar state or JSON field                        | stim guide facts payloads        |
| User asks for the Stim tutorial                       | stim guide tutorial              |
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
  stim guide lifecycle readiness  # add recommended app readiness logs; no package required
  stim guide lifecycle builds     # build optimizations, optional cache warm-up, fingerprints
  stim guide lifecycle concurrency # shared builds, wait timeouts, capacity limits
  stim guide lifecycle budget     # pressure level, the ladder, the dormant stage
  stim guide lifecycle options    # every flag, Android variants, --device-type, --system-image, --device-profile
  stim guide lifecycle devices    # ios --device and android --device on a physical phone
  stim guide lifecycle tools      # device location|permission|push|network on the owned simulator or emulator
  stim guide lifecycle release    # Release configurations and ...Release variants
  stim guide api                  # typed run, stop, diagnostics and cancellation from the main package
  stim guide facts                # the --json payloads
  stim guide facts devmenu        # the Expo dev menu or Tools button over the app
  stim guide macos                # Swift Package Debug apps, logs, local preview, --remote on another Mac
  stim guide web                  # stim web: owned Chrome, page logs, launched, teardown
  stim guide share                # stim share: public password-protected link, security model
  stim guide ports                # named ports for web and API servers
  stim guide metro                # supervisor, custom Metro, tunnels, and remote devices
  stim guide logs                 # filters, record shape, and capture limits
  stim guide cleanup              # what reclaims a device, and what deletes
  stim guide cleanup collector    # an unproven collector pid; why the app on a phone closed
  stim guide cleanup memory       # watchman and Gradle daemon memory; gc --cache watchman
  stim guide tutorial             # tutorial sections
  stim guide tutorial run         # create the app and build in a tour worktree
  stim guide settings             # configuration files and supported keys`,
};
