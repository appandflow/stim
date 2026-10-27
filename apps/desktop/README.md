# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, live frames from its iOS simulators and Android emulators, and its CPU
and memory (the physical footprint `stim status` measures).

It reads live status and explicit refreshes only through the matching local server's workspace, machine and archive views. Refresh requests fresh subscriptions and coalesces repeated requests; connection or view errors retain the last good display and report the error until fresh data arrives. It never starts a CLI status child. Other reads use `stats.get`,
`logs.query` / `logs.subscribe` / `desktop.logs.subscribe`, `desktop.settings.get` / `desktop.settings.schema`, `desktop.plan.get`, `stim doctor --json` for remaining setup flows, and the local server's `desktop.reports` doctor and GC dry runs, and never reads or writes `$STIM_HOME`.
Project stats and build-machine placements use fresh `stats.get` requests when the existing loopback
server session is open, allows reads, and serves the same canonical Stim home as the CLI. An unavailable or ineligible session shows a read error; reading stats never starts the server. Cancelling a stats refresh stops waiting and ignores its late reply, keeping device
viewing connected. The server job can continue until it finishes or reaches its existing limits (normally
60 seconds), occupying a request slot until then. The shared connection accepts complete WebSocket messages
up to 16 MiB, including the JSON envelope; an oversized stats response fails the read without a CLI retry.

Storage previews also require the matching local server, with `desktop-reports` support. A refresh
invalidates the server report before reading it so the preview measures current storage. Every report
read shares one request per report target on the connection: a second read of a target joins the one in
flight instead of sending another, and invalidates only that target when the server offers
`desktop-report-invalidate-target` (every report otherwise). Report, settings and stats reads that the
server refuses with `limit-exceeded` retry after 0.25, 0.5, 1, 2 and 4 seconds, then fail with a message
that the local stim-server is busy. The shared
GC report store keeps its existing demand-driven refreshes, coalesces callers, and retains its last
good report and measurement age when a read fails. An older server shows an update error. Reads
never retry through the CLI. Cancelling stops waiting without disconnecting the shared session, and
a shared report read whose callers have all cancelled sends nothing further;
the server report can continue within its execution and cleanup limits (up to 150 seconds at the
request boundary). The same 16 MiB response limit applies.

Sidebar setup findings also use the matching local server's doctor report. Desktop checks setup-file
changes and the server's Stim version at its existing 60-second cadence; a successful report stays
current for seven days unless those inputs change or a Desktop action invalidates it. Reads invalidate
the server report before measuring and send a new read even while one for that project is in flight, retain the last good findings on failure, and retry a failed report
at the next check. They do not subscribe to periodic report refreshes or retry through the CLI.

The setup guide's explicit project check runs through `desktop.doctor.run` on the
matching-home local server. It records a completed native doctor check and can
register the chosen project. Its Activity result and setup completion still use
the full JSON report. It requires `desktop-doctor-run` support and has no CLI
fallback; cached doctor report reads remain read-only.

Add Machine and reconnect access requests use `desktop.machine-access.subscribe`
on the matching-home bundled server with private Desktop authority and
`desktop-machine-access` support. The optional setup ticket stays in the private
request, never CLI arguments or progress. The server requests build and device-host
access without applying project repairs; a person still approves each capability on
the worker. Cancellation waits for owned cleanup, and an unresolved cleanup refuses
another action in that workspace. Reconnecting never repeats the request automatically.

Whole-workspace and named-slot stops, including tutorial and sample cleanup, use
`desktop.stop.subscribe` on the matching-home bundled server with private Desktop
authority and `desktop-stop` support. Activity retains ordered progress and the
terminal result. A connection failure ends the local action without replaying it
on reconnect; cancellation unsubscribes while server-owned teardown already started
finishes. An unavailable or incompatible server reports an error without a CLI fallback.

Dev-server starts, including the sample build, use `desktop.start.subscribe`
with private Desktop authority, the matching Stim home and `desktop-start`
support. Activity keeps ordered progress and the flat start result or typed
refusal. The server admits both the selected folder and resolved app against
other mutations. Cancellation, unsubscribe, disconnect and server shutdown drain
owned work before releasing admission; unconfirmed cleanup retains it. After
verifying no child remains and clearing the exact claims in the refusal's remedy,
retry the action; the server rechecks those claims and releases the reservation.
Desktop waits for a startup cancellation acknowledgement before stopping the sample;
an unresolved cleanup refusal includes the exact claim recovery remedy.
The 120-second deadline cancels startup and waits for owned cleanup; an unresolved
claim refusal takes precedence over the timeout so its recovery remedy remains visible.
Requests have a 1 MiB output limit. Older or adopted servers show
an error, and reconnect does not replay a start. The supervisor continues running
after a successful handoff to its workspace.

Worktree warming from the menus and setup-before-run flow uses
`desktop.worktree.warm.subscribe` on the matching-home bundled server, requiring
private Desktop authority and `desktop-worktree-warm` support. It copies missing
ignored entries and preserves existing files. Activity keeps ordered progress and
failure diagnostics; cancellation waits for cleanup acknowledgement. Reconnect
never replays the copy, and an unavailable or older server fails without a CLI
fallback. This path does not refresh the source checkout or install dependencies.

Platform runs, including the sample build test, use `desktop.run.subscribe` with
private Desktop authority and `desktop-run` support on the matching-home bundled
server. Named slots, hosted machines, remote build selection, uncached test builds
and headed web retain their selectors. Activity keeps ordered progress, flat
platform facts and typed refusals. Cancellation waits for server cleanup; a
retained claim refusal keeps its recovery remedy. A lost connection never replays
the run. Older, adopted or unavailable servers report an error without a CLI fallback.

Reload actions also use the matching-home bundled server's private authority,
through `desktop.reload.subscribe` with `desktop-reload` support. Activity keeps
ordered progress and the flat CLI JSON or typed refusal. Cancellation,
unsubscribe and disconnect stop pending work; reconnect never replays the action.
A dispatched reload cannot be retracted and does not prove completion. Metro
broadcasts can reach other connected clients. The in-process operation has a
60 second execution budget and 35 second cleanup budget; an unresolved cleanup
keeps its server admission reserved. Older or adopted servers report an error
without falling back to a CLI process.

Cleanup actions use `desktop.gc.subscribe` with private Desktop authority,
the matching Stim home and `desktop-gc` support. Cache, worktree, age and idle
selectors retain their existing behavior. Activity keeps ordered progress and
the complete JSON report, including partial failures. Cancellation waits for
server cleanup and preserves an unresolved claim's recovery remedy. The
operation has a 60-second execution budget and 35-second cleanup budget;
the server's request deadline can cancel it earlier. Older, adopted or
unavailable servers report an error without a CLI fallback. Reconnect never
repeats the cleanup.

Worktree removal, including tutorial restart and sample teardown, uses the
same-home bundled server's private `desktop.worktree.remove.subscribe` action.
It preserves the CLI's dirty-worktree refusal and explicit force choice. Source
checkout cleanup succeeds without deleting the source; linked-worktree deletion
and a later branch-cleanup failure remain separate results. Cancellation waits
for owned cleanup and preserves unresolved-claim remedies. An unavailable,
adopted or older server fails the action without a CLI fallback; reconnect never
repeats removal. Tutorial restart leaves the clone in place if stop or removal
fails.

Help > Copy Diagnostics reads both running versions and a fresh complete doctor report through the
matching local server. Unknown report fields are preserved. When the server is unavailable or does
not support reports, the copied diagnostics include the reason without a CLI fallback. Pasteboard
redaction and workspace selection stay the same.

Device replay and a leased physical device's screen, which only stim-server serves, come from the stim-server Desktop runs or found, over loopback (see [stim-server](#stim-server)); see [Replay](#replay) and [Physical devices](#physical-devices). Its
remaining actions run the `stim` executable with an argument list, never a shell string,
in the workspace directory:

- Needs you notifications: a notification in **Notifications** whose category
  is **Needs you** carries the actions of what it reports. **Run** runs the
  remedy from the workspace, such as `stim android --slot fold`; **Copy
  command** copies it as a `cd` and `stim` line; a `stim guide` remedy is copy
  only; **Fix** runs `stim doctor --fix` after a confirmation; **Open Logs**
  opens the workspace's logs for a failed signing run; **Show in Finder**
  selects a kept worktree.
- Run: **Run on iOS** and **Run on Android** in a workspace's context menu and
  "..." menu, and **Run** on each platform of the inspector's **Build**
  section (**Rebuild** when that platform's last build failed), run
  `stim ios` or `stim android` in the workspace with the default slot and configuration.
  Placement is set by config or agents, for example
  `stim settings set ios.remote auto --scope workspace` (or `android.remote`),
  or per run with `stim ios --remote auto` / `stim ios --remote <machine>`.
  Desktop passes no remote flag for a new run. Recorded hosted sessions stay
  fixed to their machine until `stim stop`. When a device is not on this Mac,
  its tile, workspace page, viewer toolbar and sidebar row show the machine's name
  with a computer icon (VoiceOver: "Running on &lt;machine&gt;"),
  with the placement reason as hover text. Local devices show no placement label. The
  menus offer the platforms `stim status` reports in `platforms`, plus any
  with a device or a last build; an older `stim` that does not report them
  offers the used ones, or iOS and Android when none is recorded. Run is disabled while a build runs in the workspace.
  **Reload App** requests the equivalent of `stim reload` through the local server and is disabled unless the dev server and a
  local device are running.
- Workspace page: the "..." menu beside the stage line runs `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch. Each running device's
  viewer has its own **Stop** button, running `stim stop --slot <name>` (`default` for the workspace's
  default device) so the shared server and other slots keep running --
  `--slot` is per slot, not per platform, so it also stops that slot's
  Android device if the slot holds one.
- Idle devices: when the storage preview lists idle devices, the
  sheet offers **Shut Down Idle** with a duration (30 minutes to 1 day), then
  runs `stim gc --idle <duration> --json` after a confirmation. That shuts the devices
  down like `stim stop` and never deletes them. The preview marks idle and
  unrecognized `stim-*` devices as kept, because `stim gc --delete` never
  touches them.

Click the toolbar's CPU, memory or disk figure for its details. Each popover
includes **Open Machines** to open the Machines page.
While details are open, hover another resource figure to switch the contents. Click outside to close.
CPU covers active workspace processes; memory covers the whole Mac.

The bell at the top right opens **Notifications** and shows the unread count.
Notifications remain available under the bell. New-workspace cards in the bottom-left stack dismiss
after one minute. Other notices in that stack stay until acted on or dismissed. Workspace cards keep
the same layout for short and long names.
**Overview**, **Active Workspaces** and **Machines** stay pinned at the top of
the sidebar; only the list below them scrolls.

**Overview** is the default launch page. The **Active** section comes first, as
the same grid of workspace cards the Active workspaces page uses (see below). With nothing
running it says where active projects will appear. **Idle projects** follow as
compact cards in an adaptive grid, newest activity first, with the pull request
that is open, a failed last build and the errors since the last marker. The grid
shows six, and **Show more (N)** expands the rest in place. Clicking a card opens
the project with all its worktrees, under a **Showing all workspaces** chip that
returns to the active ones; the saved sidebar filter does not change. A project
page whose worktrees are all inactive offers **Show All**. A **Recently archived** row lists the last five
archives.

**Active Workspaces** shows every worktree with something running, building or
warming as a card in a grid: two columns at typical widths, one when the window is
narrow and three when it is very wide. The Overview's **Active** section uses the same
cards. A card's header has the worktree's name and project, the app path, and chips
for Metro, who drives the devices, CPU, memory and errors. Its body streams the
worktree's first device live through the same frame pipeline as the device tiles,
at the device tile size and the live frame rate from Preferences; a workspace with a
Mac app, a browser or devices from several apps shows a row of buttons that switches
which one streams, labelled by app when the worktree has several. The choice is
remembered until Desktop quits. A workspace with no running device shows its build
progress, setup state or Metro status in the same area. Clicking the card or its header
opens the workspace (on the Active Workspaces page, the project); clicking the stream
opens the workspace with that device focused. Cards that scroll out of view stop
streaming and reconnect when they return.

The sidebar lists projects as a
tree. Each project expands to its workspaces,
and selecting the project row shows all of its workspaces and devices. Projects
with an active, warming or ready workspace start expanded, and the app remembers each project you
expand or collapse. A workspace is named like in the phone app: after its
worktree's branch, else the worktree's folder, else its project for a main
checkout. The second line is where it sits inside its checkout, such as
`apps/mobile`. The view options button next to the logo opens a menu:

- **Status**: select any combination of Active, Idle, Not set up and Archived. The
  default is Active + Idle. All selects all four states, Archived included, and
  shows as checked only when all four are on. Each state shows its sidebar row count, counting a
  multi-app worktree once and excluding hidden projects. When mixed with current
  rows, archives follow those rows within each project, newest removal first.
  Archived uses the same repository and worktree grouping, with app labels, PR
  number or Merged, removal time, retained size and a media expiry indicator.
  Active also shows a workspace with a running build, and one that
  `stim worktree warm` is preparing ("Warming...", with an activity indicator)
  or has prepared before its first run ("Ready").
- **Hidden**: off by default and not part of All. It shows the workspaces you hid
  with **Hide** (see below), each marked with a small eye-slash.
- **Projects**: which projects the sidebar lists.
- **Group by**: Project (the tree) or None (one list, each row subtitled with
  its project too).
- **Sort by**: Name (the default), Last activity or Memory. Name orders rows by project, then
  workspace title, so rows stay in place while agents work. Last activity is the newest time
  `stim status --json` records for the workspace: device activity, a driver
  attaching, Metro's supervisor or a remote session starting, or a build
  starting, changing phase or ending. Projects sort by their newest workspace
  or their total memory.
- **Show Git Status** and **Show Empty Projects** (projects the other options leave with no rows).

The app remembers every choice. The button turns purple with a dot while any
option differs from its default, and the menu then ends with **Reset**. When
the options hide every row, the list says so and offers **Show All** or
**Reset**. Arrow
keys move through the menu, Return picks, and Right and Left open and close a
submenu.

When a workspace that is not warming has no device, a small purple device
illustration and a launch hint appear. Its animation stops under Reduce Motion.
When **Overview**, **Active Workspaces** or a project has nothing running, the page shows three example prompts for a coding agent, picked at
random from the phone app's list each time the page appears, with a **Copy**
button that reads **Copied** once the prompt is on the clipboard.

Each workspace row shows its worktree's git state from `stim status --json`: a
dot with the number of uncommitted files, arrows for commits ahead of and
behind the upstream, and **merged** when `gc` would call the branch merged. A
clean branch level with its upstream shows nothing. Hovering the row indicator
spells it out.

## Feature flags

Feature flags are local to this Mac and live in `UserDefaults`; nothing reads them from a server. **Settings >
Advanced > Feature flags** lists them with **Reset to Defaults**. Code asks `FeatureFlags.isEnabled(.phoneApp)`
(StimKit), or `FeatureFlagStore.shared` from a view. A launch argument such as `-featureFlag.phoneApp YES` sets a
flag for one run.

**Phone app** is off by default. Off, Desktop hides the Phones page, the phone steps of the setup guide and tutorial, the `phone.away` suggestion and mentions of
phones in copy. It never revokes a pairing. Desktop's own stim-server then listens on loopback only. A Mac that already serves phones or has a
paired phone gets the flag on at first launch with flags. The phone app is documented in
`website/docs/phone-app.md`.

## Hiding a workspace

**Hide** and **Unhide** are in the sidebar row's context menu and in the page's "..." menu for a worktree
row, a multi-app worktree, a Not set up worktree and an archived workspace. A hidden workspace leaves Active,
Idle, Not set up and Archived and shows only under the Hidden status. When the filter hides at least one,
a quiet sidebar footer reads "3 hidden - Show"; once Hidden is on it reads "Hide again". The list is kept in
this Desktop's own preferences on this Mac, by the workspace path Stim reports (and the archive id for an
archive). It is not shared with the phone app or another Mac, and Stim itself does not know about it.

A hidden workspace is shown again when it becomes active: its dev server runs, a build starts, a device boots
or connects, it is being set up, or a run starts from Desktop. Recent idle activity does not count. A
workspace in use cannot be hidden. Entries for a workspace that is no longer active, idle, not set up or
archived are dropped.

## Archived workspaces

The Archived sidebar filter opens the same workspace page as active workspaces in a read-only variant.
The header line matches the live page's: an Archived state with the removal age (hover for the exact time), the git chip with branch, PR and Merged, and a menu with **Reveal Folder** (while the folder exists) and **Delete Archive**.
The Status card holds the removal reason, last use, and Retained with a proportion bar and per-kind bytes and expiry dates; the Build card ends with build totals, known cache hits, builds on a remote Mac and errors at removal.
Work keeps the branch, PR number and title, final head and subject, and ended agent sessions
with their duration and a link to retained actions. Only Merged is shown as a PR state:
other states in the removal snapshot can be stale. Build cards and the build history sheet show retained runs and phase timings.
Earlier runs on an active workspace link to archives for the same canonical project path,
including records whose `replacedBy` points to that workspace. The archive page links
back to its replacement when there is one.

Logs use the existing source, slot, level, error and search filters, querying the connected
loopback stim-server without following. Busy-server refusals retry briefly. `archive.detail` supplies build history and the retained
iOS, Android and Web recordings by slot; replay reads their ranges sequentially, once per recording.
Logs and recordings show expired only when a reported expiry is past. Zero bytes with no
expiry means nothing was kept. Recording expiry is a label: retained replay spans remain
available regardless of the client clock. Archived pages offer
no live device or workspace actions. An older server shows an update hint for archive
requests that require a workspace instead of an archive; other refusals show the server's
message. Connect through the Phones page to read logs and replay.

Each of Logs, Recordings and Agent actions has a **Clear** button that, after a confirmation, deletes that kind of that archive through
`stim gc --delete --cache archived-logs:<id>` (`archived-recordings:<id>`, `archived-agent:<id>`) and keeps the record; the row then reads Cleared until the page is left, and None kept after.
The header menu's **Delete Archive** names the archive in a confirmation and permanently removes its
logs, recordings, agent actions and record through `stim gc --delete --cache archived:<id>`. The page
returns to the previous selection once status stops reporting the archive. Machines
shows archive count, total size, per-kind sizes and retention setting names separately;
archives are never selected as safe space to free. The Build card falls back to the archive's
last build summary when `archive.detail` has no history for that platform or is unavailable. Without detail, replay probes the default slots.
Archives never fetch resource stats or build plans, and offer no run, reload, stop or live device controls.

## Workspace page

Apps in the same linked worktree share one detail page and one sidebar row, with
platform badges for each app. Selecting the row opens the page; a link or action
for one app scrolls to its first device or macOS preview. A device deep link
scrolls to that device. The row's context menu has per-app submenus, **Stop All**
and **Remove Worktree**. Single-app worktrees keep the same layout. The shared
canvas puts macOS previews above one ordered grid of all apps' devices. Build cards keep
platform titles, with a small project subtitle only when multiple apps share
that platform. The header uses the most urgent app's stage and shows git and
pull request state once. Its menu keeps each app's actions in a submenu and
offers **Stop All** and one **Remove Worktree** action, with confirmation.

The unified inspector sums CPU and memory, aligns chart samples at the newest
sample, lists every app's processes, and counts the worktree folder once plus
each app's build output. Metro lines show their app labels, ports and log
shortcuts; agent sessions appear once per tool and session id. Build plans,
history, cache stats and warnings stay tied to their apps. The logs drawer adds an **App** picker;
app-specific log shortcuts select that app, and selecting another sidebar row
follows its logs. Changing the log app clears slot and build-run filters. The
toolbar toggle selects the only app with errors when there is one; otherwise
it keeps the current log selection.

A workspace's page starts with one line. The **stage line** says where the
workspace is, with a subtitle: **Running** ("up 42m", turning red with "3
errors" or "iOS app closed"), **Building** ("iOS · started 1m ago"), **Build
failed** (the platform and when), **Warming** (the warm step and how long),
**Ready** ("warmed 48m ago") or **Stopped** (when Metro last stopped). While a
build runs, the line adds its phase ("Compiling"), a short bar and the elapsed
time over the estimate ("1:42 / ~2:40"), so a build can be followed with the
inspector hidden. Next comes the **git chip**, which starts with the branch's pull request
from `worktree.pullRequest` as "PR #N" coloured by its state (open green,
draft grey, merged purple, closed red) with one CI mark: a check when every
check passes, a cross when one fails, a dot while some are pending. Without a
pull request it starts with a branch icon. Commits ahead and behind,
uncommitted files, "merged into main" (left out when the pull request itself
is merged) or "no upstream" follow only when there are some.
Clicking it opens a popover with the branch, its upstream, the pull request's
title, checks and review, and **Open on GitHub**. **Review Changes** opens a
read-only diff sheet. **Changed** lists staged and unstaged files; **New** lists
untracked files. Selecting a file requests only its patches. Lists stop at
200 files and previews at 256 KiB; binary, oversized and unavailable previews
are labeled. Built-in viewing needs Desktop's loopback server to support workspace diffs and allow reads for the
CLI's same Stim home. An older or
unavailable server shows its reason without a CLI fallback.

In **Settings > Integrations > Review changes in**, choose **Built-in** or
**Visual Studio Code**. The latter opens this local repository in the installed
app; use its Source Control view to compare files. It does not export a selected
comparison. A missing app or launch failure shows an error and keeps the choice.
The "..." menu at the end of the line holds the workspace actions.

The inspector, toggled from the toolbar, floats over the workspace in narrow
windows. Its content scrolls behind the glass toolbar controls.
It holds the workspace's details, in this order:

- **Build**: one card per platform. While a build runs, its card shows the
  phase or build tool step with counts, elapsed time over the estimate, a phase
  bar, the remote host, the wait holder, compile output and the cache miss summary.
  Otherwise it separates **Last Build**, with compiler errors, from **Next Build**,
  predicted by the bundled server's next-build read. Plans check automatically while
  visible, reusing a completed build or check for 60 seconds and skipping running
  builds; there is no manual Check button. **Run** starts the app. The next-build prediction keeps **Cache miss details**.
  **Details** opens a build sheet with a platform switch and recent runs.
  In a multi-app worktree, the sheet switches among all apps' iOS, Android and
  macOS entries, adding project names only for repeated platforms; checks, runs,
  history and logs use the selected app. macOS uses the same card layout and Run
  action; its next plan validates packaging settings and reports a SwiftPM Debug
  build without predicting incremental compile work, worker availability or duration. The sheet shows every phase with
  its timing, the wait holder, full cache miss reason,
  changed sources and baseline, remote Mac and offload fallback reason,
  compiler diagnostics, retained output, and the next-build plan. **Open in logs
  panel** opens that run in the existing logs drawer. Click a recent-build row
  to open its run in the sheet, or the header's running-build progress to follow
  the current run. **Recent builds** keeps its disclosure, which animates unless
  Reduce Motion is enabled.
  A computer icon marks an offload fallback; hover over it for the reason.
- **Resources**: CPU (100% is one core) and memory with charts over the last
  10 minutes the app sampled while on screen, every process that counts
  toward the workspace (simulators and emulators, Chrome, Metro, builds) and
  the disk breakdown. CPU and memory sum the workspace's owners in the status
  `machine` section, or the app's own process sample when that section has
  none for the workspace; disk is the worktree plus Stim's build folder from
  `disk`.
- **Metro**: Metro's port with a health dot, the bundle line from `metro.bundle`
  ("Bundling · 62%", "Bundled in 1.8s · 12s ago", "Bundle failed") and
  **Show Logs**, preselected to Metro output.
- **App / native logs**: **Show Logs** opens app runtime and device output.
  All log shortcuts use the same viewer; its filters remain editable.
- **Agents**: the coding-agent sessions associated with the workspace, from
  `agents` and `endedAgents`, earliest started first and without times, so the
  list stays put as processes start and stop.
- **Build cache · project**: the project's hit rate and time saved per
  platform.
- **Warnings**: the workspace's `warnings` from `stim status --json`, when
  there are some.

Below the line, the devices take the rest of the page: every device of the
workspace at once, in the order above, each with its live frame. The frames
fill the available width up to 640 points per card. Each row is centered and
wraps when another full-width card plus spacing would not fit. Screens keep
their aspect ratios, with a 900-point height cap. Each card, including its
header, fits the canvas height; additional rows scroll vertically. Small
preview screens use a 6-point inner inset; the canvas keeps its 20-point
outer padding. A tile is a preview: the device's name and state, its activity, its
CPU, memory and disk (from the machine owner matched by slot and kind, and the
device's `disk`) and its screen, which takes no input. A device whose build is
running shows "Waiting for the iOS build" over its frame with the phase, a
thin bar and the elapsed time over the estimate. One whose app process is gone
shows **App not running**, and one whose platform never built here and last
failed shows **No app installed** over its frame instead. A workspace that is
warming with no device yet shows a warming placeholder. Stopped-device cards use a
compact 420-point maximum width, centered and wrapping with the available space.
Their **Boot** button runs the device's platform and slot through Stim, building,
installing and launching the app if needed. It is disabled while a workspace action
runs; unowned and physical devices have no Boot action. A closed web card offers
**Open** instead. Workspace cards show **Control** for a running controllable device,
or **View** otherwise. Clicking anywhere else on the card opens the device viewer.

Clicking a tile opens the **device viewer**, a sheet as large as the main
window allows, with a minimum of 560 by 480 points. One toolbar names the
device, its model and its workspace, with the driver or idle badge, **App not
running**, **Physical** and the lease, and the device's CPU and memory when
they fit. On its right are **Run** when the app is not running, **Control**
(see [Control a device](#control-a-device)), and **Stop** (a simulator,
emulator or remote session; a web page has Open in browser, Reload and Close;
a physical device has none), then the agent actions toggle and Close. The
device sits on a plain canvas, as large as it fits, with its hardware,
rotation and posture controls grouped below it. The groups wrap when space is
tight, and the replay bar (see [Replay](#replay)) runs across the bottom.

A live local simulator or emulator viewer draws the matching installed hardware
artwork around the screen by default. The screen keeps its aspect ratio and input
coordinates; the frame turns with the display. **Show device frame** in the
sliders button's options popover (Simulator options, or Emulator options on
Android) turns it off and on without taking Control. The choice is kept per device
type in Desktop's preferences. When no frame can be drawn the checkbox is disabled
and says why.

Apple frames come from installed DeviceKit chrome and the simulator's actual
device-type profile. Android frames use the AVD's configured `skin.path`, or its
exact hardware profile's artwork in `/Applications/Android Studio.app`; the skin's
screen dimensions must match the AVD. Missing artwork, unsupported skin layouts,
Android foldables, physical or remote devices, web pages and replay stay frameless.
For a local iPhone Duo, an installed Xcode containing DeviceKit's V68 model (the
selected Xcode first, then any other Xcode in `/Applications`; Xcode 27.0 lacks it,
27.1 has it) and a valid observed hinge angle enable genuine posed hardware around
its live panels. Missing model data retains the frameless view and the options
popover names the missing model. Stim ships no Apple or Android
artwork; mobile asset delivery is not included.

While **Control** is active for an owned local simulator or emulator, the Mac
and the device share their text clipboard unless **Sync clipboard** (on by
default, in the options popover) is off. When the viewer window becomes key, or the
Mac pasteboard changes while it is key, the Mac text is set on the device with
`simctl pbcopy` or the emulator's `setClipboard`; it is not pasted. While the window is key
the device is read every two seconds (`simctl pbpaste`, or `getClipboard`) and its
text replaces the Mac's when it changed; one more read follows when the window stops
being key while it stays visible. Nothing syncs while the window is hidden, minimized or covered. The first
read of a session only records the device's text. Mac items with concealed or transient
marks (`org.nspasteboard.ConcealedType`, `org.nspasteboard.TransientType` and older password
manager types), files or images, and empty or over-256 KB text are not sent to the device. Device text
is written to the Mac marked transient, since its sensitivity is unknown. The popover also has
**Paste Mac Clipboard**, which presses Command-V on an iOS simulator (iOS asks
"Allow Paste" for text from another source) and **Copy Device Clipboard**.
Apps on the device, and agents driving it, can read the text sent to it. Physical
devices, hosted and remote sessions and replay never sync; a hosted device would
receive the text over the tailnet on another Mac.

On the right, 360 points wide, the **agent actions** list what agents did on
the device (`stim logs --source agent`), oldest first, with filter chips (All,
Failed and the two most used commands) and a divider for a pause of more than
5 minutes. The action on screen is highlighted and kept in view: the newest
while live, and while replaying the last one at or before the frame shown, or
the one just stepped or clicked to. An action the replay recorded shows a play
icon. Clicking an action shows its level, command, device and whether the
replay recorded it until another action comes on screen, and a recorded one
plays from 1.5 seconds before it; an action the replay did not record only
shows its details. While the list has
the keyboard, Up and Down move through the actions the same way and Space
plays and pauses. **Open in Logs** closes the viewer and shows the device's
agent actions in the logs, at the selected action or the one on screen. The toolbar button hides
the list, and the app remembers it; a sheet too narrow for the list and a
420-point canvas hides it too. Physical and remote devices have no list.

Escape releases a device that is taken over, and otherwise closes the viewer;
closing it releases the device too. While the viewer is open, the device's
tile stops streaming and says "Open in the viewer". The stream on a workspace card of the Active Workspaces wall or the
Overview is a preview too; clicking it opens its workspace with that device focused. The grid pauses previews after
they leave the scrolling area. Returning to a card reconnects its preview. Active workspaces without
running or building devices show their Metro, build or setup state in the card's media area.

On macOS 26 and later, sidebar controls and device viewer buttons use native
Liquid Glass when built with Xcode 26 or later, and Settings uses grouped native
tabs. Older Xcode builds keep the existing button styles. Older macOS versions
keep their existing button and tab styles.

The logs are hidden by default. The toolbar's logs button, which carries the
error count while they are hidden, or **Show Logs** in the inspector opens
them in a drawer below the devices, resized by dragging its top edge; the app
remembers both. **Open Logs** from a notification or a
workspace menu opens the drawer too.

Live logs use the matching-home local server without a CLI fallback. Ordinary
queries retain the server's bounded tail and default error-source scope. A scoped
build uses the private Desktop full-log subscription and applies its actual build
time, platform and legacy slot bounds to the complete retained backfill. Source
changes, regex filters and interrupted-run bounds remain available. Reconnecting
replaces the backfill so rows do not duplicate. Sample Build reads its offload
timings through `logs.query`.

A linked worktree Stim has not registered yet, listed in `unprovisionedWorktrees`
of `stim status --json`, appears under its project when Not set up is selected.
It is marked "Not set up". The project comes from the entry's `repository`, so
the app does not run git in a worktree that may sit in a macOS-protected folder.
Its page has a header line with a git chip and a worktree actions menu. Run and
Start Dev Server buttons run `stim worktree warm` followed by the selected
command from the app's directory. When the repository has several apps, an App
picker selects which one to set up. The page also shows the folder, repository
and branch, with a Show in Finder link.

Run, Reload App, Start Dev Server and Stop from a workspace or its sidebar menu,
Stop (or Shut down) in the now band, and Build and Run and Stop on a macOS app card run without
opening an activity sheet. Follow progress on the workspace page and open **Last Output**
or **Operations** to inspect the command; pending and failed runs remain there.
The device viewer's Run, Stop (including a remote session's), Reload web and Close web also run without opening
a sheet. Progress and failures appear on a line under the viewer toolbar; **Show Output**
opens the failed run's output, and **Dismiss** hides that failure.
Other actions open an activity sheet. While the command runs, the sheet shows a
spinner and its latest progress line; only the CLI's progress labels (`stim
guide lifecycle progress`) count as progress. When it finishes, the sheet
confirms it in one line and stays open until closed. A failure shows the CLI's
message and remedy. Cleanups run `stim gc --delete --json` or `stim gc --idle
--json`, and the sheet summarizes the payload's `results`: what was freed and
deleted, then what gc left alone and what failed, each with its reason. It
stays open until closed. **Command Output** is collapsed by default and contains
the command and raw output, both while running and after completion. Launch
progress says **Launching app** or **Verifying launch** instead of showing a bundle ID.
Closing the sheet leaves the command running. The sidebar footer's Operations
item (in the toolbar while the sidebar is hidden) shows a spinner and a count
while commands run and a red dot when a finished one failed and was not
opened. Its popover lists the running commands and the last 20 finished ones of
the session, and each row reopens its sheet.
Status follows from the status watch. A finished command triggers a one-shot
`stim status --json` only while the watch is not running, or after a
`stim worktree` command, which can change git worktrees the watch does not
observe. The Machine page,
the toolbar and the disk pressure check share one `stim gc --json` report. It is marked
stale when an action that can change it finishes (a cleanup, a run, start or
stop, a worktree, port, device lease or setting change), and runs again 2
seconds after the last such action unless a run started since. A reload or a
cleanup preview leaves it alone. Each workspace runs one action at a time.

Status stays current through one long-running `stim status --watch --json`,
which prints a payload each time the state changes, and the toolbar shows
`live` while it runs. When the loopback server session is open, allows reads and
serves the same canonical Stim home as the CLI, the app subscribes to the server's
`status.subscribe` feed instead, which carries the payloads of the server's own
`status --watch`. The app ends its own watcher with the feed's first payload, so one
`status --watch` runs per Stim home, and starts it again when the server session
closes, errors or stops reading. At launch the watcher runs until the server delivers. If the watcher exits, the app restarts it after a delay that
doubles from 1 to 30 seconds.

A running build's progress bar carries its resolved cache outcome: "Cache hit"
or "Cold build" / "Cache miss". Historical outcome estimates do not appear as
results. The inspector shows a Hit/Miss badge beside Cache lookup and its
current miss reason, including the recheck after prebuild or pods when needed.
The progress tooltip names how many runs the time estimate comes from. The
workspace inspector's **Build** section shows each
platform's last build from `lastBuilds` (local cache, remote cache, compiled,
or failed, with its duration and age). A compiled build shows why it missed
the cache from `missReason`; clicking it opens a popover with the changed
fingerprint sources. **Recent builds** under it discloses the platform's last
10 runs from status `builds`, newest first: how each ended (local cache,
remote cache, compiled, failed, cancelled or interrupted), its duration, miss reason, age and
slot. Clicking a run shows its configuration, fingerprint, phase times,
compiler errors and miss reason popover. When the section opens, it requests
`desktop.plan.get` from the same-home bundled server for each platform with a last
build or a device, and shows the result on the platform's row: "Next build:
cache hit (local)", "cache hit (remote)" or "cold build, ~5m 40s", or the
refusal with its remedy. A predicted cold build also shows why from the
plan's `missReason`, with the same popover as the last build's. That builds,
boots and installs nothing, but it fingerprints the project, so a workspace
runs one plan at a time, a result
stays for 60 seconds unless that platform's last build changes, closing the
section stops the plan, and nothing is checked while a build runs; the row
shows the running build instead. **Check** runs the plan again, and the row
shows when it was last checked.

Preview reads require private Desktop authority and `desktop-plan` support. Unavailable,
adopted, wrong-home or older servers report an error without a CLI fallback. Closing a
check waits for its connection-scoped cancellation to drain without blocking other controls.
A retained cleanup refusal keeps its code, message and remedy in Notifications even when a
new check replaces the cancelled one or completion races cancellation. Desktop acknowledges
those refusals after receiving them; the server retains at most four unacknowledged plans
per connection and refuses new checks rather than discarding a recovery remedy.
Failed or timed-out requests also drain before returning their original error or retained
cleanup refusal. Shared feeds stay connected, and reconnect never replays a check.

When `stim status` reports a device's `app` as `stopped` (the device is up but
the workspace's app process is gone), its tile shows **App not running**, and
its viewer adds **Run**, which runs `stim ios` or `stim android` (with `--slot <name>` for a
named slot). Run appears only on a Stim-owned simulator or emulator, which that
command targets; a physical device gets no Run. Reload App is disabled when every running local device has a stopped app. An `unknown` app state shows nothing.

A workspace lists its devices like the phone app: running ones first, then
iOS, Android, Web, physical and remote devices, then by slot name. The order
never depends on activity or drivers, so a device keeps its place while an
agent attaches or detaches.

Each device tile shows the `activity` that `stim status` reports: "Driven by
<tool> · 12m" while agent-device, a Stim device lock, or a test runner drives
it (on the wall, where the workspace header names every driver once as "Driven
by <tools> · 12m", a driven tile only says "Driven"), "Idle 3h" when nothing has used it for 10 minutes or more, and "Activity
unknown" when Stim could not read a claim. The app adds one signal the CLI
cannot see: a simulator's screen damage or an emulator's new frame. A screen
that changed in the last 10 minutes clears the idle badge, and an older change
counts toward the idle time. The app sees screen changes only while the tile's
frames are streaming.

Resource usage is measured with `ps` every 3 seconds while the app is active
and its window is on screen: each workspace's
supervisor and Metro process trees plus the `launchd_sim` tree of each of its
simulators (matched by UDID) and the qemu process of each emulator (matched by
AVD name or console port). Memory is the sum of resident sizes, so memory
shared between processes counts more than once. The toolbar shows free space,
without purgeable space and with the same figure as Machine, on the fullest
volume holding the repositories, `$STIM_HOME`, and CoreSimulator, and
what `stim gc --delete` would reclaim; the reclaimable figure needs a Stim
version with `gc --json`.

## Machines

**Machines** has a selector for **This Mac** and its configured remote Macs
(see [Remote Machines](#remote-machines)), with visible choices across the top and
a menu when they do not fit. **Link Machine** opens **Settings >
Remote Machines**. Select **This Mac** for **Now**, where its builds ran and
**Disk on this Mac**; select a remote Mac for its readiness, capacity and
build history. Removing a selected machine returns the page to **This Mac**.
**Now** is what uses the Mac's CPU and memory at this
moment, from the `machine` section of the status watch, which refreshes it
every 15 seconds while something runs. Each row is a booted simulator or
emulator with its workspace (or "Not Stim's"), a workspace's Metro, running
build or `stim web` Chrome, stim-server, or a machine-wide process such as
CoreSimulator services, the adb server or a Gradle daemon. Rows show CPU (100%
is one core) and memory, largest memory first so rows stay in place
as CPU changes; each process counts in one row only. A workspace's owned simulator or emulator has **Shut down**, which
runs `stim stop --slot <slot>`, and its Metro has **Stop**, which runs
`stim stop`. Nothing Stim does not own has an action. Two sparklines above the
list follow the Mac's memory in use and the rows' total CPU, sampled every 3
seconds while the window is visible, so the CPU line steps with the 15-second
refresh. When workspaces are active but `machine` is missing, the band says live
usage is unavailable instead of listing nothing.

Under **Disk on this Mac**, the page shows what uses disk space, largest first,
and what Stim can free. It never blocks on a measurement: the device, runtime
and cache sizes come from `stim gc --json`, and the app sizes only folders
outside `$STIM_HOME` with `du`, each path on its own, three at a time. A path
that takes more than three minutes reads **Unknown**. Sizes are kept for 15
minutes, and **Refresh** measures again. Every size cell shows a size, **None**
when nothing is on disk, an ellipsis while it is measured, **Unknown** when it
could not be sized, or a dash before the first measurement, with the reason in
its help tag.

The processes under **Now**, **Safe to free now**, **Projects**,
**Simulators and Emulators** and **Runtimes and System Images** each have a
header with a disclosure chevron and a count. A collapsed section shows only
its header. An expanded one shows its first 10 rows in their usual order, then
**Show All** or **Show Fewer**. For **Projects** the 10 are repositories; an
expanded repository lists all of its worktrees. An expanded **Safe to free
now** always lists every row, so none of the rows **Free** acts on are hidden.
Free still previews or confirms its commands first, collapsed or not. The app
remembers each section's choices in its own preferences.

- **Headline**: free space on the fullest volume against the Stim disk budget
  (`budget.minFreeDiskGb`), and one bar split into Stim devices (owned by a
  workspace, parked or orphaned), Stim caches and outputs (shared caches,
  workspace build outputs, logs and orphaned workspace directories),
  `node_modules`, other simulators and AVDs, runtimes and system images, and
  other tools. A category that is not fully measured shows its total as a lower
  bound (≥).
- **Safe to free now**: one list, largest first, built from `stim gc --json`:
  parked, orphaned and stale owned devices, orphaned workspace directories,
  records of deleted folders, logs over the cap, build outputs of idle
  workspaces, merged worktrees (sized by their `node_modules`, since their build
  outputs and logs are rows of their own) and non-empty shared caches. A row
  that a refreshed report no longer lists is never acted on. Each row carries a
  checkbox and the command that frees it. Rows marked **stim gc** are one unit,
  `stim gc --delete`, which also removes merged worktrees and clears idle build
  outputs; while it is checked, those rows are checked and locked. With it
  unchecked, a worktree row runs `stim worktree remove <path>` in its
  repository and a build-outputs row runs `stim gc --delete --cache
workspaces`. A cache row runs `stim gc --delete --cache <name or directory>`
  and starts unchecked. **Free** previews a selection that is one gc run (`stim
gc --json`, with its `--cache` scope) in the activity sheet, whose **Delete**
  runs the same scope with `--delete`. A selection of several commands lists
  them in a confirmation first and then runs them in order. When no items are
  selected, **Free space** is muted and a **Select items to free space** hint
  appears above the checklist. Running activities show progress in the current
  step row; the header shows only finished or failed outcomes.
- **Projects**: workspaces and linked worktrees that `stim worktree warm` has
  not set up (**Not warmed**), grouped by repository and ranked by total. A
  repository with several worktrees expands into them. Each worktree shows its
  `node_modules` (sized with `du`), owned devices (from the inventory), and
  build outputs and logs (from `stim gc --json`). A trash icon marks build
  outputs `stim gc --delete` clears; a lock marks ones it keeps, with the
  reason. Scissors mark logs `stim gc --delete` trims to their newest 8 MiB; a
  lock marks logs over the cap it keeps. The lifecycle reads **Merged into
  main** from `stim gc --json`, **PR #n open** from `gh pr list` in the
  repository when the GitHub CLI is signed in, **Stale Nd** after 7 days without
  recorded use, **Active**, **Checkout** for a source checkout, or **Folder
  gone**. A row's menu reveals the worktree in Finder or runs `stim worktree
remove` in it, with what that frees: its `node_modules`, build outputs and
  logs. Its devices are parked or deleted by the pool rules, so they are not
  counted. In a narrow window the category
  columns fold into one line under the name.
- **Simulators and Emulators**: every simulator and AVD from the `inventory`
  of `stim gc --json`, largest first, with its model, runtime or system image,
  last use and owner: **Stim · <workspace>** (with a named slot),
  **Stim · parked**, **Stim · no workspace**, **Another Stim home** for a
  `stim-*` device this home did not create, or **Yours**. Simulator sizes come
  from simctl; AVD sizes from `du -d 1` of the AVD folder (`~/.android/avd`,
  `ANDROID_AVD_HOME` or `ANDROID_USER_HOME/avd`). The app offers no action on a
  device. The CLI's inventory notices,
  such as a listing that timed out, show above the list.
- **Runtimes and System Images**: iOS simulator runtimes with the size simctl
  reports, and Android system images sized with `du` of the SDK's
  `system-images`, each with the number of devices that use it. Unused ones
  come first and are marked. **Copy** copies the `xcrun simctl runtime delete`
  or `sdkmanager --uninstall` command the CLI reports; Stim never runs it.
- **Other tools**: Xcode DerivedData, Gradle caches and `~/Library/Caches`,
  measured with `du` for information, with **Reveal**. A Stim cache inside one
  of them is subtracted and counted under Stim instead.

With a `stim` that reports no inventory, the device and runtime sections say to
update `stim`, each workspace's simulators read a dash, and the headline shows
those categories as unknown.

## Automatic maintenance

Stim's CLI cleans up on its own (`maintenance.mode`, on by default), on every
Mac, whether this app runs or not: stim commands, dev server supervisors and
this app's status watch start its passes. It shuts down owned simulators and
emulators idle for `devices.idleShutdownMinutes`, never deleting them, and once
a day clears the build outputs of workspaces and the cache entries unused for
`maintenance.olderThanDays` and deletes devices parked that long. It removes
the worktrees of merged or closed pull requests, and reclaims more space when
free disk falls under `budget.minFreeDiskGb`. Run `stim guide cleanup` for the
rules.

The **Automatic Maintenance** section of the App preferences shows the mode
and the last pass (when, actions and bytes freed, and why it was blocked) from
`stim status --json`, read only. **Clean up what is unused for** sets
`maintenance.olderThanDays` (7 days by default; Never is 0) and **Shut down
idle devices after** sets `devices.idleShutdownMinutes` (30 minutes by
default; Never is 0), and **Also remove clean, pushed worktrees unused that
long** sets `maintenance.removeIdleWorktrees` (off by default; it removes
unmerged linked worktrees no Stim command used that long, git-ignored files
included, and only while `maintenance.removeFinishedWorktrees` is on and the
age is not Never), all with `stim settings set ... --scope machine`. Every
other `maintenance.*` setting is under **Stim Settings**. A `stim` whose status
has no `maintenance` block cleans up nothing on its own; the section then says
to update `stim`, and the app does not clean up in its place. Idle device
shutdown without a dev server, the daily cleanup of parked devices,
**Never** for the cleanup age and the worktree switch need a `stim` newer than
1.25.0; with an older one the switch is disabled with an update note, and
`on` mode does the rest. A project's own `devices.idleShutdownMinutes`
overrides the machine value the picker writes. **Cleanup
History** (below) lists what each cleanup removed.

While free disk is under the budget, the Machine page shows the plan, such as
"Clear the build outputs of 3 idle workspaces and remove 1 merged worktree to
free about 300 MB", with a **Do it** button that runs `stim gc --delete`, and
the sidebar marks Machine. When the CLI's maintenance is not on, or its last
pass was blocked while disk is still under the budget, the app posts the plan
once per episode as a notification with **Do it**. **Do it** in a notification
runs only while disk is still under the budget, and otherwise opens Machine;
the app removes its delivered pressure notifications once free disk is back
above the budget. The **Free disk falls under the Stim budget** notification
is on by default and needs the bundled app.

## Cleanup History

The **Cleanup History** section of the App preferences lists every run that deleted or changed
something, newest first: `stim gc`, Stim's automatic maintenance and the budget check before a
build, whoever started them (this app, an agent or a terminal). It runs
`stim logs --source gc --json` from the home directory every 30 seconds while the App tab is showing
and never reads `$STIM_HOME`. A row shows what started the run, when, how many items it cleared,
kept and failed, and the bytes freed; expanding it lists each item with its path and the reason a
kept or failed item was left. A **Do it** from the bundled app appears as Cleanup from Stim
Desktop, and from an unbundled development build as Cleanup from stim gc. With a `stim` that has
no gc log (1.25.0 or older), the section says to update `stim`.

## Builds

The **Builds** item in the sidebar (Command-5) lists the native builds Stim recorded on this Mac, newest
first and grouped by day. It runs `stim logs --source builds --json` from the home directory every 30
seconds while the page is showing and never reads `$STIM_HOME`. A row shows the project and platform, the
branch and target, where the build ran (this Mac, a build machine, or this Mac after an offload fell
back), the cache result, the duration and the outcome. The filters choose a project, a platform, a
machine (**This Mac** or a build machine) and an outcome. Clicking a row opens its phases as bars, the
failure code, message and remedy of a failed build, and the device, cache key and fingerprint. The model
is `BuildLedger` in `StimKit` (parsing, filters, day groups and the phase timeline), which the tests in
`BuildLedgerTests` cover. With a `stim` that has no build ledger (1.25.0 or older), the page says to
update `stim`.

## Logs

A workspace's page shows its logs beside the devices, or on a **Logs** tab when
the page is narrow. The Logs card and the error count on the device wall open
them, with **Errors only** on when there are errors.
The tab runs `stim logs --json --follow --tail 5000` in the workspace and adds
the filters you pick: the Metro, App (`client`), Native (`device`), Build and
Agent (`agent`, what agent-device did on the workspace's devices) sources, a
slot, a minimum level, a regular expression search (`--grep`), and `--errors`.
With every source selected no `--source` is passed, so **Errors only** keeps
the CLI's default scope, which leaves general device logs and agent actions
out.
Changing a filter or the workspace restarts the command; hiding the logs or
quitting the app terminates it.

**Build output > Readable** formats Xcode output with xcbeautify and hides
compiler invocation noise. **Raw** shows every original line. Diagnostic
source and caret lines remain visible; record details and copying always use
the original output. Changing this display mode does not restart the log command.

The generic list keeps the newest 50,000 records and drops the oldest past that.
**Build Logs** omits the tail limit and keeps all retained records of the selected
run, including raw compiler commands. Its **Build run** chip clears the run's
platform/time scope; the generic tail and viewer cap then apply again. An older
CLI's records without slot or platform tags stay visible; concurrent legacy runs
can overlap because those tags cannot identify them. A known finish closes the
run; an interrupted run stops before the next recorded run in its own slot.
Without either boundary its time scope remains open. It
follows new records until you scroll up, and **Jump to Latest** resumes. Each
row shows a record's first line; select one to read its whole message and
stack. Command-C or **Copy** copies the selected records, or every loaded
record when none is selected. **Reveal Log Folder** opens the workspace's log
directory from `stim status`.

Native workspace details show the same agent actions panel below the app preview.
Use `agent-device open <isolated-bundleId> --platform macos --surface app --foreground`
with the bundle ID from Stim status. The feed matches the current launch and
recorded app-surface opens; unrecorded lifecycle attempts, app switches and event
log rotation clear attribution. Native screenshots, phone Control and generic
computer-use tools are outside this feed. Native apps have no replay.
agent-device must record the explicit surface in its open event; version
0.21.12 omits it, so its native actions remain unavailable.

The viewer's agent actions are the agent-device actions on that simulator or
emulator: taps, typing, app opens, screenshots, and failed commands in red. On
the Web device they are the clicks, typing and scrolls an attached tool such as
Playwright sent to the page. The viewer runs
`stim logs --json --follow --tail 200 --source agent --slot <slot>` in the
workspace and keeps the records whose `deviceId` is the device's UDID or
serial, or the page's DevTools target, up to 200; closing the viewer
terminates the command. An action sits on the replay where it started, at the
record's `startedAt` when agent-device reported one, like its marker.
**Open in Logs** switches the Logs tab to the Agent source of the device's
slot, clears the level, search and **Errors only** filters, and scrolls to and
selects that action's record.

## Build progress

While `stim ios` or `stim android` runs in a workspace, its header on the wall
shows a progress bar with the build phase, the elapsed time against the median
of that project's comparable runs, and "about N min left". On the workspace
page, the header line shows the phase, a short bar and the elapsed time over
that estimate, the device it targets shows the same over its screen, and the
inspector's **Build** section shows the phase checklist. With no finished run
to compare against, the bars are indeterminate. The figures come from the `build` field of `stim status --json`,
which needs a Stim version that reports it.

## Control a device

Workspace previews are view-only. Opening a running controllable device starts the
viewer with **Control** on. Physical iOS devices and remote previews remain view-only;
an Android phone also needs a valid lease and a control-capable server pairing.
Only the device open in the viewer is controlled, and closing the viewer releases it.
**Release Control** (or Escape) returns to viewing; **Control** turns it on again.
While it is on, the app sends that device your clicks and drags as touches,
trackpad scrolls as one-finger drags, and your keys. Turn it off before an agent
drives the device again. Command-key shortcuts stay with the app's menus, and a
mouse wheel without precise deltas does not scroll.

Local iOS input connects in the background. The screen shows **Connecting input**
or **Input unavailable** and drops clicks and keys until the connection is ready.
A lookup times out after 10 seconds without blocking Desktop. CoreSimulator
cannot cancel that lookup, so Desktop waits for it to return before trying again,
including when the viewer is reopened. Rotation, hinge input and development
controls share this per-device lookup guard. Input reconnects after a disconnect.
Legacy input stays usable while Desktop retries the CoreDevice service in the
background. Cancelling a development request stops waiting immediately; its
lookup guard remains held until CoreSimulator returns.

The viewer's scale menu defaults to **Fit**. **Point Accurate** shows one iOS
point or Android profile dp per Mac point; **Pixel Accurate** shows one guest
pixel per display backing pixel. **Physical Size** uses the installed iOS
device DPI and the current monitor's reported physical width. It is unavailable
when either measurement is missing, and on Android, whose dp density is not a
physical measurement. Monitor-reported dimensions can be approximate.
Accurate modes retain their size when the viewer is small: scroll outside the
screen, or release Control to scroll over it, and select **Fit** to return.
The scale follows display and backing-scale changes when moving between monitors.
Hardware frames retain the same screen scale through rotation. Android accurate
modes request native-resolution images; Fit and wall previews retain their 960-pixel limit.
Duo's projected housing and folded screen, replay, physical devices, web and
remote previews retain **Fit**.

While controlling a local iPhone simulator, drag up from the bottom edge and
release to go Home, or pause before releasing to open the app switcher. iOS
handles the gesture timing, including when the simulator is rotated.

While controlling a local iOS simulator or Android emulator, hold **Option** and
drag to pinch or rotate two fingers around their center. Hold **Option-Shift**
to move both fingers together. Trackpad pinch also sends a two-finger pinch.
Two markers show the contact positions, including on a framed or folded screen.
Releasing Option, ending the gesture, changing orientation or releasing Control
lifts both contacts. Option and the gesture's Shift modifier stay on the Mac.
These gestures are not available for physical devices, remote previews or web pages.

While **Control** is on, groups below the screen of a running simulator or emulator have its
hardware buttons and rotation: **Home** and **Lock** on a simulator, sent
through the simulator's HID service; **Home**, **Back**, **Apps** and **Lock**
on an emulator, sent with gRPC `sendKey` (Lock, and every button on an emulator
without a hardware keyboard, with `adb shell input keyevent`); then **Rotate
left** and **Rotate right**. An iPhone Duo rotates through its Virtualization
provider in each posture. Apps keep their supported orientations, and its home
screen stays portrait. Hardware buttons, rotation and posture controls are
available only while **Control** is on.

**Simulator Options** below the screen reads the selected iOS simulator's
appearance, text size and accessibility settings from Xcode. Change light/dark,
text size, Larger accessibility sizes, Increase contrast, Reduce motion,
Reduce transparency or Show button borders. Each change reads the device back;
**Refresh** picks up changes made elsewhere. Unsupported fields read
**Unavailable**. The panel is available only on a running local simulator while
**Control** is on, outside replay; it closes when control is released. Without Control the popover shows only **Show device frame**. These are
the simulator's settings, not Desktop preferences. This requires an Xcode whose
`devicectl device info|settings appearance` supports that simulator. Audio,
VoiceOver, color filters and Liquid Glass controls are not included.

The options popover's **Tools** section runs `stim device location|permission|push|network`
through the CLI for the workspace's own local simulator or emulator, only while **Control** is on
and outside replay. **Location** sets `latitude, longitude` (or a preset place) and, on iOS, clears
it. **Permission** grants, revokes or resets one service for the workspace's app. **Test push**
sends a title and message to the iOS app. **Network** turns an Android emulator's Wi-Fi and mobile
data off or on. The line under the buttons shows what the CLI printed: Android permissions and
network read the state back from the device, and iOS location, permissions and push report only
that the command succeeded. A hosted, remote, EAS or physical device has no Tools section, and a CLI
refusal shows its message there. Desktop never calls `simctl` or `adb` for these.

The panel's **Development** section offers **Slow animations** and **Shake**
on supported iOS simulators. Slow animations changes UIKit's animation speed
in the guest, leaving Desktop's live stream and input speed unchanged. Its
switch reads the simulator's current state, confirms each change by reading it
back, and has its own refresh button. Shake sends the simulator's shake event;
the foreground app decides how to handle it. These controls share the panel's
Control and replay gates. They do not change Android animation settings.

The iPhone Duo frame fits the display its posture lights, and touches go to
that display. Until the active display is known, both displays appear side by
side. **Folded**, **Half open** and **Unfolded** below the screen move the simulated hinge to 0,
120 or 180 degrees, as the posture buttons in Xcode's Device Hub do. Selecting
the current preset does nothing. **Hinge Angle** opens a slider for any angle
from 0 to 180 degrees; releasing it applies the selected angle. The controls sweep
the angle through the simulator's vendor-defined HID service
(`com.apple.coredevice.feature.remote.hid.vendordefined`), which iOS needs to
swap panels; the path is adapted from
[Siniulator](https://github.com/kmagiera/Siniulator) under its MIT licence.
While its viewer is open, Desktop observes the Duo hinge through
`devicectl device motion hinge-angle`, so preset selection follows changes
made by another controller. Arbitrary angles leave all presets unselected.
With the device frame on and the installed V68 model available, the housing
follows the observed hinge angle and display rotation. Touches and drags hit the
posed active screen and map back to its pixels; the surrounding housing has no
input. Desktop keeps both panel surfaces ready and snapshots the departing panel
before its own posture controls change the hinge. External controllers can clear
the departing panel before Desktop can snapshot it, so their handoff can leave
that panel blank or retain an older snapshot.

With the device frame off, a valid observed angle below 180 degrees projects
the active inner display's two halves around the hinge. The cover, unknown angle
and fully open display stay flat. Touches and drags map back to the display
pixels.
Tools or devices without hinge observation retain the last requested posture.
The observer consumes valid samples twice a second at most, uses one bounded
process, and stops it when the viewer closes. Its parser depends on the human
output of devicectl 651.13.4; unfamiliar output keeps the existing behavior. On a
CoreSimulator without that service the controls show **Fold / Unfold** instead,
which runs the bundled `sim-fold` helper inside the simulator with `xcrun
simctl spawn` to toggle SpringBoard's private display tool service; it appears
only in the bundled app, and an iOS release can break it.

An Android emulator with a hinge, such as one Stim created with
`--device-profile pixel_fold`, shows its posture as a chip: **Folded**,
**Half open** or **Unfolded**, read from the emulator's gRPC POSTURE physical
model. The **Posture** menu below the screen moves the hinge with the
gRPC `setPosture` call. Folded, the emulator streams only the outer display,
so the viewer takes that display's shape and touches address its pixels.

Android input goes through the emulator's gRPC `sendMouse` and `sendKey` calls.
Printable ASCII is sent as text; other keys, such as Delete, Return, Tab and the
arrows, are sent as key presses. Control shortcuts are not sent, and an
emulator without a gRPC endpoint cannot be taken over.

## Web

A workspace where `stim web` runs shows its Stim-owned Chrome as a **Web** tile
on the wall and on the workspace page, labelled with the page's URL,
the in-app route (`web.page.route`) when one moved it after the load.
Desktop reads the page's frames itself, over the loopback DevTools endpoint
`stim status --json` reports, and connects only when Chrome reports the pid
status names. **Control** sends clicks, drags, hover, trackpad scrolls and
keys to the page; Command shortcuts stay with the Mac. The viewer's buttons open
the URL in your default browser (never the Stim profile), run `stim reload web`,
and **Close** runs `stim stop --slot web`, which keeps Metro, the devices and the
profile. A failed page load shows a "Page failed to load" pill and an
item that reruns `stim web`, and a tool attached to the DevTools
endpoint, such as Playwright MCP, shows as the driver.

## Replay

While Desktop's stim-server runs (see [stim-server](#stim-server)),
each simulator, emulator and web page's device viewer offers a replay bar
once the server has recorded it,
like the phone app's device viewer. Stim Desktop connects to that server over
its Unix socket with a WebSocket that carries the protocol's JSON in the clear.
The socket is normally `server/local.sock` under the Stim home `/health` reports.
Paths longer than macOS's 103-byte limit use
`/tmp/stim-sockets-<uid>/<sha256-of-normalized-socket-path>.sock` instead. The socket is mode
0600 in a 0700 directory, so only your user can connect, and the server gives
that connection every local capability without pairing or a token. The app names
itself "Stim Desktop", or "Stim Dev" for a Stim Dev build (see
[Build the app](#build-the-app)), and is not listed in `stim-server devices`. A
stim-server older than protocol 2 has no socket; the app does not connect to it
and says to update it.

The app polls `replay.range` every 10 seconds while the viewer shows. The bar has
**Live**, play and pause, a 1x or 2x speed, and a track of the recorded spans
with each unrecorded gap at a fixed width. Agent actions, errors and crashes
are markers; hovering one shows its time, command and log line, and clicking
near one lands 1.5 seconds before it. The buttons on each side of play step to the previous or
next agent action, landing the same way; errors are skipped, and next with no
later action goes live while the device runs. They are disabled while live and
when no action lies that way. Hovering the track also shows a still
frame above the time: the keyframe that starts the recorded segment of about
5 seconds there, from `replay.keyframe`, so the preview can be up to about 5
seconds early. The app decodes it on its own queue, apart from playback, keeps
the last 200 segments' frames, and also fetches the two segments on each side
of the one hovered; hovering never seeks. The frame's box appears once the
first keyframe arrives, sized to it, so a server without `replay.keyframe`
shows the time alone. A keyframe that fails to decode is not asked for again. Dragging shows the frame under the
pointer. The first seek opens a `frames.subscribe` with `video: ["h264"]` and
`at`, which also works for a device that is not running; later seeks send
`frames.seek`. The app decodes the H.264 itself. A server that answers without
H.264 cannot replay, and the bar says so. **Live** closes the subscription and
shows the device's own live screen again. Control is disabled while
replaying, and a seek releases it. After a lost connection the replay resumes,
paused at the frame shown.

The bar shows **Recording** while the server records the device, and **Replay
off** when `stim status --json` reports `recording.enabled` false for the
workspace. Physical and remote devices have no replay. **Record device screens
for replay** in **Stim > Settings > Advanced** changes the machine's
`recording.enabled` through the bundled server; turning it off asks first,
because it deletes the recordings.

## Remote sessions

A workspace with a recorded EAS Simulator session from `stim ios --remote eas`
or `stim android --remote eas` shows a tile with a blue ring. The tile loads the
session's `webPreviewUrl` from `stim status --json` in a web view and marks the
session as billable. Its **Stop** button, in the viewer, runs `stim stop` in the workspace after a confirmation, which ends the
session -- a remote session has no per-slot teardown, so its Stop always
targets the whole workspace, unlike a local device's `stim stop --slot <name>`.
A session with no recorded preview URL shows a message instead of the page.

## Physical devices

A physical iPhone, iPad or Android phone the workspace leases with
`stim ios --device`, `stim android --device` or `stim device lock` shows as its
own tile, from the environment's `physicalDevices` in `stim status --json`, next
to any simulator or emulator in the same slot. The tile names the device and
its model, carries a **Physical** pill and "Leased · 42m left", and counts
as running while the Mac reaches the device. It has no Stop and no rotate
buttons. A lease alone puts the workspace under Live.

The tile streams the device's screen from the local stim-server (see
[Replay](#replay) for the connection) with `frames.subscribe`, `physical:
true` and `video: ["h264"]`, as the phone app does, and decodes the H.264
itself. An iPhone streams only over a USB cable and is view only. An Android
phone streams over adb, and **Control** in the viewer sends clicks and drags as touches,
trackpad scrolls as one-finger drags, and typed ASCII, Return, Tab and Delete
as text, through a `control.begin` session with `physical: true`. While taken
over, the viewer shows Home, Back, Apps and Lock buttons. The server accepts
control only from the workspace that holds the lease, and never takes or
renews a lease itself.

Instead of a screen, the tile says:

- **Connecting to stim-server** while it starts, or why the server is
  unreachable.
- **The stim-server on this port is older than Stim Desktop** when the server's
  hello lacks `physical-ios` or `physical-android` for the device: Desktop adopted
  a server it did not start. Updating or stopping that server lets Desktop start its own.
- **Disconnected** when `stim status` reads the device as disconnected.
- **The workspace's lease on this device ended**, with the `--device` command
  that leases it again, once the lease's end time passes, before `stim status`
  drops the tile.

A delayed stream shows the server's reason, such as a locked iPhone. When the
server ends control (no input for 5 minutes, the device gone, the lease
ended), Control turns off and the tile says why.

## stim-server

Desktop runs a local `stim-server` while it is open; there is no switch. The app
bundles it: `Contents/Resources/stim-server` holds a pinned official Node.js LTS
(universal, `strip -x`, signed with the hardened runtime) and `@stim-cli/server` with the `stim`
packages it runs, so the server always matches the app and needs no global install,
Node version manager or login shell to start. A Mac that serves without Desktop, such
as a build worker, still installs `@stim-cli/server` from npm. Replay, the diff viewer, archived logs, hosted app and simulator
views and device recordings all read from it. At launch the app checks
`http://127.0.0.1:7787/health`. When a server answers, the app uses it if
Desktop uses the default home or the server serves Desktop's resolved
home; otherwise it names both homes and asks you to stop that server or launch
Desktop with `-stimServerPort <port>`. A server the app did not start, such as the
`stim-server service` LaunchAgent on a Mac that hosts for others, is never stopped
or reconfigured and keeps running after the app quits. If no server answers, the app runs
`stim-server --port 7787 --loopback-only`, which listens on `127.0.0.1` and never on
a Tailscale address, and stops it with SIGTERM when the app quits, followed by SIGKILL
if it has not exited after 3 seconds. A
killed server leaves its `stim status --watch` child running until that child's
next write fails. A stim-server older than the `--loopback-only` flag exits at once,
and the sidebar footer shows a warning icon that says to update it. A failure of any
other kind, such as a port held by another program or a server for another Stim home,
shows the same icon with the reason in its tooltip; click it to retry now. Desktop also retries a failed start every 30 seconds or more, except for an outdated server. No dialog
interrupts. `--loopback-only` removes the server's own Tailscale listeners and makes it refuse any
request that a `tailscale serve --https` route forwards to the port, so paired phones and other
Macs cannot reach it; Desktop never removes or edits the route. Turning the Phone app flag off, or **Serve to phones** off, restarts the
server Desktop started in loopback-only mode, which disconnects paired phones until
they are served again. The bundled server runs unless you choose another `stim-server` in
**Settings > Advanced**, such as a checkout's build; a build without the bundle, such as a
`stim macos` copy or `swift run`, finds `stim-server` on the login shell's `PATH`. When
no server answers, Desktop starts the bundled server at once with the launch environment,
the Stim home and the environment overrides from **Settings > Advanced > Environment**
(see [Environment](#environment)); the server discovers the toolchain for the commands it
runs itself. The bundled server keeps V8's compile cache for its own
scripts in `~/Library/Caches/<bundle id>/node-compile-cache`; it removes
`NODE_COMPILE_CACHE` from its environment before it starts anything, so commands it
runs, such as Metro or Gradle, never write there. A test copy can move the port from 7787 with
`defaults write <bundle id> stimServerPort -int <port>`, so it never adopts
the Mac's own server. While a server runs, the Phones tab re-checks it every 5
seconds and the app every 10 seconds while it is active, otherwise every 60
seconds. When a server the app did not start misses two checks in a row, the app starts its
own. With the Phone app on and **Serve to phones** on, Desktop starts its server without
`--loopback-only`, so it also listens on this Mac's Tailscale addresses, and restarts the
server it started when the setting or the flag changes. The pairing and device commands use the
`STIM_HOME` its health reports, so they act on that server's pairing state. When that `STIM_HOME` is
not `~/.stim`, the tab names it and warns that phones paired now are stored
there. This warning appears when Desktop uses the default home and
has adopted a server started with another home. Those phones stop working once Stim Desktop
serves `~/.stim` again.

A stim-server that already answers on the port with a matching Stim home, such as
the LaunchAgent that `stim-server setup` or `stim-server service install` creates, is
adopted as not started by the app, whatever **Serve to phones** says, so build and
device-host requests from other Macs reach the Allow / Deny dialog. If Desktop's own
server fails and a LaunchAgent server comes up, the next retry (every 30 seconds or
more) adopts it. A server with another Stim home is not adopted: the sidebar footer
shows the mismatch and Desktop keeps retrying. Before its environment is ready, Desktop
adopts a ready server provisionally when the Stim home it runs with would adopt it, so the
sidebar shows its status feed right away. A provisional adoption only reads: Desktop
connects with a stored token, and does not pair, grant, save or delete a token, run
`stim-server` commands or send control requests. Once the environment is ready, Desktop
checks the server again and keeps it only when it still serves the same home and version;
otherwise it drops the server and looks for one again. Turning **Serve to phones** off restarts a
server the app started in loopback-only mode and never touches one it did not start;
turning it on after a failed start tries again.

A server answering health with HTTP 503 appears as **Starting** or
**Degraded** with its reason in the Phones page (or **Settings > Advanced** with the Phone app off); the footer icon shows only Degraded. Desktop keeps
checking it without starting another server or terminating one it launched.
For a server it launches, Desktop checks every 250 milliseconds until it is
ready or the 15-second startup deadline passes, then uses its regular poller.
The server retries reading its Stim home every 30 seconds. Desktop applies the
usual home checks to an external server whenever health reports its Stim home,
including while it is not ready. Until health is ready, Desktop does not connect
a session, issue pairing codes or run route setup, and its poller does not list paired
devices, because that read of the Stim home can hang while it is degraded.
Listing, approving and revoking paired devices work as before while the server is
off, failed or running.

A read-only phone sees workspaces, devices and logs. With workspace diff support,
it can also read changed and untracked text files in registered workspaces,
including non-ignored `.env` files. A phone allowed to control
can also drive simulators and emulators and run reload and stop.
An iPhone that turns on notifications gets push notifications from the server
while **Serve to phones** is on, even when the app on the phone is closed; see
[Push notifications](../../packages/server/README.md#push-notifications).

**Pair a Phone...** opens a five-step wizard: get the apps, connect Tailscale,
turn on serving, scan a code, and see the paired phone. It is also available
from the first-run guide's **Pair Your Phone** step. The wizard turns on serving
and sets up a tailnet-only route through the authenticated loopback `route.setup`
request; it never enables Funnel. Tailscale and server checks update automatically.
Cancelling before pairing turns serving back off only if the wizard turned it on.

The installation step shows branded QR codes and App Store actions for Stim Mobile
and Tailscale. Stim Mobile's destination uses its reserved Apple app ID; the public
listing is not available yet.

Codes come from `stim-server pair --json`, with `--control` for **View and
control** (the default). Each single-use code expires after five minutes; the
wizard replaces expired codes automatically up to three times, then offers
**Show a New Code**. Changing access generates a new code; the previous code
stays valid until it expires. **Can't Scan? Enter the Endpoint and Token** shows
copyable **Endpoint** and **Token** fields, with the token hidden until revealed. The wizard
waits for the phone and shows its name and access on the success screen.

The Phones tab lists paired phones from `stim-server devices --json`: each
phone's name, when it was last seen and a **View Only** or **Can control**
badge. Its menu has **Allow Control** or **View Only**, which runs
`stim-server devices grant <id> --control` or `--read`, and **Revoke...**,
which runs `stim-server devices revoke <id>` after a confirmation. With no
phone paired, the tab shows an empty state with **Pair a Phone...**. A
problem that stops phones from connecting shows as one line above the list:
serving off (**Turn On**), or Tailscale off, a missing route or a Funneled
route (**Fix...**, which opens the wizard at its Tailscale step). Below the
list, the **Server** section holds **Serve to phones** and the server's version
and port. With the Phone app flag off there is no Phones tab. **Settings >
Advanced** holds **Record device screens for replay** and a **stim-server**
section with the server's status, **Try Again** after a failure and the
executable override.

Macs that build or host devices here are listed on the Remote Machines tab, see
[Macs using this Mac](#macs-using-this-mac).

When Tailscale runs, the wizard's **Turn On Serving** step (or **Set up
connection**) configures and verifies a dedicated
tailnet-only HTTPS proxy to the server's loopback port. It uses port 7443 or the
next free port, keeps an existing route unchanged and never enables Funnel. This
action uses Desktop's authenticated local control connection; a phone or
forwarded connection cannot configure the Mac. Tailscale may ask you to enable
HTTPS in your browser; the error links to it and offers **Try Again**. An
unreadable or timed-out route probe changes nothing. A route exposing this server
through Funnel refuses setup and pairing. The wizard verifies the connection
before showing its QR code.

## Remote Machines

**Add Remote Machine...** in **Settings > Remote Machines** opens the five-step
setup wizard. Each step has an illustration in the first-run guide's style. The
wizard refreshes in the background and has no Check again button: tailnet peers
every 5 seconds on step 1, existing approvals every 10 seconds on step 2, the
setup journal every second and doctor every 5 seconds on step 3, and tools every
10 seconds on step 4. `SetupWizard.refreshes(page:)` and
`SetupRefreshClock` decide what is due.

1. **Pick a Machine.** The Tailscale check comes first. `Tailnet.Install` tells the
   Tailscale app (`/Applications/Tailscale.app`) from a CLI-only install. Its
   `status` fails while the app is quit, so an installed app with no answer is
   off, not missing.
   - App off: art of the menu bar switch turning on.
   - CLI only: `tailscale up`.
   - Not installed: a **Download Tailscale** button.
   - Running: the macOS, Linux and Windows peers, each marked **Reachable** or
     **Offline**, a Linux or Windows one also **Linux · Android builds only** or
     **Windows · Android builds only**. Other peers are left out. It does not show stim-server state, which setup
     installs later. With no such peer, the step links to the Tailscale
     downloads for a Mac, for Linux and for Windows.
     A peer already in `remote.machines` (`OffloadMachines.added`) is marked
     **Added** and shows the pill the Remote Machines list shows for it
     (`BuildMachineStatus.listStatus`, with the doctor diagnosis text when it is
     not healthy), not Tailscale's `Online` flag, which can read false while the
     machine answers. It is not a setup target: choosing it only says it is
     already added and offers **Show in Remote Machines**. Next and the
     offline-only hint consider the other peers.
2. **What it does.** Builds and Hosted simulators checkboxes and the animated
   preview of what setup will do. Both can be off. Then Next is disabled and
   the preview holds only `$ stim-server setup` and a cursor. A Linux or Windows machine
   gets Builds only (Android Debug builds); Hosted simulators is disabled with
   its reason, and the preview names a systemd user service (Linux) or a
   scheduled task (Windows) and no Stim Host.
3. **Set it up.**
   - While nothing has reached the journal yet, the art shows this Mac and the
     remote machine linked by a travelling dot (still under Reduce Motion).
   - The copyable command, which needs Node 22.12+ on the remote machine. Run it in
     Terminal while signed in there; answering each Y/n request approves
     access. Permission prompts appear on that Mac's screen. There is no SSH
     option. For a Linux machine the command starts with
     `sudo tailscale set --operator=$USER` and `sudo loginctl enable-linger $USER`,
     which `tailscale serve` and the systemd user service need, and it also
     needs JDK 17 and the Android SDK there. For a Windows machine it is a
     PowerShell command (`npx.cmd`, so the script execution policy does not
     matter; a backtick continues each line, and the package is quoted) that
     needs no administrator rights and installs a scheduled task.
   - A live mirror in the preview's wording: no node or request ids, and no
     tool details or JSON. It shows skipped and failed steps as recorded.
   - Needs no Next press. Once the remote machine's journal shows the command
     started, Desktop sends this Mac's build and hosted-simulator requests with
     the ticket and keeps reading `stim doctor` every 5 seconds, one read at a
     time. When the journal says the remote machine
     approved and waits for this Mac, Desktop sends the request at once and the
     status line reads "<machine> approved this Mac. Stim is connecting to it". The
     reads only deliver the ticket; approval stays the Y/n on the remote
     machine. After the ticket expires Desktop stops asking, says so, and
     offers New Command; the read continues for 30 more seconds so an
     approval recorded just before expiry still shows.
   - When setup finishes with no failed step and every chosen capability is
     approved, the wizard moves to Tools by itself ("Approved. Waiting for
     <machine> to finish setup..." shows until the journal is done). A skipped
     permission or a failed step keeps this step and its Next button, so the
     warning and its fix are read first. The success view lists the approvals
     and the current Screen recording and Device control permissions (with the
     fix for a skipped one); it has no log. The expiry line shows only until the
     command starts.
4. **Tools.** The remote machine's tools compared with this Mac, from doctor and
   the setup journal. Read-only checks use fresh, platform-filtered reports from
   a matching-home local server advertising `desktop-report-platform`; an older or
   unavailable server is reported without a CLI fallback. Cancelling a check leaves
   the shared connection open; reports retain the server's execution and cleanup
   budget of up to 150 seconds. When Builds is chosen, Android tools are always compared
   and are amber. Next is never disabled by a tool row: approval is finished, a
   failed offload falls back to a local build, and the machine stays added.
   A machine's page in Settings > Remote Machines shows every problem and note,
   including the Android ones, grouped by platform.
   A problem that stops the chosen capability is red: a Stim build mismatch, no Xcode, a different CPU or an
   unreachable or unapproved Mac for Builds, and no iOS simulator runtime for
   Hosted simulators when doctor reports it. With only Hosted simulators, setup
   records no tool checks, so rows without data read "Checked when a hosted
   simulator starts". **Install This Mac's Build** updates a mismatched Stim build
   through the existing machine update action. Every other problem is an amber
   warning that names its cost, such as a different Xcode or runtime, missing
   Android tools or a different global CocoaPods. Doctor compares the global
   `pod --version` only for projects whose `Gemfile.lock` does not pin
   CocoaPods. The CocoaPods row offers `bundle add cocoapods --version <here>`
   with `bundle install`, or `gem install cocoapods -v <here>` on the remote
   machine. Shell commands have Copy buttons; prose fixes appear as text. Desktop
   never runs these fixes. A Linux or Windows machine is compared with
   `stim doctor --platform android` only: it shows the Stim build and Android
   rows, and a missing Android SDK or any JDK difference is red, since no
   build could offload there.
5. **Done.**
   - The approvals.
   - A **Try it** card with a copyable agent prompt and
     `stim ios --remote-build <machine>`, or `stim android` for a Linux or Windows machine.
   - **Builds**: Auto / Remote first / This Mac for `remote.build` (`auto`,
     `remote` or `local`). It defaults to Auto when the wizard added the first
     remote Mac, and otherwise keeps the current choice. A current value the
     wizard does not offer, such as `remote-only` or one Mac's name, selects
     nothing and Done keeps it unless you choose. The caption under the choice
     says where builds run.
   - **Simulators**, shown when Hosted simulators was chosen: This Mac / Auto /
     Always on the Mac. Done writes `ios.remote` and `android.remote` at machine
     scope (unset, `auto`, or the `remote.machines` entry with its port), and
     only the keys whose value changes. When the two keys differ or hold a
     value the wizard does not offer, such as `eas`, no choice is selected and
     Done keeps them unless you choose one.
   - A pointer to **Remove** for undo.

**Run a Test Build with a Sample App** on the last step still runs the
optional sample test. Desktop prepares a pinned Expo blank SDK 58 app in
`~/Library/Application Support/Stim Desktop/Onboarding/sample-sdk58/`, outside
user projects and Stim's state directory. It also uses this checkout for setup
requests when no workspace is listed. In that case preparation starts when a Mac
is picked, and Next waits for the sample and checks existing approvals before
generating the setup command. Failed preparation shows **Retry Sample** without
a setup command. The test requires a build on the selected machine and a verified
launch. It builds for iOS, or for Android on a Linux or Windows machine, bypasses
the build cache and runs no local build. It shows the phase times (Upload / sync,
Build, Download / fetch, Total) and notes that the first build on a new machine
is cold, so later builds are faster. When the wizard closes, it stops the sample,
removes its Stim workspace and sample folder, and releases its owned simulator or
emulator (parked for reuse within the parked-simulator limit, deleted otherwise),
quietly and on a best-effort basis.

Cancel removes entries added by the wizard, restores `remote.build` only if the
wizard changed it, and runs doctor to forget the pairing. A failed undo shows
**Retry Undo**; it does not repeat on its own, because each run asks doctor to
forget the pairing. It shows revoke commands for grants created during this run,
preserving pre-existing approvals. When the pre-state is unknown, only grants
recorded in the setup journal appear.

**Remove** in Remote Machines takes the Mac out of `remote.machines`. Its sheet
shows the optional cleanup on that Mac: `stim-server devices revoke <id>` for
this Mac's build and hosting requests, and `stim-server service uninstall`. It
also says that an `ios.remote` or `android.remote` naming the Mac needs
changing.

Another Mac on the tailnet can build for this one once a person on it approves
this Mac (see [Build access](../../packages/server/README.md#build-access)).

On the Mac that wants to build elsewhere, **Stim > Settings > Remote Machines**
is a list of the entries of the `remote.machines` machine setting, in that order.
The order is the placement priority for builds, simulators, emulators and macOS apps:
each goes to the first Mac that has room and a load under its own
`server.maxLoadPerCore`, and to the next only when it has none. With two or more Macs
each row shows its place, and the up and down buttons write the new order to
`remote.machines` at machine scope. The list's footer says the same. Each row
shows its place in the list, the Mac's name, one status pill, its MagicDNS name with its cores and
offloaded builds, a detail line, what it does (**Builds**, plus **Simulators**
when its device-host access is approved), up and down buttons that move the Mac, **Details** and **Remove...**. The pill
shows only a state that stops this Mac using the machine; the machine's page holds
the rest. It reads **Approved**, **Waiting for
approval** (someone on that machine approves it by running the setup command
there; the row says when the request lapses, such as "Waiting for approval
until 21:05", in local time),
the title of the layer doctor's `diagnosis` names when the machine cannot be used
(**Tailscale is off**, **Mac is offline**, **No serve route**, **Server not running**,
**Server not ready** and so on; **Unreachable** when an older `stim` reports none), with its
message and remedy as the detail line,
**Needs update** (it runs an incompatible Stim build; **Updating** while an update runs),
the short title of doctor's first reason the approved machine is not offloadable,
such as **CocoaPods differs** or **Low on disk** (**Not offloading** for a reason
this Desktop does not know), or the machine's other readiness or
pairing state, such as **Busy**, **Not asked**, **Revoked** (revoked or
denied), **Request lapsed** (nobody on the remote Mac approved it in time;
**Ask Again** is available), **Different machine** (it answered with another stim-server key than the one
this Mac pinned at approval, so Stim does not connect to it),
**Not on the tailnet**, **Tailscale is off** or **Not a tailnet name**. The
states come from the local server's fresh doctor report (`remoteMachines` and `deviceHosts`).
The Machines page and Add Machine wizard require a read-capable session serving the same Stim
home, invalidate the report before reading, and never fall back to a CLI process. A cancelled
check leaves the shared connection open; the report follows the server's existing execution and
cleanup limit (up to 150 seconds). Explicit **Ask** actions keep their CLI setup-ticket flow.

For an approved machine the detail line gives the builds it runs and how many
it takes (`builds` and `maxBuilds`, such as "0/2 builds"; the offloaded
`running` and `max` for a stim-server that reports no `builds`) and its free
disk. Doctor reports no Xcode or Stim version per machine, so the line has
neither. A row prints no per-problem lines: the pill carries the first problem's short
title, and **Details** opens the machine's page. While a check runs, the row keeps
the last state and shows a small spinner next to the pill; **Checking...** appears
only for a row with no state yet.

**Details** (or **Remote Machines** at the top of the page, to go back) swaps the
list for the page of one machine. It shows, from the list's doctor report and one
`--platform android` report:

- the state that stops the machine, with doctor's diagnosis title, message and remedy,
  and a Copy button for each command the remedy names in backticks;
- **Stim version**: **Install This Mac's Build** and the update's progress, as on the
  row;
- one section for each of **Machine** (Stim build, free disk, load, an unreachable
  offer), **iOS**, **Android** and **macOS** that has anything to say, listing every
  `problems` entry (amber **Problem**) and every `notes` entry (**Note**: a build there
  does something without stopping, such as Gradle downloading an SDK package on its
  first build). Each shows doctor's reason and its fix: the command lines of doctor's
  finding, each with a Copy button that copies only the command, or the remedy sentence
  for a reason with no command. A note's command installs the package ahead of the first
  build. The **Update this Mac** pill replaces the pill text only; every other problem
  stays listed here. A newer remote Stim drops the "update the remote machine" advice
  from the Stim build problem, since only updating Stim Desktop fixes it;
- **Capacity**: load per core, RAM and free disk as on the row, cores, the builds it
  runs and takes, and its offloaded builds;
- **Versions**: this Mac's Stim, the machine's stim-server version (its `/health`),
  and whether its Stim build matches this Mac's;
- **Approvals**: the build approval and, for a machine that can host simulators, the
  device-host approval;
- **Builds on This Machine**: the ten newest recorded builds that ran there (from
  `stim logs --source builds --json`, read while the page is open), each opening to its
  phases and failure as on the **Builds** page, with a note when none ran, the stim is
  too old to record builds, or the read has not finished;
- **Use This Machine For**: the **Builds enabled** and **Simulators enabled**
  switches, as on the row; and **Remove...**, **Ask** and **Ask Again**.

The Android report is read when the page opens and every 60 seconds while it stays
open, never on the list's poll: it is a second doctor run through the matching local
server (`desktop-report-platform`, no CLI fallback), reused for 30 seconds. Until it
answers the Android section says "Checking the Android tools...", and when it fails, why,
while the Android problems of the list's own report stay listed. When it answers, its
Android problems and notes replace the list's, since a checkout without an Android
project has none in the list's report. The **Machines** page lists the same problems and
notes under a selected machine.

**Add Remote Machine...** opens the wizard, which owns tailnet discovery and the
setup; the tab has no separate list of tailnet Macs. With no machines, the tab
shows an illustration, one sentence on what a remote Mac does, and the same
button. A short notice appears when Tailscale is not running. The tab checks
again when it opens, every 60 seconds, and every 15 seconds while a machine
waits for approval; it has no Refresh button. Doctor runs in the most recently
active workspace `stim status` lists, like the doctor checks that notify as
**Needs you**. A workspace under `/tmp`, `/private/tmp` or `/var/folders`, such
as an agent's scratch worktree, never qualifies; with no other workspace
listed, the tab says to start one. **Ask** and **Ask Again** run `stim doctor
--json --platform ios --fix`, which also asks again any listed Mac that has not
approved this one. **Remove** takes a Mac out of the setting with `stim settings
set remote.machines <list> --scope machine` after a confirmation, unsetting it
when the list is empty; removing a **Different machine** also runs `--fix`, which
forgets the old key so the Mac can be set up again.
While a `--fix` run goes, the row shows "Asking <machine>…" or "Removing
<machine>…" beside the spinner. A `--fix` run stops after 2 minutes and a
plain check after 30 seconds, and the tab shows that stim did not answer.

A remote Mac whose Stim build is incompatible with this Mac's (doctor's
`stim-build` reason, raised when the build compatibility versions differ, or the build digests
differ for a Mac that reports no version) offers
**Install This Mac's Build**, here and on its **Machines** page. For each such
Mac Desktop first reads `machines.update.status`, a read that never installs, and
compares the Stim release it reports with this Mac's stim-server. An install only
moves a remote Mac forward, so the button is disabled, with the reason beside it, while
the read or this Mac's stim-server connection is pending and when the Mac would refuse:

- this Mac runs an npm release and the Mac runs a newer Stim: the button gives way to "<machine> runs
  Stim 1.25.0, newer than this Mac (1.24.0). Update Stim Desktop to match.", the pill reads
  **Update this Mac**, and **Check for Updates...** starts Sparkle (builds without
  an update key, such as Stim Dev, show only the message). A build from a checkout is
  not blocked by version, since stim-server checks versions only for releases;
- this Mac runs a build from a checkout and the Mac has `server.acceptClientBuilds`
  off: the row shows `stim settings set server.acceptClientBuilds true`, with a
  copy button labeled for running it on that Mac;
- its stim-server does not run as a service, so it cannot update itself;
- it did not answer the read (not approved for builds or device hosting, no update
  capability, unreachable): the row shows the reason its stim-server gave.

Desktop takes the connected stim-server for an npm release unless Desktop started
it from a path outside `node_modules`. Keeping remote machines on this Mac's
version never installs on a Mac that is disabled this way.

An install asks the local stim-server, over its local control connection,
to update that machine with `machines.update.start`. The local server connects
to the machine with the credential `stim doctor --fix` stored and goes ahead only
with the stim-server that proves it holds the key pinned at approval. It asks for the same npm release when this Mac runs one, or, when it
runs from a Stim checkout, sends the checkout's packed packages, which the
machine takes only with `server.acceptClientBuilds`. Its stim-server then waits for
its offloaded builds and hosted sessions, installs the update beside the current
server, restarts, and switches back if the new one does not answer. The row
follows `machines.update.status` every 2 seconds:

- sending the build;
- the machine's last update log line, or, while it waits, the offloaded builds
  and hosted simulators it waits for ("Waiting for 1 hosted simulator to end...");
- the restart;
- the outcome, or the refusal (for example, the setting the machine needs, or
  another update already running there).

A failure shows its full text, selectable.

While the update waits for hosted simulators that this Mac's workspaces run on
that machine, the row offers **Stop and Update...**. After a confirmation that
names each device and workspace, it runs the same `stim stop` as stopping that
device, and the update continues on its own. Hosted simulators of other Macs
can only be stopped on that machine; the row says how many there are.

The update ends as finished once the machine reports this Mac's Stim build,
even when another update installed it. If the machine stops answering for 5 minutes, or answers for 4 minutes without an update running or an outcome, the update shows as failed with the reason.
**Add Remote Machine...** stays available while an update runs.
Then the row checks the machine again. **Keep remote machines on this Mac's Stim
version** (off by default; "When this Mac's Stim changes, update stim-server on
approved remote Macs so builds can keep offloading.") does the same the next time Desktop
checks a machine that reports an incompatible Stim build. It runs once per machine and
reason each time Desktop launches. Either way, the machine gets this Mac's build.

The **Machines** page shows where builds ran. While `remote.machines` names a
machine, **Where Builds Ran** under **This Mac** counts today's compiling builds that built here, on a remote Mac, or
here after trying one, and lists the latest placements with the reason Stim
gave, such as `load 0.6/core, 1 of 3 build slots busy here`. Selecting an
`remote.machines` entry shows its state and first reason from
doctor (the same check as Settings, each minute while the page is open), its
problems and notes by platform (as on the machine's page in Settings), its
load per core, cores, offloaded builds running and free disk from its offer,
and the builds it ran for this Mac today and in total, their average time, the
time they saved against this project's last build here (an estimate), and the
fallbacks. Below are its latest placements. The counts and placements come from
fresh `stats.get` requests through the matching local server session. An unavailable session shows a read error. The page keeps checking once a
minute regardless of the selection. Pending, unreachable and failed checks stay
visible. **Link Machine** opens **Settings > Remote Machines** for pairing and
removal; the selector itself changes no settings. Remote selections have no
local disk cleanup actions.

### Macs using this Mac

Below this Mac's own remote Macs, the Remote Machines tab lists the host side of this
Mac while there is something to show, including while the tab is still loading.
**Macs Using This Mac** lists other Macs approved to build here or to host
simulator and emulator sessions here, from `stim-server devices --json`, with
where they were approved from. Only `stim-server setup` on this Mac approves
them. Each shows **Can build** or **Approved for devices** and **Revoke**, which
runs `stim-server devices revoke <id>`. A device-host approval grants no read,
control or build access, and does not start a device.

**Running Here** lists the simulators, emulators and apps approved Macs run on
this Mac, with the client, device, app, state and session age. **Stop** asks for
confirmation, then ends that session and deletes or parks its device. Parked
sessions remain listed without a Stop button. The tab refreshes both lists every
five seconds; sessions stay hidden when the local server does not support them.

## Notifications

Stim Desktop notifies with the phone app's oversight rules
(`packages/core/oversight.ts`, ported to `StimKit/Oversight.swift`), run
on each `stim status --watch --json` payload and every 30 seconds: **Work
started** (a workspace begins warming, or an agent starts driving a device),
**Agent looks stuck** (a driven workspace with no agent activity for the stuck
threshold), **Agent repeats the same failure** (the third build failure in a row
with the same cause), **Work finished or PR ready** (an agent stopped after a
green build, or git finds the branch merged), and **Machine in trouble** (free
disk under Stim's floor, or critical memory pressure for a minute). **Needs
you** lists what agents cannot handle, from the needs-attention rule
(`StimKit/NeedsAttention.swift`): `stim doctor` findings that cost time, a port
held by another app, a supervisor or browser Stim cannot verify, a signing or
provisioning failure, an expired device lease, a billable EAS session left
running. Each item
notifies once per episode, and the ids still active are kept in the app's
preferences so a restart does not repeat them. Each
workspace notifies once per episode, and a later notification replaces the
earlier one. An agent stop notifies **Work finished** once per workspace per
live run: a stop after the agent drives the workspace again before it goes idle
adds nothing, and an idle workspace starts a new run when it goes live. Needs you
notifies once per workspace per run in the same way, with its allowance
returning when the workspace has no item left. A `stim doctor` finding with the
code `not-an-app` (the folder is not a React Native or Expo app) raises no
Needs you notification, because agents run stim in such folders; the finding
stays in doctor and on the workspace page; a `stim` older than the code gives
the finding none, so it needs the updated CLI. These limits are Desktop's: the
phone app's rules in `packages/core/oversight.ts` still push every stop. The first launch with these rules
marks the existing inbox read, once, and later entries are untouched. The first payload after launch records what is already true without
notifying, except for Needs you, which notifies each item it has not notified
before. Desktop does not look up pull requests, so it never notifies a pull
request ready for review; a merged branch notifies once git finds it merged. The
phone's "Someone takes over your device" is a push to a phone and never fires
here. A phone controlling a simulator
through stim-server counts as an agent driving it, because Desktop cannot read
stim-server's leases. The phone app and stim-server do read them, and do not count such a phone as an agent.

Each category has a level, with the phone's names: **Alert**, **Silent** or
**Off**. **Work started** is Off by default; every other category is
Silent. A level you set yourself is kept. While the main
window is in front, every new Alert or Silent entry gives the top-right bell one
small wiggle and turns it purple for under a second, and bumps its unread count;
several arrivals within two seconds wiggle once, and the bell stays still while
Notifications is open. Off entries are stored already read, so they neither wiggle
the bell nor count as unread. Under Reduce Motion the
bell keeps the colour and skips the wiggle. A build or
device-hosting request, which lapses after 15 minutes, and a machine problem
at Alert level also open a card in the window's top right corner, newest on top,
with its call to action and a dismiss button; clicking the card opens its target,
and it stays until dismissed or answered. Every other category reaches the bell
only. When the main window is not in front, an Alert is a macOS notification
with sound, and clicking it brings Stim Desktop up on the target. macOS asks for permission the
first time one is posted. Silent has no sound, macOS notification or card, only the
bell wiggle; Off has none of these.

Every notification also lands in **Notifications**, opened from the top-right bell with
the unread count: newest first, grouped by day, each row with its category icon,
title, body, time and the same call to action. Clicking a row
or a macOS notification opens the target and marks the row read. An Off category
is listed as **Muted**, and an Alert held by quiet hours as **Quiet hours**, as
in the phone app's inbox. The page filters by category and by workspace (or the
machine). It initially shows 50 matching notifications; **Show Older Notifications**
adds the next 50. Changing a filter returns to the first batch. **Mark All Read**
and **Clear** apply to every matching notification, including unloaded rows. The
history keeps the last 200 notifications from the last 7 days in
`notifications.json` in Stim Desktop's Application Support folder.

**Settings > App > Notify when** sets each category's level, the stuck threshold
(5 to 60 minutes, 15 by default) and quiet hours, stored in `UserDefaults`.
During quiet hours an Alert is delivered as Silent. The rules always run every
category without quiet hours, so switching a category on later does not notify
what it missed.

## Settings

**Stim > Settings** (Command-comma) edits Stim settings and the app's own
preferences.

The **Stim Settings** tab holds a **Machine**, **Repository**, **Workspace** and
**.stim.json** scope switch, with a line saying where the selected scope applies.
Its editor reads the registry-derived schema from the same local server through
`desktop.settings.schema`, with `desktop-settings-schema` support, instead of locating
files beside an external CLI. Each load refreshes the fields; an unavailable, older or
invalid schema shows a load error and no editable fields. Choices are pickers, booleans
toggles, numbers steppers, paths file pickers, string lists token fields, and
objects JSON fields. Values come from fresh `desktop.settings.get` reads for the chosen
folder, including unregistered folders. Settings, setup, tutorial and machine views
require a read-capable local session for the same canonical Stim home advertising
`desktop-settings`; unavailable or older servers fail these reads without a CLI fallback.
The shared machine store, open Settings window, setup and tutorial reads refresh when
the session opens, including after cold launch or reconnection.
Cancellation leaves the shared session open; the existing server read limit is 60 seconds.
Each row shows the effective value and its layer, the lower layer a
value there overrides, an environment override when one is set, and a
**Reset** that unsets the layer. A default `stim` picks per machine, such as
`stim-desktop` for `iosSimulatorApp` while Stim Desktop is installed, shows the
reason `stim` reports, for example `default (Stim Desktop installed)`. Edits use
`desktop.settings.write` on the proved local connection of Desktop's bundled
server, for the same canonical Stim home, with `desktop-settings-write` support.
An unavailable, older, external or adopted server reports an error without a CLI
fallback. A refusal's message and remedy show
under the field. `android.keystorePassword` is never shown. Keys Stim does not
read are listed read-only.
Cancellation ends the local await while the bounded server operation can finish;
Desktop never automatically retries a write after cancellation or connection loss.

The **App** tab holds preferences kept in `UserDefaults`, never in Stim's
config: appearance (Auto, Light, Dark), the sidebar's Status option, opening to all
devices or the last project, device tile size, a live frame rate cap, pausing
frames while the window is hidden, the editor and terminal the workspace
inspector opens, notifications, a menu bar extra with the active workspace count
and quick open, launch at login, automatic maintenance (see Automatic maintenance), and a `stim` executable override that applies
at the next launch. Notifications and launch at login need the bundled app.

## Window and shortcuts

Closing the main window, with Command-W or the close button, leaves the app
running: the Dock icon stays, the status watch, notifications, the disk pressure check and
`stim-server` keep working, and clicking the Dock icon or choosing **Open Stim**
in the menu bar extra reopens the window. There is one main window; Command-N
does not open another. **Quit Stim** (Command-Q) is the only way to stop the app,
and it stops `stim-server` and the log followers. Command-1 through Command-4 in the View menu open Overview, Active Workspaces, Notifications and Machines.

The main window keeps a back and forward history, like Finder. Chevron buttons at the
leading edge of the toolbar, **Go > Back** (Command-[) and **Go > Forward** (Command-]),
the mouse back and forward buttons and the trackpad's swipe between pages (when that macOS setting is on) move through it.
A destination is the sidebar selection plus the project page's **Showing all worktrees**
scope and the device a tile click focused. A sidebar click, a card click, a notification
action, a deep link or an oversight target adds one; the history keeps the last 50.
Navigating after going back drops the forward entries. Back and forward skip a workspace,
worktree, archive or project that Stim no longer lists, and a button is disabled when
nothing before or after resolves. The launch page choice restores a destination in place,
so Back does not return to Overview from it.

## Notice cards

News the user can act on later shows as a card at the main window's bottom
left: a title, one line of detail, a primary action and a dismiss button. A
new-workspace card expires after one minute; other cards stay until acted on or
dismissed, with or without VoiceOver. Several cards stack, newest first, with a
counter and previous and next buttons.
Two things use them. When `stim status` first lists a workspace, the card reads
"New workspace <workspace>" with **Show**, which opens the workspace and focuses
the device of its running build. Each path gets one card per Desktop session:
workspaces listed in the first status after launch get none, and a path that
leaves and comes back gets none again. While the workspace's build runs, the
card's detail reads "Building <platform>" instead of the path. A
`stim-desktop://open` device URL from `stim ios` or `stim android` only opens
the main window when it is closed.
Desktop keeps the current page and opens the workspace only when **Show** is
clicked. A newer `stim` shows a card with
**Update** (see below); dismissing it keeps it away until a newer version is
released. Agent and build notifications keep appearing as cards at the top right.
Turn off **Settings > App > Show new workspace cards** to stop the "New workspace" cards. It hides only
those cards: the workspace still appears in the sidebar, and Notifications, system notifications and the
other cards are unchanged. A workspace link still shows its "workspace started" card.

## Workspace links

Shared links use `https://stim.appandflow.com/open?v=1&machine=<home-id>&workspace=<workspace-id>`.
The optional `platform` and `slot` select a device. The authenticated local server's
home ID must match, and status must list the workspace ID before Desktop navigates
to its trusted path. A foreign home, unsupported server or stale workspace shows a
message instead. Opening a link never starts a build or device control. The website
provides a small fallback page; iOS resolves the same IDs through its existing pairings.
Universal links require signed native builds and the hosted Apple association file.

Legacy local links remain supported:

`stim-desktop://workspace?path=<workspace>[&platform=<ios|android|web>][&slot=<name>][&archive=<id>]`,
shows a
card for a live workspace with **Open**; the app navigates to it only when Open is
clicked. The optional `archive` ID opens that archive at once if it belongs to that
path and no live workspace matches; an ID that does not belong to that path does not
fall back to the newest archive. A link without `archive` waits up to 10 seconds
for the live workspace, which a re-created worktree can bring back, and then opens
the path's newest archive. A malformed
link, or a path with no matching live workspace or archive within 10
seconds, shows **Workspace not found**; if the workspace appears within the
next minute, its card replaces that one. Another link to the same workspace
replaces its card. With the main window closed, the link reopens it.

- macOS 14 or later and Xcode 27, selected with `xcode-select` or `DEVELOPER_DIR`. Stim Desktop falls back to `/Applications/Xcode.app` when the selected developer directory has no simulator support.
- `stim` on the `PATH` described below, `STIM_BIN` set to its path, or the override in Settings. The cleanup
  preview needs a `stim` with `gc --json`.

  <a id="environment"></a>Stim Desktop runs no login shell. At launch it runs Stim's
  toolchain discovery, the one stim-server and `stim doctor`'s **Toolchain** section
  use, once with the bundled Node (about 50 ms), and runs every `stim` command with the
  result: the launch environment with the default Node of nvm, fnm, Volta, mise or asdf,
  Homebrew, `~/.local/bin`, pnpm's and bun's global directories and the Android SDK
  tools appended to `PATH`, `ANDROID_HOME` when `~/Library/Android/sdk` exists, and
  `JAVA_HOME` set to a Homebrew `openjdk`, else Android Studio's runtime, when no JDK is
  installed under `/Library/Java/JavaVirtualMachines`. A shell profile's variables do not reach it:
  **Settings > Advanced > Environment** holds the Stim home, which replaces a profile's
  `STIM_HOME`, and `KEY=VALUE` lines, such as `STIM_*` settings or
  `NODE_USE_SYSTEM_CA=0`, that Desktop adds to the environment of every `stim` command
  and of the server it starts; both apply when Desktop restarts. The first launch of
  this version moves a non-default Stim home that the previous version saw in the login
  shell into that setting. A launch `STIM_HOME` wins over the setting, and Desktop never
  exports `~/.stim`, because an explicit `STIM_HOME` turns on the scoped-home defaults.
  A build without the bundled server, such as a `stim macos` copy or `swift run`, reads
  `zsh -lic` once instead and logs that it did; the `login-environment` launch milestone
  marks it, where a bundled build reaches `toolchain-environment`.
  **Settings > App > Stim CLI** shows the resolved home, and the sidebar shows non-default homes.
  Homes whose local socket path exceeds macOS's 103-byte limit use the private
  per-user socket directory described in [Replay](#replay).
  It adds `STIM_DESKTOP_APP`, set to the app's bundle path, which
  tells `stim` that Stim Desktop is installed without a Launch Services lookup.
  It runs `stim` and `stim-server` as their JavaScript file under the Node that
  `node` resolves to in the home folder, with the directory holding `stim`
  first on the `PATH` so a Node installed beside it, as nvm does, wins. It does
  not run them through the files' `#!/usr/bin/env node` line in the workspace. A version manager that follows
  the working directory (asdf, mise, Volta) would otherwise run them on the
  Node a project pins, which can be older than Stim supports. When `stim` on
  the `PATH` is a shim in a version manager's `shims` folder (asdf, mise,
  nodenv), the app runs the global install that npm, pnpm or bun reports from
  the home folder; any other script, such as a wrapper, runs as it is. Each
  command follows the executable's links again, so an update takes effect
  without a restart. When the Node binary disappears, as after a Homebrew
  upgrade, the next command finds the home folder's Node again first, waiting
  at most 2 seconds for it. If the initial probe or redetection fails, the
  managed launcher refuses the command rather than falling back to a project's
  Node, and retries detection on later commands without requiring an app restart.
  A recognized version-manager shim whose global CLI cannot be located also
  refuses to run. Once Check Again resolves that install, it offers a restart
  when the app's cached launcher still points to the unresolved shim. The server's
  unresolved launcher is detected again on a later command after 60 seconds.
  A Node older than 22.12.0 refuses every command
  with its version and path; when that is why `stim` reports no version, a
  popup asks for a newer default instead of a newer Stim. The app looks for
  the Node again at most every 10 seconds, so the next command after a new
  default runs without a restart. Without a launcher for `stim-server`, it
  tries again at most once a minute.

At launch the app runs `stim --version` and needs 1.21.0 or later. When
`stim` is missing, too old, or reports no version, a banner explains Stim and
offers **Install stim** or **Update stim**, and **Choose stim Executable…**.
**Update stim** runs the package manager that owns the resolved `stim`: the
app resolves the `stim` file through symbolic links and pnpm shims and checks
it against `npm prefix -g`, `pnpm root -g` and `bun pm bin -g`, and runs
`npm install --global`, `pnpm add --global` or `bun add --global` with
`stim@latest`. A `stim` outside every manager's global directory, such as a
linked checkout or a project-local copy, gets no Run button and a note, since
the app cannot tell what installed it. **Install stim** uses the manager picked
in the setup guide's tabs; the banner uses the default, pnpm or bun when its
global bin directory is on Stim Desktop's `PATH`, else npm. A pnpm whose
global bin directory is not on the `PATH` is not offered, because pnpm refuses
global installs then. `stim-server` ships inside the app; with an override in
**Settings > Advanced**, that one is still installed and updated with npm.

Once a day, and at launch, the app also reads the
`latest` version of `stim` from `registry.npmjs.org/stim/latest`; it skips the
check when the registry cannot be reached. When the `stim` it runs is owned by a
package manager and older than `latest`, a notice card offers **Update** once
per version, the sidebar footer shows **stim
<version> available** and **Settings > App > Stim CLI** shows the installed and
latest versions with an **Update** button, which runs the same package manager
command as **Update stim**. It only notifies: nothing updates in the
background, because replacing `stim` while agents run commands would break them,
and a `stim` that no package manager owns, such as a linked checkout, is never
offered an update. A newly found `stim` at another path asks for a
restart, because the app resolves `stim` once at launch. While phones are
served, `stim-server --version` gets the same check; the bundled server always passes
it, and an outdated override is offered `@stim-cli/server@latest`. Once `stim` is recent enough, the banner offers once
to set `iosSimulatorApp` and `androidEmulatorApp` to `stim-desktop` through the
same private local settings transport. It skips a key that is already set or
that the installed `stim` does not list. **Not Now** hides the offer for good.

### Suggestions and tips

Desktop suggestions offer a remote machine, cache review, or phone pairing when
recent activity makes them useful. A low-disk banner points to the Machine page,
where caches are reviewed and cleared. Suggestions to add a remote machine appear
only while `remote.machines` is empty. A new tailnet peer and a build waiting
for a build slot consider Macs, Linux and Windows machines (a Linux or Windows machine only after an
Android build waited); the device limit offers only a Mac, since only a Mac
hosts. A build waiting for a build slot or
the device limit suggests one at most once, ever, across both. The X snoozes a suggestion for
7 days; **Don't Suggest Again** dismisses that kind permanently. Suggestions
wait for completed setup and the second launch, never appear during a running
build, and appear at most once per day.

**Explore Stim's features** at the bottom of the sidebar opens **Discover Stim**.
You can also open it from **Help > Discover Stim** or **Settings > App > Features**.
The page starts with a tutorial banner, followed by Everyday workflows,
Use more devices, and Other workflows. Each card explains the benefit
and opens an existing action or offers a copyable agent prompt. The full prompt appears
in a container with a Copy button. Phone access appears only when the Phone app feature
flag is enabled.

Discover is always available, without waiting for usage milestones. Replay opens
the newest eligible archived workspace with recordings. When recordings are not
available, the card explains why and disables its action. View Options opens the
sidebar's existing controls for hiding and filtering workspaces. Discover replaces
the rotating sidebar tips; opening it does not mark tips as seen or suppress
contextual suggestions.

The Machine page's remote-machine suggestion still requires completed setup and
at least **3 calendar days** of usage, with either **3 distinct workspaces seen
running** or **5 builds observed**. Only builds that start after Desktop first
sees status count. This usage stays in local Desktop preferences.

Turn off **Settings > App > Offer the tutorial** to hide the setup guide's
**Take the Tutorial** button and stop the tutorial from opening automatically.
**Help > Stim Tutorial** and Discover Stim still let you open it manually.

**File > Add Remote Machine…** (**Cmd+Shift+B**) always opens the existing build
machine wizard. After this usage threshold, **Machines > This Mac** shows a
card when no remote machine is configured. With another Mac, Linux or Windows machine
online on the tailnet it offers **Add Remote Machine…**; otherwise it explains
how to connect both machines with Tailscale. The remote machines tip also
counts an online Linux or Windows peer; the hosted simulators tip counts only Macs. The
existing **Link Machine** button is also available. Build machines are not a
step in the first-run setup guide.

### Setup guide

The first launch opens a setup guide over the main window, unless everything it
sets up is already in place; **Help > Setup
Guide…** and **Open Setup Guide…** in **Settings > App** reopen it. Each step
shows what it found, the exact command its **Run** button runs with the
directory it runs in, and that command's output. Nothing runs until Run is
pressed, commands run one at a time through the same runner as the banner, and
the step checks again when the command ends. Return presses the step's Run
button, or **Continue** once the step is done, and never skips a step; Escape is **Set Up
Later**.

1. **Welcome**.
2. **Install the CLI**: `node` from Stim Desktop's `PATH`, run in the home folder,
   must report 22.12.0 or later; an older one is shown with its path. Without it, the step offers `brew install node` when
   `brew` is on the `PATH`, else a link to nodejs.org. Then it
   shows tabs for npm, pnpm and bun, only for the managers on the `PATH`
   (the default is pnpm or bun when its global bin directory is on the `PATH`,
   else npm), and runs `npm install --global stim`, `pnpm add --global stim`
   or `bun add --global stim` in the home folder, then shows the `stim` found
   afterwards with its version. A `stim` that no manager owns shows a note
   instead of a Run button. A `stim` the app did not resolve at launch
   asks for a restart, which reopens the guide on the same step. Checks use
   the `PATH` captured at launch, so a Node.js installed into a new
   directory, as nvm does, needs a restart to be found.
3. **Add the Agent Skill**: `npx skills add appandflow/stim --yes` in the
   home folder, where the skills CLI's project scope is the user's own agent
   folders. `--yes` keeps the skills CLI from asking which agents to install
   to, which fails without a terminal. It counts as installed when `~/.agents/skills/stim/SKILL.md`,
   `~/.claude/skills/stim/SKILL.md` or `~/.codex/skills/stim/SKILL.md` exists.
4. **Notifications**: asks macOS for permission, or opens System Settings
   after a denial, and sets the level of the notifications that ask for you.
5. **Check Your Setup**, optional: `xcodebuild -version` and `java -version`,
   the Android SDK found the way `stim` finds it, and `stim doctor --json` in a
   project folder the user chooses, which needs the restart above first. The
   findings show as rows with their severity, detail and fix, and the raw
   output stays behind a disclosure. A finding whose fix names
   `stim doctor --fix` gets a Fix button that runs that command after the
   confirmation the Needs attention page uses, then runs doctor again. The
   step shows a green check once the three commands ran this session and
   doctor reported no finding that costs time, and the warning mark when one of
   them failed or doctor reported such a finding.
6. **You're Set**: the state of steps 2 to 4.

When the CLI, skill and notifications are already set up at a launch without
`setupGuide.completed`, the app sets the flag and does not show the guide;
opened from the menu, it starts on the summary. **Start Using Stim** or **Set
Up Later** also sets the flag, which lives in the app's `UserDefaults`, so Stim
and Stim Dev each track their own. The `stim` banner stays
hidden while the guide is open.

## Develop

```bash
cd apps/desktop
swift run
swift test
```

`scripts/format.sh` formats the Swift sources with `swift-format` from the
Xcode toolchain, tuned by `.swift-format`; `scripts/format.sh --check` runs
the same rules as a lint, which is what desktop CI runs. CI also builds and
tests with `-Xswiftc -warnings-as-errors`, so fix a warning instead of
introducing one.

`Sources/StimDesktop/Design/Tokens.swift` is generated from the phone app's
design tokens in `apps/mobile/src/design/tokens.ts`: spacing, radii, opacity,
the text styles with their macOS sizes from `macosText`, and the light and dark
colors. `Sources/StimDesktop/AgentPrompts.swift` is generated from the phone
app's empty-state prompts in `apps/mobile/src/lib/agent-prompts.ts`.
`Sources/StimKit/TutorialSteps.swift` is generated from
`packages/stim-cli/src/guide/tutorial-data.ts` and the supported version in
`packages/core/state/status.ts`. After changing these inputs, regenerate with
`node apps/desktop/scripts/generate-tokens.mjs`. Desktop CI runs the same
script with `--check` and fails when a committed file is stale. The color
names match the phone's; `Palette` colors follow the system appearance and the
app's Appearance setting.

`scripts/ax-finite.swift` walks a running app's accessibility tree and prints
every element whose position, size or frame is not finite, with its ancestors.
agent-device cannot encode such an element, so its `snapshot` fails. Run
`swift scripts/ax-finite.swift <pid>` against a `stim macos` copy, with the
window small enough that the Overview's lower sections are scrolled out of
view. SwiftUI reports a lazy container with no realized children at
(inf, inf), so give every `LazyVGrid` and `LazyVStack` the
`finiteAccessibilityFrame()` modifier. The terminal needs Accessibility access.

## SwiftUI playground

Run the DEBUG playground without starting the normal app's CLI, server, notification service or updater:

```bash
cd apps/desktop
swift run StimDesktop --playground
```

In a normal debug session, **Window > SwiftUI Playground** opens the same fixture views;
that session's main window keeps its normal live services. The standalone entry is the
backend-free option. Release builds exclude the playground and its fixture seams, and refuse `--playground`.

Choose live or archived Workspaces, Notifications, Builds, Simulator controls, Settings or Design tokens. Each screen offers
its applicable named scenarios: ready, loading, empty, error, long text and large data.
Notifications includes 200 entries; Builds includes the retained maximum of 10 runs per platform. Local inboxes and fixed
simulator forms omit loading/error or large-list scenarios that their production views do not have.
Settings covers the four configuration scopes, not the App, Phones or Remote Machines tabs.

**Compact** sets the fixture viewport to 380 points; regular is 900 points. Switch light/dark,
large text and increased contrast without changing system preferences. Reduce Motion follows the Mac's current accessibility setting because SwiftUI does not expose a writable override. Filters,
mark-read/clear, build disclosures, simulator appearance controls and Settings edits operate only
on fixture data. Run and log buttons report a simulated action. **Reset** restores the scenario.

To add a scenario, extend `Design/PlaygroundFixtures.swift` and select the existing production
view in `Design/ScreenPlayground.swift`. Keep fixture effects in memory; the real archive screens read sanitized fixture files from this checkout,
add a narrow DEBUG seam only when that view would otherwise invoke a real backend. These
fixtures can also seed the separate visual regression pilot tracked in #2342; the playground
does not add a snapshot framework or a golden-image approval workflow.

## Build the app

```bash
apps/desktop/scripts/bundle.sh
open "apps/desktop/build/Stim Dev.app"
```

`bundle.sh` builds **Stim Dev**, a variant that runs next to the installed
release app: bundle id `dev.stim.desktop.dev`, `build/Stim Dev.app`, the phone
app's orange Stim Dev icon (`Support/AppIcon-Dev.icns`), and no update feed,
Sentry DSN or `stim-desktop` URL scheme. It has its own `UserDefaults`, login
item, notification permission and notification history, and pairs with
stim-server under its own name (see [Replay](#replay)). Both apps use port
7787, so the one that starts second uses the other's server instead of starting
one; when that app quits, the remaining one starts its own within two minutes. Paired phones and the `tailscale serve` route keep working
because they belong to the Stim home, not to either app. Both apps check disk
pressure. `stim ios` and `stim android` open device links with `open -a Stim`,
which reaches the release app, never Stim Dev.

`bundle.sh --release` builds the release variant, `build/Stim.app` with bundle
id `dev.stim.desktop`, which `scripts/release.sh` and the release workflow use.

The bundle copies Inter, JetBrains Mono, and the brand artwork, including the animated jar's and the build animation's Lottie files, from `website/`, and embeds `Lottie.framework` from the `lottie-spm` package and `Sparkle.framework` from the `Sparkle` package in `Contents/Frameworks`. Sentry is linked into the executable. Resolving the `sentry-cocoa` package downloads every xcframework it declares, about 450 MB, and extracts about 3 GB into `.build/artifacts` ([getsentry/sentry-cocoa#9146](https://github.com/getsentry/sentry-cocoa/issues/9146)).

`bundle.sh` needs the repository's pnpm workspace installed (`pnpm install`).
`scripts/server-runtime.mjs` stages the bundled server into
`Contents/Resources/stim-server`: it downloads the Node.js release it pins
(`NODE_VERSION`) from nodejs.org once into `.build/node`, checks the tarball
against the SHA-256 the script pins and against that release's `SHASUMS256.txt`,
keeps `bin/node` and its `LICENSE`, strips local symbols, and joins the arm64 and
x64 binaries with `lipo` for `--universal`. It builds `@stim-cli/server` and the
workspace packages it imports, packs them with `pnpm pack`, and lays out their
third-party dependencies at the versions `pnpm-lock.yaml` resolves, without
symbolic links, keeping only the darwin `unique-pid` prebuilds. It refuses a
layout in which any package would load a dependency other than the one the
lockfile names, and a staged server whose `--version` does not match
`packages/server`. `bundle.sh --server <dir>` copies a server staged earlier
instead; the release workflow stages it before any secret is loaded and
`release.sh` reuses it through `DESKTOP_SERVER_RUNTIME`. To move to a
newer Node, change `NODE_VERSION` and both hashes from that release's
`SHASUMS256.txt`. Universal costs about 199 MB on disk (98 MB arm64 + 101 MB
x86_64); the app and its Sparkle feed are universal, so it ships both.

`release.sh` signs each `unique-pid` addon and then `bin/node` with the
hardened runtime and `Support/Node/node.entitlements`:
`com.apple.security.cs.allow-jit`, which V8 needs, and
`com.apple.security.cs.disable-library-validation`, because the `stim`
commands the server runs on this Node can load a project's own native addons,
signed by another team or not at all. Both are in the set Node.js signs its own
macOS release with. The Desktop workflow stages the server on every run, signs
it the same way ad hoc and checks that it answers `/health` under an empty
environment.

## Updates

Stim Desktop checks for updates with Sparkle 2 against the appcast at `SUFeedURL` in `Support/Info.plist`, `https://github.com/appandflow/stim/releases/download/desktop-latest/appcast.xml`. **Check for Updates…** in the app menu checks now, and Sparkle checks in the background once the user accepts its prompt on the second launch; **Settings > App > Updates** turns the background checks on or off. `scripts/bundle.sh --release` writes `SPARKLE_PUBLIC_ED_KEY` from its environment into `SUPublicEDKey`. A build without that key, which includes `swift run`, every Stim Dev build and every test copy, never starts the updater: the menu item stays disabled and the toggle is off.

`scripts/release.sh <version>` builds the signed, notarized universal DMG and zip; see [RELEASING.md](./RELEASING.md).

## Debug log

Stim Desktop keeps a local debug log for finding out what happened when something goes wrong. It stays on this Mac: nothing is uploaded. Lines go to `~/Library/Logs/Stim/Desktop.log`, which rotates at 2 MB and keeps three older files (`Desktop.1.log` to `Desktop.3.log`, about 8 MB in all), and to `os.Logger` under the subsystem `dev.stim.desktop` with the categories `app`, `cli`, `server`, `decode`, `navigation`, `stall`, `sampler` and `stream`, so Console.app can filter them. Each line is `<time> <pid> <level> <category> <message>`. Only the released app (bundle id `dev.stim.desktop`) writes `Desktop.log`. Any other bundle id, such as a `stim macos` test copy, writes `Desktop-<suffix>.log` instead, where the suffix is the bundle id without its `dev.stim.desktop.` prefix (for example `Desktop-dev.log`), so copies do not add lines to the installed app's log; copies with one bundle id append to the same file and are told apart by pid.

By default it records warnings and errors only: `stim` and `stim-server` runs that fail (exit status, `STIM_*` error code, last stderr lines), main-thread stalls, sampler gaps (why CPU, RAM or disk could not be measured), JSON decode failures (the type and coding path, never the payload), and device stream errors. A stall is a main-thread block of 250 ms or more; the line names the sidebar destination and the last CLI command. The watchdog is one utility-queue timer, four wakeups a second, and one empty block on the main queue per tick.

Debug level adds every CLI run with its arguments and working directory, each `STIM_RUN_ID`, navigation, stim-server state changes and stream start and stop. Turn it on with a defaults key, then relaunch:

```sh
defaults write dev.stim.desktop debugLogging -bool YES
defaults delete dev.stim.desktop debugLogging   # back to the default level
```

A Stim Dev or `stim macos` copy has another bundle id; pass `-debugLogging YES` as a launch argument instead.

Every `stim` and `stim-server` process Desktop starts gets `STIM_RUN_ID=desktop-<12 hex digits>`, the same id the log line carries. The id is in the child environment so the CLI and server can adopt it to follow a Desktop action end to end. Desktop never logs environment values. Before a line is written, `DebugLogRedaction` replaces token, ticket, secret, password, authorization and DSN values, `--token`-style flag values, bearer values, URL credentials, JWTs and long opaque strings. Help > Reveal Debug Log shows the file in Finder. Help > Copy Diagnostics copies the log path, the Desktop, macOS, `stim` and `stim-server` versions and the output of `stim doctor --json` for the selected workspace, redacted the same way.

## Crash reports

Stim Desktop reports crashes and uncaught exceptions to Sentry with sentry-cocoa, linked statically from its `Sentry` product. It starts Sentry only when the bundle's Info.plist carries a DSN in `StimSentryDSN`. The DSN is not in the repository: `scripts/bundle.sh --release` writes it from the environment, so `swift run`, `swift test`, Stim Dev, a bundle built without it, forks and CI report nothing and send nothing.

| Variable                  | Used by     | Effect                                                                                                                             |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `STIM_DESKTOP_SENTRY_DSN` | `bundle.sh` | With `--release`, written into `StimSentryDSN`. Empty or unset turns crash reporting off.                                          |
| `SENTRY_AUTH_TOKEN`       | `bundle.sh` | With `--release`, the two below and `sentry-cli` on `PATH`, uploads the app's dSYM after bundling.                                 |
| `SENTRY_ORG`              | `bundle.sh` | The Sentry organization slug for the dSYM upload.                                                                                  |
| `SENTRY_PROJECT`          | `bundle.sh` | The Sentry project slug for the dSYM upload.                                                                                       |
| `STIM_DESKTOP_CRASH_TEST` | the app     | `exception` raises an uncaught NSException, `crash` traps and `hang` blocks the main thread for 5 seconds, 3 seconds after launch. |

Without all three upload variables or `sentry-cli`, `bundle.sh --release` prints one line to stderr and skips the upload; a failed upload never fails the bundle. The dSYM is made with `dsymutil` from the bundled executable, so its UUIDs match the binary that `scripts/release.sh` later signs.

An event carries the release `stim-desktop@<CFBundleShortVersionString>+<CFBundleVersion>` and the dist `<CFBundleVersion>`, read at launch. Sentry runs with `sendDefaultPii` off and tracing, session tracking, network breadcrumbs, failed-request capture, stack traces on handled events and MetricKit off; macOS has no screenshot or view hierarchy capture. Every event's text, tags, extra data, stack frames and breadcrumbs pass through the scrubber before they leave the app (the grouping fingerprint repeats the tag values and is not scrubbed): it replaces file paths outside system locations and `/Applications` with `<path>`, keeping the part from `Stim.app` on, and removes the Mac's host names, `.local` and tailnet hosts, IPv4 addresses other than `127.x` and Tailscale IPv6 addresses, URL hosts other than `localhost`, URL paths and query strings, and tokens, keys, passwords and other credentials. A path stops at whitespace, so after a space only a `/Users/<name>` folder is removed. A crash is sent on the next launch.

### What is sent

Besides the standard Sentry fields (SDK and release, the OS version and kernel, the Mac model, architecture, memory, locale and time zone, the app's bundle identifier, version and memory use, and a random per-install user id), Desktop sends these events and no others:

| Event                      | When                                                             | Fields                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash or uncaught error    | The app crashes or raises an uncaught `NSException`.             | The exception type and message, the stack trace and loaded images, scrubbed.                                                                                                                                              |
| App hang                   | The main thread is blocked for 2 seconds or more.                | `App hanging for at least 2000 ms.`, the stack traces of all threads, scrubbed.                                                                                                                                           |
| `stim command failed`      | A one-shot `stim` call (`status`, `stats`, `doctor`, ...) fails. | Tags `command` (a command of the CLI's command surface, else `other`), `outcome` (`exited`, `timed-out` or `not-found`), `exit_code`, and `stim_code` when the output names a bare `STIM_*` code. No arguments or output. |
| `payload decode failed`    | JSON from `stim` or `stim-server` does not decode.               | Tags `source` (`cli` or `server`), `type` (the Swift type), `coding_path` (field names the type declares, with `<key>` for a dictionary key and `[]` for an array index) and `reason`. No values.                         |
| `stim-server start failed` | Desktop cannot start or adopt `stim-server`.                     | Tag `kind`: `adoption-home-mismatch`, `launch-failed`, `no-answer`, `exited` or `too-old`. No message, path, port or output.                                                                                              |

The three handled events are warnings with a fixed message. Each distinct failure is sent once per launch, and a launch sends at most 20. A command that streams output, such as `stim ios`, and a failed `stim-server` command send no event, because a failing build is not a Desktop fault.

Once set, each event carries three tags that name where the app was: `page` (the kind of the last page: `overview`, `wall`, `project`, `workspace`, `archived-workspace`, `worktree`, `notifications`, `machine` or `none`, never a name) and `last_cli_command` (the last `stim` command started) and `server_state` (`off`, `starting`, `running`, `not-ready` or `failed`). Breadcrumbs hold the last 150 of:

- `navigation`: the page kind.
- `cli`: `start <command>` and `finish <command>` with `duration_ms` and `exit_code`.
- `server`: `state <state>`.
- Sentry's own `started` (`Breadcrumb Tracking`), `app.lifecycle` (active or inactive) and `device.connectivity` (the connection type).

No event or breadcrumb carries a project, workspace, branch, machine or host name, a path, an argument, an output line, a payload value or a token. `Tests/StimKitTests/DiagnosticsTests.swift` and `CrashScrubberTests.swift` check this.

To check a bundle, point the DSN at a local listener, such as `http://<key>@127.0.0.1:<port>/1`, and launch it with `STIM_DESKTOP_CRASH_TEST=crash`, then again without it; the listener receives a gzipped envelope at `/api/1/envelope/`.

## Tutorial panel

Longer steps show a short instruction with an expandable **Why this step?**
explanation. Waiting messages name the next action. Completed stepper segments
are green; skipped segments stay gray. Prompt buttons briefly show **Copied**.
The summary includes a copyable prompt to try Stim with your own app.

**Help > Stim Tutorial…** and the setup guide's **Take the Tutorial** button open
a floating window beside the main app window, kept within the screen and on the
same desktop Space as that window. It stays
freely draggable while open; reopening positions it beside the app again.
Until you drag it, resizing Stim keeps the tutorial beside the app with a 12-point
gap where screen space permits. The pin at the bottom right docks it in the sidebar;
click it again to float the tutorial. In full-screen mode, the tutorial docks inside
the right side of the main window and the pin is disabled. Leaving full screen
restores the floating tutorial with the same progress. The tutorial hides during
the transition and fades back in when it finishes, respecting Reduce Motion.
It uses the same window level as Stim, so other apps can cover both windows.
While a popup is open in the Stim window, the tutorial stays visible but its controls
and arrow-key navigation are disabled until the popup closes.
A new tutorial path opens it once, after open
sheets close. UserDefaults stores progress and skipped steps.
Unfinished tours resume at launch when status lists the tracked path; archived
ones show Done. Closing preserves progress. Restart shows the agent prompt and
resets progress at once; see below for which worktrees count afterwards.
The three-minute workspace warning starts at the first Copy of the run prompt
and survives relaunch. Only archives
removed after this run started can complete the tutorial.

The panel clones appandflow/stim-tutorial and follows: a tutorial workspace
appearing (Get the Test App; the clone only, which is never the tour), the first
linked worktree of the clone and its first iOS build (Make a Change, `tourPath`),
the next linked worktree created after that step began and its first iOS build,
which must start after the step began (Change It Again in Parallel,
`secondPath`). Both steps complete when their build starts running; the stats
record each build when it succeeds, and a later failed iOS build of that
worktree shows as a warning under the completed step. The steps continue with optional live view, agent actions and logs steps,
optional phone and remote Mac steps, an optional Share Your Finish prompt, then
removal and Archived of both tracked worktrees (Finish; the clone stays). The
tutorial version is 2, from the repository's `expo.extra.stimTutorial`. A stored
version 1 record is dropped and starts over on a version 2 workspace. Restart and
"take the tutorial" start a fresh record at the current time that forgets the old tour paths even
while the old worktrees are still registered; only linked worktrees whose creation time is after
that start count, and the oldest one becomes the tour. Every step has one Skip step
button: it records the step as done when its non-optional ticks are all done or
its checkpoint completed, and as skipped otherwise. Detected steps advance on
their own, including Agent Actions after viewing and replaying. The first step explains automatic advancement. Waiting states show a spinner; blocked or interactive steps show an information icon and guidance.
The summary distinguishes completed required steps from an ended tour with skipped steps, shows completed/skipped counts and time in the tutorial, and keeps Restart only in the footer. Open Archived selects the newest archive from either tracked worktree removed after this run began; when unavailable, the summary explains why. Stepper tooltips include the number, title and status, with the viewing ring separate from the current-step dot.
Pair a Phone opens the Pair a Phone wizard, which
turns on serving itself when the server is off. A pairing that exists when the step starts shows Done Already,
followed by "Open Stim on your phone: the tutorial workspaces are there".

Add Remote Machine opens the existing wizard using the tour workspace as its
checkout. Once a machine
is approved, the step shows a prompt that names the approved machine, or asks you to
name it when none is recorded. Approval completes the step and preserves its handoff across status polls;
an iOS build offloaded after the step started ticks the optional "Build ran on another
Mac" check. Completed optional steps stay expanded so their handoff remains
visible. The tutorial never starts the server or pairs or grants access.

A step with a prompt shows it with a Copy button. The prompts come from `TUTORIAL_ASKS` in
`tutorial-data.ts`, with the tracked paths substituted.
The panel cannot see a removal refusal from an agent-run command: the finish
step keeps showing the finish prompt. Check the agent's output and revert the
tutorial edit before retrying.
The Make a Change step shows an agent-device card when status reports `agentDevice.installed: false`.
Removals started through Desktop's workspace actions can show a refusal in the panel.

The tutorial panel waits for the first loaded
status snapshot, which supplies live workspaces and archive removal times.
`stim logs --json --follow --grep '\[stim:tutorial\]'` supplies app signals,
and `stim logs --json --follow --source agent` supplies the same records as the
agent feed. Both followers run only while the panel is open on a live tutorial
workspace. The panel reads `desktop.settings.get` for `archive.enabled`; when
unavailable it assumes enabled, then permits finish after a ten-second
disappearance grace period only when a stop was observed. Viewer events and
paired-phone counts come from the existing Desktop controllers. No tutorial
reader touches `$STIM_HOME` directly. During Get the Test App the panel also
checks a few paths in `~/stim-tutorial` (the folder's creation time, `.git/HEAD`,
`package.json`, `node_modules` and npm's `node_modules/.package-lock.json`) on
each status refresh, and Delete the Test App checks whether the clone's folder
still exists.

To render every step, optional phone variants, a waiting timeout, a failure and manual mode in light and dark at 2x:

```sh
STIM_TUTORIAL_SHOTS=/tmp/stim-tutorial-shots swift test --filter TutorialScreenshotTests
```

The fixture test skips without the variable and never starts the CLI or a device.

## Layout

- `Sources/StimKit`: models for the CLI's JSON, the toolchain environment, the CLI and `stim-server` clients, project grouping, warning remedies, the streaming runner, `stim logs` records and the follow runner, process, disk and gc usage, the status machine section, the Machine report, free plan and worktree lifecycle, the pressure plan and activity log, and the crash report scrubber. Unit-tested.
- `Sources/StimStores`: the observable stores whose ordering and staleness rules have tests: the status refresh and watch, the gc report and the action runs. They take the `stim` call, and the clock where they decide staleness, as closures, so `Tests/StimStoresTests` can order results by hand. The DEBUG visual fixture target imports `StimDesktop` to capture its production views.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator, and input through the simulator's CoreDevice HID service (`dtuhidd`) or, when a simulator has none, SimulatorKit's legacy HID client. All of them are private Apple interfaces. Expect Xcode releases to break it.
- `Support/SimFold`: the `sim-fold` helper, an iOS Simulator executable that `scripts/bundle.sh` builds into the app's resources. stim-server builds the same sources to fold an iPhone Duo from the phone.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file, and input through the same endpoint. An emulator without a hardware keyboard (`hw.keyboard=no`) drops key events, so Desktop types on it with `adb shell input`. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- `Sources/WebFrames`: the Stim-owned Chrome page from `stim web`, over the Chrome DevTools Protocol on the loopback `cdpEndpoint` `stim status` reports. It connects only when `SystemInfo.getProcessInfo` names the Chrome pid status reports, attaches to the page's `targetId`, streams it with `Page.startScreencast` and sends `Input.dispatch*` events. Public protocol only; no WebKit view, which would render a different engine than the one agents test.
- stim-server's `stim-frames` helper compiles the shared files listed in `packages/server/helper/desktop-sources.txt`, together with its own `main.swift`. This includes the SceneKit Duo model used for composed mobile frames. Desktop CI compiles it; keep SwiftUI and StimKit dependencies behind module availability checks. Desktop and the helper both send simulator keys through `SimulatorHID.hardwareKey`, and page input through `WebPage`.
- `Sources/StimDesktop`: the SwiftUI app. `Design/` holds the generated tokens, the theme layer over them (`.textStyle(_:)`, `Font.stim(_:)` and the dynamic colors), and the component kit that mirrors the phone's: `.buttonStyle(.stim(_:_:))`, `IconButton`, `Pill`, `Banner`, `ListSection`/`ListRow`, `Card`, `HoverRowStyle`, `StatusDot`, `StimProgressBar`, `InlineEmpty` and the `IconSize` scale. A debug build has **Window > SwiftUI Playground** for production screen fixtures and design tokens.

### Native visual fixture pilot

`swift test --filter VisualFixtureTests` compares production playground bodies
for long-text Notifications at the detail's 440-point minimum, simulator controls
in dark appearance, and the simulator error message in light appearance. It also
compares a failed build history row collapsed and expanded, including its wrapped
diagnostic, at the inspector's 320-point default width.
Archived sidebar and workspace pages have light and dark fixtures with native 1x references; their comparisons skip on 2x until matching references are captured.
To render the complete live and archived workspace pages, including all inspector cards,
empty/expired archives and the build history sheet in light and dark, run:

```sh
STIM_WORKSPACE_SHOTS=/tmp/stim-workspace-shots swift test --filter VisualFixtureTests.testWorkspaceCardScreenshots
```

On a native 1x window, add `STIM_ARCHIVE_REFERENCE_SHOTS=1` to also export the four
archive comparison captures at their reference dimensions. Inspect them before replacing references.

To render the toolbar status pill with a status error inside a real window toolbar item, in light and dark:

```sh
STIM_TOOLBAR_STATUS_SHOTS=/tmp/stim-toolbar-status swift test --filter ToolbarStatusErrorScreenshotTests
```

The test skips without the variable. A toolbar draws a `Label` as its icon only, so check that the images show the message beside the icon.

These fixtures use failed iOS and successful Android build history with phase timings,
a merged PR, ended agents, expired logs and two recording slots. The real archive sidebar,
workspace and build-sheet screens load the sanitized `Fixtures/real-archive` case, including
all five iOS builds, local/remote placement, diagnostics and phase timings, and the
`ios-default` recording spans. These DEBUG screens require the source checkout. They run no backend reads.

The DEBUG fixtures use a fixed date. Captures pin en_US, UTC, InterVariable,
320/380/440 by 640 points and arm64 on macOS 27.0 build 26A428. Native 1x and
2x windows use separate references; Retina reference names end in `.2x.png`.
The three playground bodies retain their 1x references. The two build row cases
currently have only 2x references and explicitly skip on 1x; no downsampled image
stands in for native 1x coverage.
They open only a fixture window, without starting the CLI, server or devices.
The notification view reads its calendar, timezone and locale from the SwiftUI
environment; fixtures supply UTC explicitly, independent of the process `TZ`.

The current macOS 15 CI runner has no matching references and explicitly skips
these image comparisons. This is a local pilot, not CI visual regression coverage.
Issue [#2342](https://github.com/appandflow/stim/issues/2342) tracks matching CI
references, native 1x build rows, Settings window chrome and the remaining
representative cases.
Native Settings tabs move into window chrome; a hosting-view bitmap cannot
faithfully compare that strip. Compact 380-point Notifications is a stress case
below the production detail minimum and is not an accepted reference.

Normal runs never create or update references. To deliberately replace them on
the matching machine, use
`STIM_RECORD_VISUAL_FIXTURES=1 swift test --filter VisualFixtureTests`, then inspect
every changed PNG under `Tests/VisualFixtureTests/__Snapshots__` and rerun without
the variable. SnapshotTesting reports failures with reference, result and difference
images. Its dependency belongs only to the visual test target.

## Native macOS development prototype

If Stim is not installed globally, replace `stim` with `npx stim`.
This package includes explicit development settings for `stim macos`. From
`apps/desktop`, run `stim macos` to build the `StimDesktop` Debug executable and
launch the full app as **Stim Development** in an isolated bundle. It monitors
the regular Stim home with separate preferences; automatic cleanup and notification alerts are disabled
by its development launch arguments. Each `stim macos` copy has its own bundle id and so starts with empty
preferences, which would open the first-run setup guide over the window. The launch arguments in `.stim.json` include
`-skipOnboarding YES` (also `STIM_DESKTOP_SKIP_ONBOARDING=1` in the environment of a local `stim macos`, which
forwards it; a hosted run with `--remote` takes only the launch arguments). With it, Desktop does not open the guide
at launch, does not record it as finished and does not offer the viewer setting, for that run only. Tips and
discovery prompts also stay hidden, because they wait for a finished guide. **Help > Setup
Guide** still opens it. To test the first-run flow, remove the argument from `.stim.json` for that run.
**Window > SwiftUI Playground** opens the
in-memory screen fixtures. Inspect compiler
output with `stim logs --source build`, and use `stim stop` to stop only that
workspace's recorded app. The normal Desktop viewer shows its app/build state,
logs and the local owned app's front window using existing Screen & System Audio Recording permission (Screen Recording on macOS 14).
The preview follows the app's front standard window, with any attached sheet, as the
app opens, switches, closes or resizes windows; without Device Control and Data Access
permission it shows only an app whose one window contains the others. The selection
is shared with stim-server's helper (`OwnedAppWindows` and `OwnedAppWindowReader` in StimKit).
When the app has more than one window, a **Window** menu above the preview offers **Follow
front window** or one window by title; picking a window raises it among the app's windows
and pins the preview to it until it closes or the menu follows the front window again. The
hosted viewer has the same menu during Control, sent as `input.window`.
The viewer skips its own process to prevent recursive previews.
**Open app** verifies and activates that owned app using existing Device Control and
Data Access permission (Accessibility on macOS 26 and earlier) for normal native input;
the captured view is read-only. Background input relay is not included. No permission requests or custom packaging
script is part of the build flow.

On the first native viewer opening, the **Native App Viewer** setup sheet walks through
Screen & System Audio Recording (Screen Recording on macOS 14) and Device Control and
Data Access (Accessibility on macOS 26 and earlier), named for the Mac's macOS version,
one step at a time, then shows a done step. Each step offers a primary request button and
**Open System Settings**; its status refreshes every two seconds while the sheet is open,
with no manual check. **Skip** leaves a permission for later.
You approve normal macOS requests; Stim never resets or automatically grants access.
Use **Permissions** on the app card to reopen setup. A phone-first native viewer
asks the running Desktop host to show the same setup on its next local health refresh.
Grant access to the signed Stim app that started the server, then reconnect the phone
viewer. A server started elsewhere uses that host's permissions; this app's status
alone does not prove that server has access.

For an unreleased CLI, run `pnpm run build` at the
repository root, then set `STIM_BIN` to the absolute `packages/stim-cli/dist/cli.mjs`
path and invoke that executable's `macos` command from `apps/desktop`. The app
inherits the override without changing the installed app's preferences. See [the macOS guide](../../website/docs/macos.md)
for the prototype's settings and limits.
