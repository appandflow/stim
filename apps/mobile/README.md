# Stim Mobile

An Expo app for watching Stim workspaces from a phone. It pairs with
the Stim server on a Mac (`stim-server`, from the `@stim-cli/server` package)
and shows what Stim Desktop shows. A phone the Mac grants control can also
reload and stop a workspace:

- **Home**: one screen for every paired machine; the app keeps a connection
  to each. The **Machines** row has a chip per machine with its connection dot and basic
  usage: live workspaces, the machine's memory used of total (as Activity
  Monitor's "Memory Used" counts it, colored by memory pressure), and the lowest
  free space of the volumes that hold Stim's workspaces, Stim home and the
  simulators. **+**
  pairs another machine. Below, one list of every workspace on every machine,
  grouped by repo. Each repo is a heading with how many of its workspaces are
  live and idle; repos with a live workspace come first, then by name. In a
  repo, live workspaces come before idle ones, each by name and machine, so a
  workspace moves only when it turns live or idle, not while builds run and
  agents attach. A workspace `stim worktree warm` is preparing or has prepared
  counts as live. Each row is titled by its worktree's branch, or the
  worktree's folder when it has no branch, or the project for a main checkout,
  truncated in the middle when long. At the trailing edge, a word says what the
  workspace is doing: **Building iOS**, **Warming** with how long, **Ready**
  until its first run, **Driven** with how long an agent has driven a device,
  **Running**, or **Idle** with how long ago Metro stopped. Below the title, in
  this order and only when there is something to show: the workspace's agent
  session (the same one the Work card shows, running or ended) with how many
  others it has; what is wrong (error count, which opens the logs, a failed
  build while the workspace is live or for a day after, a closed app, **CI
  failing**, and warning or issue counts); while building, the build step with
  its counts, the cache outcome and the elapsed time against the estimate over
  a bar of the planned phases; while warming, the step with an activity
  indicator; the running devices by kind (`2 iOS, Android`) with the tools
  driving them, or how long they have been idle once that is 10 minutes, and
  remote EAS sessions; and the git state: the pull request number colored by
  its state, commits ahead and behind, changed files, **merged into** and **no
  upstream**. The machine's name shows only when more than one machine is
  paired, and the app's folder in its checkout only when a repo's workspaces
  sit in different folders. Metro's port is on the workspace screen. A row is
  one element for VoiceOver and TalkBack, whose label says all of this; a row
  with errors has a **Show errors** action. A machine that is not connected keeps its
  last status: its rows are dimmed with a hollow dot and read "Last seen 3m
  ago", and their activity and build times stop at the moment it disconnected, and
  their colors turn grey. The phone keeps each machine's last status on disk,
  written at most every 5 seconds and when the app leaves the foreground or the
  connection drops, so a cold launch shows those rows, dimmed with "Last seen",
  until the machine's live status replaces them. Forgetting a machine deletes
  its saved status. The first launch of a new app build, update or rollback
  deletes every saved status and the notification state first, so that code
  never reads what an older version wrote; pairings and settings stay.
- **Needs attention**: a strip between the machine chips and the list, hidden
  when nothing is wrong, lists the problems on every paired machine, whatever
  the filters, errors (red) before warnings (amber): a machine that is offline
  or refuses the connection, free disk below 5 GB (the default of Stim's
  refuse floor), a failed last build, errors in the logs since the marker,
  status issues, a running build at more than twice its median, and a live
  simulator or emulator whose app is not running. A workspace that is not live,
  building or holding a remote session, warming and ready ones included, adds only its error issues and a build
  that failed in the last day; the machine status sheet lists every issue. A
  disconnected machine shows only its offline item, because its status is
  stale. It shows three items until you expand it. A machine item opens the machine's status, log errors
  open the workspace's errors, and every other item opens the workspace. A
  **Notifications** row at the bottom of the strip, with the unread count, opens
  the notification inbox when a paired Mac keeps one.
- **Devices**: the Workspaces / Devices toggle under the machine chips switches
  the list to a grid of every running simulator and emulator on every paired
  machine, with its latest frame, model, workspace name and machine, by project
  and workspace name and, inside a workspace, iOS, Android, Web and then physical
  devices, by slot. A tile shows the latest frame, then the platform logo and
  model with the OS or emulator beside it (the line shrinks, then truncates, before it wraps), then one colored state that
  wraps instead of truncating, then the workspace and its project, then the
  workspace's agent session on one line, which opens its Claude link when it has one. The state is
  the first that applies: **Building** with its elapsed time on that device, **Driven by**
  a tool with how long, **App not running**, **Page failed to load**, **Idle**
  with how long once nothing has used it for 10 minutes, **Activity unknown**
  (grey: Stim has no data, not a problem), **In use**, **Leased**
  for a physical device, and otherwise **Running**. The tile names the machine
  only when more than one is paired. A tile never moves because a tool starts
  or stops driving it; its state shows that instead.
  Phones sit two to a row; a device whose frame is wider than tall, such as a
  landscape iPad or an unfolded iPhone Duo, takes a whole row.
  Tapping a tile's screen opens the [device view](#device-view); tapping the
  rest of the tile opens its workspace. The grid follows the machine and
  project filters. Each tile on screen asks for one frame, scaled to fit 640
  pixels, unsubscribes when
  it arrives, and asks again 2 seconds later, backing off after errors. Tiles
  off screen, or under another screen, ask for nothing, and the server's
  capture loop runs only briefly.
- **Machines**: the third destination on home, alongside Workspaces and
  Devices, lists every paired machine with its connection state and endpoint,
  with **Rename** and **Forget** on each row and **Pair** in the header. A
  connected machine's row shows the pairing's scope, **Can control** or
  **Read-only** (see [Read-only pairings](#read-only-pairings)).
  Tapping a machine opens that machine's status. Whichever of the three
  destinations is open is saved on the phone and is what home shows next
  launch.
- **Filters**: the filter button filters the list by machine, by project, by live
  or idle, and to workspaces with errors or with remote sessions. The filters
  are saved on the phone; a dot on the button shows that some are on. Live only
  is the default.
- **Machine status**: tapping a chip shows that machine's page, laid out like
  Stim Desktop's Machine page, read-only. **Now** has the CPU, memory used and
  startup-volume free space charts over the last hour, the live workspaces and
  Stim's share of memory, then **CPU and memory**, the status `machine` owners
  by memory. **Disk** shows the lowest free space against Stim's disk budget
  and a bar of what uses it: Stim devices, Stim caches and outputs,
  `node_modules`, other simulators and AVDs, and runtimes and system images. A
  figure marked ≥ has parts the Mac has not sized; the phone does not size
  AVDs or system images itself, as Stim Desktop does. Then come **Safe to
  free now** (what `stim gc --delete` would free, with the command on the Mac
  that frees each row), **Projects** (repositories and their worktrees, with each
  worktree's `node_modules`, devices, build outputs and logs, and whether it is
  merged, has an open pull request, or is stale), **Simulators and
  emulators** (every one on the Mac, Stim's and **Yours**), **Leased
  devices**, **Runtimes and system images**, **Recordings**, **Caches**,
  **Native builds** (runs, cache hits and time saved per platform), budgets and
  **Needs attention**. Nothing on the page frees, deletes or stops anything;
  it says to manage those on the Mac. The disk sections other than Projects and
  Simulators and emulators come from stim-server's `machine.details`, the `stim
gc --json` dry run and `stim stats --json`, which the server refreshes at
  most once a minute; a server without it shows only what `stim status`
  reports, and says to update. Each section folds from its header, shows its
  first 10 rows with **Show all N**, and the phone remembers both per section.
  The title shows the pairing's scope; a read-only pairing also says what it
  cannot do, with **Allow control**.
  Needs attention groups status issues by workspace, live workspaces first,
  then those with an error, and shows each issue's remedy with **Copy**, which
  copies it as `cd '<workspace>' && <remedy>`. No remedy maps to Reload or
  Stop, so none offers an action button.
- **Menu**: the menu button, or a swipe from the left edge of home, slides
  home right and shows the menu behind it: **Workspaces**, **Devices** and
  **Machines** (the same switch as home's toggle), **Notifications** (see
  [Inbox](#inbox)) with its unread count, **Pair a machine**, and
  **Recent workspaces**, the workspaces most recently live or opened on this
  phone. The button at the bottom shows the number of
  paired machines and opens **About**, with the app version and build, the
  runtime, channel, update and protocol, each paired machine's stim and server
  versions with the protocol, **Report a bug**, which opens a new GitHub
  issue prefilled with those versions and numbered, unnamed machines for you to
  review and submit, and links to the website, GitHub, Stim's own license, the
  open source licenses and App&Flow, then **Open source by App&Flow**, a link to
  the GitHub repository of each App&Flow library in the build, as a sheet sized to its content on iOS over the menu, which stays
  open when the sheet closes. **Copy** puts every version, with the OS, device and
  locale, on the clipboard for a bug report. A tap on home, a swipe left, or Android's back button closes the
  menu. Pairing scans the QR code Stim Desktop
  shows under **Pair a phone**, or takes the endpoint and pairing token typed
  in; the token field is masked, with a button that shows it, and drops
  what a token cannot hold, such as the spaces and line breaks of a paste, as you
  type, without moving the cursor. The device token
  the server issues is kept in the phone's secure storage (Keychain on iOS,
  Keystore on Android) and never shown.
- **Workspace**: under the title, four small cards in a 2x2 grid open more:
  - **Status**: the stage in its color, **Running** ("up 42m", red with the
    error count or a closed app), **Building**, **Build failed** (when the
    newest build of either platform failed, with the platform and when),
    **Warming** (installing dependencies or copying ignored files), **Ready**,
    or **Stopped** (with when Metro stopped when known), cut to one line.
    Under it, on one line, the workspace's CPU (`ps` CPU summed over its
    processes, so above 100% on several cores) and memory from the status
    `machine` owners, and its disk (the worktree plus Stim's build folder) once
    a status watcher measured it. It opens the **Status** sheet: the whole
    stage line, CPU and memory tiles, with sparklines of the last 10
    minutes when the server sends usage history, a process table of the
    workspace's simulators, emulators, Chrome, Metro and build, and a Disk
    card: the total, a stacked bar and a legend row each for node_modules, the
    rest of the worktree and Stim's build output, with the Mac's free space
    below it.
  - **Build**: one row per platform with the Apple or Android glyph, the last
    run's time and whether it hit the cache, **Failed** in red, or the next
    build's prediction from `build.plan` before any run, in grey with a tilde
    and **est.** (`~0:40 est.`) so it never reads as a finished run. A
    workspace that has used neither platform shows both, and the screen asks
    for both predictions when it opens. A row reads **Checking…** while its prediction is pending,
    and **No build** only when there is no run and no prediction. It opens the
    **Build** sheet on that platform.
  - **Logs**: the error count since the marker, with a red dot above zero,
    Metro's port with its health as the dot's color, and the bundle line
    (**Bundling** with Metro's percent, **Bundled in 1.8s** and when, or **Not
    bundled yet** once the server reports bundles). It opens the logs, on
    errors when there are some.
  - **Work**: the workspace's Claude Code or Codex session, the earliest
    started of those running there or that stopped in the last 3 days, so it
    stays the same as processes start and stop, with no time, then the git
    state. With a pull request `stim status` reports, the git line
    starts with the number colored by its state (open, draft, merged, closed)
    and **CI failing** in red when a check fails; the sheet shows every check
    state. Without one, it starts with a branch icon. Then only what is not
    zero or unusual: commits ahead and behind, the count of changed files,
    **merged into** a branch (unless the pull request already reads merged),
    and **no upstream**. Its accessibility label spells out each part. It
    opens the **Work** sheet: every agent session running in the workspace or
    that stopped there in the last 3 days, in the same order, by title and
    tool without times. A Claude Code session with Remote Control connected,
    running or ended, shows as a link that opens it in the Claude app, or
    claude.ai/code without the app. Below come the upstream, ahead, behind, changed and untracked
    files, merged into, and the pull request's title, state, checks and review
    with **Open in GitHub**.

  A card with a problem turns red; there is no separate banner. While a build
  runs, the Build card gives its place to a full-width card: the platform and
  target device, the tool's step with its counts (such as "Compiling 97 of 214
  targets") and the elapsed time against the estimate, a bar of the phases
  sized by the last comparable run, the cache-miss reason, the other
  platform's last build, and the latest compiler line. Then **Devices**, one
  card per device: the model and runtime, and the device's CPU,
  memory and disk; the latest frame the server sends, fitted to the card, with
  **Folded** or **Unfolded** for an iPhone Duo or an Android foldable emulator.
  Tapping the frame opens the [device view](#device-view). A device waiting on
  a build shows the build's step, a device with a failed build and no app shows
  **No app installed**, and a closed app dims the frame under **App closed**, or
  shows an **App closed** pill while there is no frame. A
  warming workspace shows one card while it warms, and a stopped one says that
  nothing is running. Under a running simulator, emulator or Web device that
  Stim owns, the agent row names the driving tool with its latest action and
  how long ago, or **No agent** and how long the device has been idle. It
  opens the **Agent** sheet: the device's actions, newest first, from
  `logs.subscribe` with `sources: ["agent"]`, filtered by all, failed, or the
  most used commands; an action opens the logs with it expanded, and **Open in
  logs** opens them on the Agent source and that slot. The **Build** sheet
  switches between iOS and Android. For the running build it shows the elapsed
  time against the estimate with the miss reason, a checklist of phases with
  the current phase's time and the estimates of those left (from the last
  comparable run), and the live output tail of this build from the build log.
  Otherwise it shows the last build with when it ran, a failed build's compiler
  errors, why it missed the cache with the changed fingerprint sources, and its
  phase times. **Recent builds** lists the platform's last 10 runs from status
  `builds`, newest first, under a bar sparkline of the durations of runs that
  finished (two or more), colored by result. Each row shows the result (a cache
  hit, a cold build, failed, cancelled, or interrupted), its duration, and a
  detail line: the miss reason, a failed run's cache hit, or cache reads off;
  how long ago it ran; and a slot other than the default. Tapping a row shows
  its configuration, fingerprint and phase times, its compiler errors and why it
  missed. **Next build** is what the next build would find, why, and how long
  it should take, from the server's read-only `build.plan`, with the median
  behind its estimate, a refusal's remedy, when it was checked, and **Check
  again**. The screen asks for each platform the Build card shows when it
  opens, one plan at a time, reuses a result for 60 seconds unless that
  platform's last build changes, asks again after a failure or a reconnect,
  ignores a reply that arrives after it closes, and asks nothing while a build
  runs. The **...** menu opens the logs, copies the full path, shows errors, or
  opens the machine's status. With control, it also runs **Reload** and
  **Stop** (see [Actions](#actions)).

- **Logs**: opens from the workspace screen's Logs card, on errors from the
  home screen and notifications, and from the agent feed on the Agent source
  with the tapped action expanded. A header shows Metro's port and a dot for
  whether it runs, and how long the last bundle took when the loaded Metro
  records hold its start and finish. **All**, **Errors** and **Warnings** pick
  the severity: Errors is `stim logs --errors` and counts the errors since the
  last launch, from the status; Warnings counts the loaded warnings. Source
  chips (Metro, App, iOS, Android, Web, Build, Agent) show only the sources the
  workspace runs or that sent records; none selected shows every source. iOS,
  Android and Web split the device logs by their platform. The server does not
  filter by platform or warnings alone, so the phone filters those within the
  newest 5,000 records it loaded. A slot row and a regular expression search
  complete the filters. The list follows new records until you scroll up, and
  again after a filter change. It keeps the newest 5,000, and a tap on a record
  shows its whole message and stack. Each entry shows a severity dot, its
  source and time, then the message; a record with a stack shows its top
  frames, the workspace's own frames in bold, one framework frame dimmed as its
  package, and a count of the rest.
  The records of one failed Expo bundle (`Bundling failed`, the error line with
  its code frame and stack lines, and a failed bundle response) are one entry.
  An entry leads with the error type and message, then the file and line
  relative to the workspace, such as `App.js:12:31`. Tapping it shows the code
  frame. Under Errors, Stim attaches the code frame to the error record.
  When the severity or a search leaves the code frame lines out, or an older
  Stim does not attach them, the app fetches them from the Metro log. **Copy** copies the message and location,
  and **Share** shares the whole entry.

Paths under the Mac's home folder show as `~/...`; the server reports the home
folder in `hello`. Copy path copies the full path.

The design and protocol are in
[docs/specs/2026-09-25-stim-server-design.md](../../docs/specs/2026-09-25-stim-server-design.md).
The phone reaches the Mac over Tailscale with `wss://`; plain `ws://` is
accepted only for a loopback endpoint, which is what the simulator uses with
the mock server.

## Device view

Tapping a running device's screen, on the workspace screen or in the devices
grid, grows it into the full-screen viewer: the thumbnail expands into the
screen's place while the backdrop, title and toolbars fade in, showing the
thumbnail's frame until the stream's first frame arrives. The centered title
is the workspace's name, with the device's model and slot under it. The close
button at the top left, Android's back button, or dragging the screen down
while Control is off shrinks it back into the thumbnail; a short drag springs
back. The route is a transparent modal, so the list stays underneath, and the
thumbnail hides while the viewer covers it. With Control off, pinching zooms the
device's whole frame, its rounded corners and screen together, up to 5 times;
one finger pans it while zoomed, and a double-tap zooms in to 2.5 times where
you tap, or back to fit. A zoomed device can extend past the stage and under
the title bar. While zoomed, the title bar has a dark blurred material on iOS
(SwiftUI's thin material, through `@expo/ui`) and a translucent dark fill on
Android. Dragging down closes the viewer only at fit, and closing while
zoomed takes the device back to fit as it shrinks into the thumbnail. Turning
Control on puts the device back at fit and turns these gestures off, so
touches go to the device. The viewer lays the screen out itself, animating its
position and size rather than a transform, so Android's `SurfaceView` follows
it and the stream stays live through the open, close and zoom animations. With reduced motion on, the viewer
opens and closes without animating. It renders `DeviceScreen` (see Device video): H.264 video at up to
60 frames a second when the server offers it, JPEG frames at up to 30
otherwise, scaled to the screen's pixels (at most 1600 on the longer edge)
and fitted to the device's shape. It is view-only until you turn on **Control**, the button at the top right, which is filled and shows a checkmark while it is on. On a read-only pairing,
Control, the toolbar buttons and **Take over** show disabled, and a banner
says the phone is read-only and how to allow control, with **Copy command**
and **Reconnect** (see [Read-only pairings](#read-only-pairings)). The same
banner appears when the server refuses `control.begin` with `forbidden`, or
ends a session because the Mac took control away.

### Replay

When the Mac has recorded the device, the viewer shows replay controls over
the bottom of the screen. The Mac records while an agent or automation tool
drives the device, or while a phone watches it, and keeps the last 15 minutes
of footage (see `packages/server/README.md`, Recording).

- **The controls.** They fade out 4 seconds after the last touch, and a tap on
  the screen shows or hides them. While you control the device, taps go to it,
  so taking control hides them and a **Replay** button in the toolbar shows
  them. They stay while a finger is on the scrubber, while replay is paused,
  and, unless you control the device, while a screen reader runs. A double tap
  zooms without showing them.
  Reduce Motion shows and hides them without a fade. A device that is not
  streaming shows them under the screen instead.
- **The bar.** It has **Live**, play or pause, previous and next agent action,
  and 1x or 2x. Previous and next always show and dim when there is no earlier
  or later agent action; 1x or 2x is hidden while live and keeps its place. In
  replay, a line under the buttons shows the time of the frame shown. The
  scrubber is linear in time: a second of footage or of a short stop takes the
  same width anywhere on it. A stop longer than a minute takes a minute's width
  and is dashed. The track's length is rounded up
  to a whole minute, with the spare room before the oldest footage, so it grows
  at most once a minute; it shrinks only when the footage is two minutes
  shorter, so pruning at the 15 minute cap does not rescale it. While the Mac
  records the device, the track's right edge is the Mac's time now and the
  footage slides left as time passes; a finger on the track holds it still.
- **Markers.** Agent actions sit on the scrubber in the accent color, errors
  in orange and crashes in red.
- **Moving through it.**
  - Dragging pauses a playing replay and shows the frame under the finger;
    lifting the finger plays on from there when the replay played before the
    drag; a drag that starts live lands paused. The thumb and time follow the
    finger. One seek is out at a time, the
    finger's latest time waits, and seeks go out at most every 50 ms. Dragging
    holds off the viewer's swipe to close.
  - Tapping within 14 points of a marker lands 1.5 seconds before it; tapping
    elsewhere shows the frame there. Either keeps the replay playing or
    paused. Past the newest frame, the newest frame shows.
  - A device that stops while you scrub stays on its recording, and one that
    starts stays on the recording until **Live**.
  - While live, the button shows pause: pressing it freezes on the newest
    frame, in replay. In replay, play plays on at the chosen speed and pauses
    at the newest frame.
  - Previous and next agent action land 1.5 seconds before the agent action
    before or after the frame shown, and keep playing or paused. From live,
    previous goes to the newest agent action.
  - **Live** returns to the live screen.
- **Agent actions.** Under the screen, in portrait, on a simulator, emulator
  or Chrome page, the device's last three agent actions
  show with their age, a failed one in red; in replay, the last three at or
  before the frame shown. Tapping them opens the device's agent actions.
- **While not live.** Control and **Take over** are disabled, and turning
  Control on is refused until Live.
- **Stopped devices.** A device that is not running can still be replayed:
  the first scrub opens the stream on its recording, with no live screen to go
  back to.
- **Indicators.** A red **Recording** chip next to the model shows while the
  Mac records the device. A **Replay off** pill replaces the bar when
  `recording.enabled` is off for the workspace. If the timeline goes away
  while you replay, the bar keeps only **Live**.
- **Where it runs.** The app polls `replay.range` every 10 seconds while the
  viewer is open; seeking goes through `frames.seek` and `frames.live` on the
  same video subscription. Replay needs video: with Data saver, which asks for
  JPEG frames, or when the server answers the subscription with JPEG because
  it has no H.264, the bar is hidden. A server without replay answers
  `unknown-method`, and the bar stays hidden. The timeline math is in
  `src/lib/replay.ts`.

Settings has a **Replay** section with one switch per Mac this phone can
control, **Record on <Mac>**. It reads `recording.enabled` with `settings.get`
and changes it at machine scope with `recording.set`, which deletes the Mac's
recordings when it turns them off. When `STIM_RECORDING` decides on the Mac,
the switch is disabled and says so. The switch sets the machine layer; a repo
or workspace `recording.enabled` on the Mac still wins for its workspaces.

A workspace where `stim web` runs shows its Stim-owned Chrome as a **Web**
tile, in the devices grid and on the workspace screen, labelled with the page's
URL (the in-app route when one moved it after the load, `web.page.route`), with a "Page failed to load" pill when its latest load failed. It opens in
the same viewer, streamed from the page's DevTools screencast as H.264 through
`stim-server`. With Control on, a tap clicks, a drag scrolls, and **Keyboard**
types into the page; the toolbar has **Keyboard** and **Back** (the page's
history back) only, since a page has no home, lock, rotation or hinge. A web
session holds no `stim device lock` lease; a browser tool attached to the
page, such as Playwright MCP, shows as its driver, and Control asks before
taking over from it. Reload in the workspace menu reloads the page with
`stim reload web`.

A physical iPhone, iPad or Android phone the workspace leases with
`stim ios --device`, `stim android --device` or `stim device lock` shows as its
own tile, from the environment's `physicalDevices` in `stim status`, next to
any simulator or emulator in the same slot. The tile names the device and its
model, carries a **Physical** pill and the time left on the lease, and counts
as running while the Mac reaches the device. A lease alone puts the workspace
under Live.

A connected physical iPhone or iPad streams its screen, view only: the tile
and the viewer show it like a simulator's, the viewer has no Control, and the
app sends it no input. The Mac captures it only over a USB cable, so a phone
paired over Wi-Fi shows the server's message instead of a screen. While the
iPhone is locked or QuickTime Player records it, the last frame stays with a
**Screen paused** pill, and the viewer names the reason.

A connected physical Android phone streams like an emulator and opens the same
viewer. With **Control** on, taps, typing, **Home**, **Back**, **Apps** and
**Lock** reach the phone while the workspace holds its lease, and the session
ends when the lease does. The viewer has no rotate buttons for a phone, which
turns only in hand. A physical device is not recorded, so its viewer has no
replay timeline or Recording badge.

A phone tile streams only when the connected Mac's `stim-server` lists that
platform's feature, `physical-ios` or `physical-android`, in its hello
`features`. An older server would ignore `physical` and stream the slot's
simulator or emulator instead, so while connected to one the tile asks for a
`stim-server` update.

The viewer is the one screen on a phone that turns to landscape with the
phone; every other screen stays portrait. In landscape the title stays on
top, and the Control toolbars and the read-only banner move to a column right
of the screen. Turning the phone does not restart the stream, and
touches keep landing where they are drawn once the screen settles into its new
size. The phone does not turn by itself when the device is landscape. On iPad
every screen follows the iPad's orientation; Android tablets follow the phone
rules. On a read-only pairing in landscape, dragging down does not close the
viewer, so the column can scroll.

With **Control** on, the server starts a control session (`control.begin`)
and holds a `stim device lock` lease on the device, so agents see it as
driven. Touches on the frame go to the device as a touch that follows your
finger: a tap, a drag or swipe, or a long press. The toolbar under the screen
is one row that scrolls sideways in portrait. It has **Keyboard**,
which opens the phone's keyboard and types what you type (printable ASCII;
Return and Delete included), **Home**, **Lock**, and on Android **Back** and
**Apps**. While the keyboard is open, a bar above it shows what you typed
since the last Return, with **Done** to close it, and the screen keeps its
size and moves up until its bottom meets that bar, stopping below the title.
It continues with **Rotate left** and **Rotate right**, except that
mobile hides both on an iPhone Duo. When the device
has a hinge, posture buttons follow: **Fold** or **Unfold** on an iPhone Duo,
whichever its latest frame or video shows it is not, and **Fold**, **Half
open** and **Unfold** on a foldable emulator. On an unfolded Duo, touches go
to the inner panel the screen shows. The session ends when you turn
Control off, leave the view, lose the connection, or after 5 minutes without
input; the banner says why.

After a rotate, a note over the screen says "Rotated to landscape" (or
portrait) once the picture turns. When it has not turned after 2.5 seconds,
the note says the screen stayed as it was and that the app in front may not
support rotating; the phone cannot tell that apart from a rotate the device
did not apply.

When status reports the device driven by something else, such as
agent-device, a `stim device lock`, or another phone, a small chip with a
cursor icon next to the model names it. **Control** then asks for confirmation before it
takes over, and starts control anyway; the Mac records the takeover in its
action log. The chip stays while you have control, because that driver can
still send input to the device. When the server refuses
Control because of a driver that status did not show yet, a banner gives its reason
with **Take over**, which asks the same confirmation.

## Actions

`hello` tells the app which actions the Mac lets this phone run. With control,
the workspace **...** menu shows **Reload** and **Stop**:

- **Reload** runs `stim reload` at once. When the workspace has both a running
  owned iOS simulator and a running owned Android emulator, it asks which app
  to reload, because `stim reload` without a platform refuses to choose.
- **Stop** asks for confirmation, then runs `stim stop`.

A toast shows the action while it runs, then its result or the server's error
message. The workspace updates through the status stream.

A read-only pairing shows **Reload** and **Stop** disabled, with the reason,
and **Allow control...**, which explains the grant (see
[Read-only pairings](#read-only-pairings)). When control is taken away while
connected, the server refuses the action and the toast shows why. A server
that predates actions shows neither entry.

## Read-only pairings

`hello` returns the pairing's `capabilities` and the phone's device id. A
pairing without `control` is read-only: Stim Desktop's **Pair a phone** makes
read-only pairings. The machine row, the machine sheet and the **Machines**
section in Settings show the scope while connected: **Can control**,
**Read-only**, or the connection state. In Settings, tapping a read-only
machine explains how to allow control, and tapping any other machine opens
its sheet. Wherever the app
would offer a control action, a read-only pairing shows it disabled with a
short reason, and **Allow control** explains the upgrade: in Stim Desktop on
the Mac, **Settings**, **Phones**, turn on **Allow control** for this phone,
or run `stim-server devices grant <id> --control` with this phone's id. A
connection learns its scope only from `hello`, so **Reconnect** opens a new
connection to pick up the grant. When the server refuses control or an action
with `forbidden`, or ends a control session for that reason, the app
reconnects on its own, so a revoked grant shows as read-only everywhere.

## Notifications

**Settings > Notifications** turns on notifications for what a person
overseeing agents needs: your attention changes the outcome, or work you wait
on started or finished. Each category has its own level:

- **Alert**: a banner and sound (iOS `interruptionLevel` `active`, Android's
  high-importance "Alerts" channel, `attention`).
- **Silent**: no banner or sound; the notification waits in Notification
  Center or the notification shade (iOS `passive`, Android's low-importance
  "Silent" channel, `updates`).
- **Off**: never notifies.

Every category defaults to Silent. Settings saved before levels keep what was
off off, and give each category that was on its default level.

- **Work started**: a workspace began warming, or an agent first drove one of
  its devices. It is grouped per Mac, and opens the workspace or the device
  viewer.
- **Agent looks stuck**: an agent drove the workspace, a device is still up,
  and nothing happened for the **Stuck after** time (15 minutes by default):
  no agent action, build, reload or new log error. App log records do not
  count, since an idle app keeps logging. It opens the device viewer.
- **Agent repeats the same failure**: three or more builds in a row failed at
  the same first compiler error (`Same Swift error 3x at
AppDelegate.swift:71`), or with the same error code, such as an app that
  exits at launch. It opens the build details with their diagnostics.
- **Work finished or PR ready**: the agent stopped after a green build, or the
  workspace's pull request became ready for review or merged. A pull request
  opens on GitHub.
- **Machine in trouble**: disk below Stim's floor, critical memory pressure,
  or a machine that went offline or refuses the pairing. It opens the machine
  sheet.
- **Someone takes over your device**: another phone took over a device you
  control, or an agent started driving it. It opens the device viewer.
- **Needs you**: something only a person can fix, such as a port held by
  another app, a supervisor or browser Stim cannot verify, a signing or
  provisioning failure, an expired device lease or a billable EAS session left
  running. It opens the workspace, or the build for a signing failure. These are
  the strip's items that are not already a stuck agent, a repeated failure or a
  machine problem.

A single failed build, new log errors, a stopped app and a slow build do not
notify; they stay in the **Needs attention** strip. Each notification names the
workspace, or the Mac, and gives a one-line cause. A workspace notifies once
per episode, and a later notification of the same category replaces the
earlier one instead of stacking. What is already true when you turn
notifications on does not notify. **Quiet hours** hold notifications: a
problem that still holds when they end notifies then, and work that started
or finished during them does not. Four or more notifications at once become
one that opens home. The app asks for notification permission when you first
turn them on, never at launch; when it is refused, the switch stays off and
the app offers the system settings.

The app and `stim-server` import the same notification rules from
`@stim-cli/core/oversight`. Notification delivery and preferences stay in the app.

When notifications can arrive:

- **iPhone, from a Mac whose `stim-server` pushes** (#1577): every category
  but a machine going offline arrives while the app is open, in the background
  or closed, as long as `stim-server` runs on the Mac and the phone has a
  network connection. The app registers its Expo push token, the categories
  that are not Off with their levels, its stuck time and its quiet hours in the phone's time zone with each Mac
  over the existing connection; the Mac sends through Expo's push service and
  Apple, with the workspace title, a one-line cause, the screen to open and the
  workspace's path. The app then does not notify those categories
  itself, so nothing arrives twice. A `stim-server` older than levels ignores
  them and alerts for every category but Work started. Push needs the production app and an
  APNs key in the EAS credentials for `com.appandflow.stim` (`eas credentials
--platform ios`, **Push Notifications**); without one Expo refuses every
  push with `InvalidCredentials`, which `stim-server` prints on stderr. Stim
  Dev has no push credentials and notifies only locally, unless Metro starts
  with `STIM_DEV_PUSH=1`.
- **Everything else, and all of Android**: only while the app is open. The
  app notifies from its own connection to each Mac, which iOS closes seconds
  after the app leaves the foreground. What went wrong while the app was
  closed notifies when you next open it, as one summary when there are four or
  more. Android push needs FCM credentials the
  app does not have yet. A machine going offline or refusing the pairing is
  only ever noticed by the phone, so it notifies only while the app is open.
  Only a Mac that pushes looks up pull requests and sees control conflicts;
  without push, a branch counts as merged when git finds it merged into the
  default branch.

### Inbox

**Notifications** in the menu lists what each paired Mac's `stim-server`
logged in the last 7 days (at most 200 per Mac), newest first, in sections by
day and merged across Macs, whether or not it notified this phone. The menu
button and the menu row show the unread count. A row shows the category's
icon, the workspace (or the Mac, for a machine problem), the one-line cause,
the category and the Mac, and how long ago it happened; an entry no phone was
notified of says **Muted** (no registered phone wants its category) or
**Quiet hours**. Tapping a row marks it read and opens what its notification
opens. The filter button marks read what the list shows and filters by
category and, with several Macs, by Mac. Pull down to list again. What a Mac
logged before this phone first listed its history, such as right after
pairing, starts out read.

The app lists each Mac's history with `notifications.list` on every connection
and adds the `notification` events the Mac sends while connected. The history
lives in memory; which entries were read is saved per Mac in the notification
store, which a new build or update keeps, and forgetting the Mac deletes it.
Tapping a push or local notification marks its entry read: a push carries the
entry's number, and a local notification the rule's id, which matches the
newest entry with that id; a tap that launches the app is applied once that
Mac's history is listed. A Mac whose server predates the history
(`notifications` missing from `hello`'s `features`) adds nothing, and without
one the menu has no **Notifications** row. The categories, wording and icons
are the ones Stim Desktop's inbox uses.

A background check was not added: `expo-background-task` runs at most every
15 minutes on Android, and on iOS it schedules a `BGProcessingTask` that the
system runs rarely and at times of its choosing, often only while the phone
charges, and never after the app is swiped away. It would also need the Mac's
token readable while the phone is locked. Push covers the same cases on iPhone
without waking the phone.

## Device video

`DeviceScreen` (`src/components/device-screen.tsx`) shows the stream
`useDeviceStream` (`src/hooks/device-stream.ts`) opens, which subscribes with
`video: ["h264"]`. When the server offers video, each binary
message goes straight to `StimVideoView`, a native view from the Expo inline
module in `modules/stim-video`. On iOS it decodes with
`AVSampleBufferDisplayLayer`, and on Android with `MediaCodec` onto a
`SurfaceView`. The view stays black until the first keyframe. A decoder that
lost its state, for example after the app was in the background, or one
that fell more than three frames behind on Android, drops frames until a
keyframe it asks the server for with `frames.keyframe`. A server without
video sends JPEG `frame` events, which the same component shows as images.
The component fills the bounds its parent gives it, which the viewer sizes to
the device's aspect ratio, and children render over the screen, so touch
overlays share its coordinates. Development builds show H.264 fps, bitrate and latency (arrival
time minus the Mac's capture time) in the corner. The grid tiles keep
requesting JPEG frames.

`modules/stim-video` is native code: pull it, then rebuild the app with
`stim ios` or `stim android`. Fast Refresh does not load it. Its Swift and
Kotlin files are an [inline module](https://docs.expo.dev/modules/inline-modules-reference/):
`experiments.inlineModules` in `app.config.ts` lists `ios/` and `android/`, and
prebuild adds their Swift files to the iOS app target and their Kotlin files to
the Android app. A Swift file that defines a module registers the class named
after the file; a Kotlin one registers its `package` plus the file name. So the
module class in `StimVideo.swift` and `StimVideo.kt` must be named `StimVideo`,
and `StimVideo.kt` needs its `package` line. `fingerprint.config.js` adds both
directories to the fingerprint, which does not hash inline modules on its own.

## Protocol types

`src/protocol/types.ts` holds the protocol messages and the `stim status --json`
and `stim logs --json` payload types the app reads. It is a copy of the types
`@stim-cli/server` and `@stim-cli/core/state` export, not an import:

- The copy describes what the app accepts from any paired Mac, including one
  running an older `stim-server`. Fields that older servers omit, such as
  `issues` or `home`, are optional here and required in the server's types.
- The protocol copy stays independent of the server package build. The app
  imports shared notification rules from the isolated `@stim-cli/core/oversight`
  entry instead of the Node-only core root or state entries.

`packages/server/__tests__/mobile-protocol.test.ts` keeps the copy honest: the
root `pnpm run typecheck` fails when the app would send params the server
refuses, misses a server method, or misreads a result or event the server
sends. The root CI runs when this file changes. The app's `LogRecord` is
narrower than the server's on purpose: the server forwards whatever
`stim logs --json` prints.

## Develop

The app is a member of the repository's pnpm workspace, `stim-mobile`. It
needs Node.js 22. Install from the repository root; `pnpm install` there
installs the app with the published packages, from the one `pnpm-lock.yaml`.

```bash
pnpm install
pnpm --filter @stim-cli/core run build
cd apps/mobile
stim start
stim ios          # or: stim android
pnpm run mock-server
```

To install the app and its build prerequisites, run
`pnpm install --filter stim-mobile... --filter stim-monorepo` from the root,
then `pnpm --filter @stim-cli/core run build`. Rebuild core after changing the
shared rules. Mobile CI and the EAS post-install hook build it before bundling.

A checkout that installed the app with npm before it joined the workspace has an
`apps/mobile/node_modules` pnpm does not clean up. Delete it once, then run
`pnpm install` from the root.

`pnpm run mock-server` serves a Stim server on `ws://127.0.0.1:7787` that
replays payloads captured from a real Mac in `mock-server/fixtures/`: a
`stim status --json` payload taken while `stim ios` was installing, records
from `stim logs --json`, and one simulator screenshot as the frame of every
iOS device. It prints a pairing code; in the app, choose
**Enter the endpoint and token instead** and type the endpoint and token. The
status timestamps are moved forward to the time the server starts, so build
and activity durations read as they did at capture. The workspace that ran
the build carries a remote EAS session added by hand (listed under `edits` in
`status.json`), because the capture machine had none. Two workspaces carry
`lastBuilds` added the same way; the compiled Android one also carries a `missReason`
in the shape of a real miss. `chat-perf-demo` also leases a connected
iPhone and a disconnected Android phone, added by hand in the
`physicalDevices` shape. `a4-running` and `a4-ready` carry ended agent
sessions added by hand in the `endedAgents` shape. `build.plan` answers from
`mock-server/fixtures/plans.json`, a local hit for iOS and a cold build that
generates the native dir for Android, captured from `stim ios|android --plan
--json`, with a `missReason` added to the Android one by hand.
`machine.details` answers from `mock-server/fixtures/machine-details.json`, a
`stim gc --json` dry run and `stim stats --json` payload made for the fixture
workspaces: build outputs, logs and recordings for them, 44 simulators and
emulators with every owner kind, runtimes and system images with unused ones,
14 caches, and merged, stale and open-pull-request worktrees, so the owners,
Safe to free now, Simulators and emulators, Recordings and Caches sections have
more than 10 rows to fold. Its `buildMachines` lists one build machine ready, one
busy and one on another Stim build. Its `stats` carries an `offload` part with placements
here, on `janics-mac-mini` and back from `old-mini`, and `buildClients` lists
one Mac that built here. The `a4-offloading`, `a4-offloaded` and
`a4-offload-fallback` workspaces show an iOS build running on
`janics-mac-mini`, a last build that machine compiled, and a local build after
it was busy.

Device tokens the mock server issues survive its restarts in a file in the
system temporary directory. The mock server grants every phone control and
answers `reload` and `stop` for the fixture workspaces after 0.8 seconds, one
at a time per workspace, without changing the fixtures. The `chat-perf-demo`
workspace runs an iOS simulator and an Android emulator, so reload there asks
for a platform, and the mock server refuses a reload without one, like
`stim reload`. Start it with
`pnpm run mock-server --read` to see a read-only pairing, which gets no
actions.

A phone that asks iOS devices for H.264 gets video from
`mock-server/fixtures/recording-ios.seg`. That is 60 seconds of an iOS
simulator that stim-server recorded while agent-device drove it, stored in
stim-server's segment format, with its agent-action markers in
`recording-ios.json`.

- **Live.** The live stream loops that footage.
- **`replay.range`.** It serves the footage twice, once ending two hours
  before the mock started and once ending when it started, so the timeline
  shows a stopped gap.
- **Seeking.** `frames.seek` and `frames.live` behave like stim-server's.
  Seeking past the footage shows its last frame.
- **The switch.** `recording.set` flips a flag that `replay.range`,
  `settings.get` and every status environment's `recording.enabled` follow.

To try the home screen with two Macs, run two mock servers on different ports.
`--workspaces <regex>` keeps only the workspaces whose path matches, and
`--free-gb <n>` sets the free disk `machine.get` reports:

```bash
node mock-server/server.mjs --port 7797 --name "MacBook Pro" --workspaces tlon-apps
node mock-server/server.mjs --port 7798 --name "Mac mini" --workspaces 'Developer/stim|hinges' --free-gb 14
```

The status also holds eight workspaces under `.worktrees/a4-*` for the
workspace screen, one per stage (running, building, crashed, build failed,
warming, ready, stopped) and one running iOS, Android and Web, with the status
`machine` owners, disk use, bundle state, build detail and pull requests they
would report. Start the server with `--workspaces a4-` to see only those. Each
status event carries a usage history drawn around those owners, and
`logs.ndjson` holds agent actions on their devices. Log timestamps move forward
with the status. Android and Web devices show `frame-android.jpg` and
`frame-web.jpg`.

The mock server answers `notifications.list` with nine entries of every
category, two of them held back (`suppressed`), and sends a new `notification`
event every 2 minutes to each connection that listed.

`--overlay <file>` changes the status while the server runs, to try
notifications. The server rereads the JSON file for each status push (every 5
seconds) and `machine.get`: `freeGb` replaces `--free-gb`, and `environments`
maps a workspace path to fields that replace the fixture's, such as a
`phase` of `warming`, an `ios` device whose `activity` is `driven`, or a
`builds` history with three failed runs.

## Design system

Styles come from the tokens in `src/design/tokens.ts`: spacing, text styles,
radii, light and dark colors, the fixed colors of the device viewer's chrome,
and opacities. The file is plain data. `src/design/theme.ts` turns it into the
[Unistyles](https://www.unistyl.es) light and dark themes, and
`src/design/unistyles.ts` configures them before the router loads. The theme
follows the Appearance setting in Settings.

Write styles with `StyleSheet.create((theme) => ...)` from
`react-native-unistyles`, and text with `Text` from `src/components/text.tsx`
(`variant`, `tone`). Unistyles re-styles only React Native and Reanimated
components when the theme changes. A color passed as a prop to anything else,
such as `Icon`, an `@expo/ui` view or a Gesture Handler list, comes from
`useUnistyles().theme`, which re-renders the component.

The shared components are `Button`, `IconButton`, `Pill`, `Banner`,
`ListSection` and `ListRow`, in `src/components`. A debug build shows all of
them at `stim://gallery`, with a button that switches between light and dark.

## Driving the app

Development builds can start already paired, so a person or an agent driving
the app with agent-device skips the pairing screen:

```bash
cd apps/mobile
pnpm run dev:pair  # or: pnpm run dev:pair --mock, with pnpm run mock-server running
stim start
stim ios
```

`pnpm run dev:pair` runs `stim-server pair --json` against the server running on
this Mac, spends the pairing token the way the app does, and writes the
endpoint and the device token it gets to `.env.local`:

```bash
EXPO_PUBLIC_STIM_DEV_ENDPOINT=ws://127.0.0.1:7787
EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN=...
```

On launch, a development build stores that Mac, named from the server's
`hello`, and shows it on the home screen. Release builds ignore both variables.
`.env.local` is gitignored; never commit a device token. Metro picks up a
rewritten `.env.local`; reload the app after `dev:pair`.

- `--mock` pairs with `pnpm run mock-server` instead of `stim-server`. The mock
  server writes its current pairing code to a file in the system temporary
  directory, and issues and prints a new code after each pairing and every 5
  minutes.
- `--control` pairs with control, so the app can run actions. Without it the
  pairing is read-only. The mock server ignores it.
- `--port <n>` targets a server on another port than 7787, such as a
  `stim-server --port <n>` running with a scratch `STIM_HOME`.
- `--endpoint <url>` sets the endpoint the app connects to, such as the
  tailnet endpoint `stim-server` prints. The default, `ws://127.0.0.1:<port>`,
  reaches the Mac from the iOS Simulator but not from an Android emulator.
  The server binds a device token to the machine that paired it, so a token
  from `dev:pair` works only in a simulator or emulator on this Mac.

`dev:pair` prints the id of the device it paired. Revoke it when you are done:

```bash
stim-server devices revoke <id>
```

## Variants

`app.config.ts` builds one of two variants, chosen by `APP_VARIANT`:

- `production`, the default: **Stim**, bundle id and Android package
  `com.appandflow.stim`, scheme `stim`.
- `development`: **Stim Dev**, `com.appandflow.stim.dev`, schemes `stim` and
  `stim-dev`, and an orange icon with a **DEV** band. It installs next to the
  TestFlight app instead of replacing it.

`stim ios`, `stim android` and the EAS `production` profile build
`production`; the EAS `development` profile builds `development`. Set the
variable for any other command that reads the config, such as
`APP_VARIANT=development npx expo prebuild`.

The development icons in `assets/images/icon-dev.png` and
`assets/images/icon-ios-dev.png` are generated from the production icons.
After changing an icon, regenerate them and commit the result:

```bash
node scripts/dev-icons.mjs
```

## Building the dev app for your own phone

A Release build of the Stim Dev variant runs on an iPhone without Metro and
without TestFlight. `xcodebuild` signs it with the App&Flow team (`R7E8P23K3N`)
through an App Store Connect API key, so Xcode does not need to be signed in
to an Apple ID. Unlock the phone, connect it by cable or on the same network,
and find its UDID with `xcrun devicectl list devices`. Then, from
`apps/mobile`:

```bash
APP_VARIANT=development npx expo prebuild -p ios --clean
APP_VARIANT=development xcodebuild -workspace ios/StimDev.xcworkspace -scheme StimDev \
  -configuration Release -destination id=<UDID> -derivedDataPath ios/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 \
  -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID> \
  DEVELOPMENT_TEAM=R7E8P23K3N build
xcrun devicectl device install app --device <UDID> \
  ios/build/Build/Products/Release-iphoneos/StimDev.app
rm -rf ios
```

`xcodebuild` reads `app.config.ts` again during the build, so it needs
`APP_VARIANT` too. Remove `ios/` at the end: Stim records the prebuild it ran
for this workspace and does not notice a hand-made one, so the next `stim ios`
would build and cache the Stim Dev project as the production app.

The key's role must reach Certificates, Identifiers & Profiles: Admin, or
App Manager with that access. With it, Xcode creates the
development certificate, registers the bundle id, and adds the phone named by
`-destination` to the team's devices, then refreshes the team provisioning
profile. `-destination generic/platform=iOS` also signs, but registers no
device, so the app installs only on phones the team already has.

A Release build ignores `.env.local`; pair it with the QR code or the
endpoint and token, as with the TestFlight app. It gets updates published
to channel `development` (see [Updates](#updates)). `pnpm run dev:pair` is for
development builds on this Mac's simulators and emulators.

## Updates

Release builds run `expo-updates` against EAS Update. The production variant
reads channel `production`: TestFlight builds from the EAS `production`
profile, `preview` builds, and local Release builds. A Release build of the
Stim Dev variant, such as the phone build above, reads channel
`development`. The channel is `updates.requestHeaders` in `app.config.ts`, so
a local `xcodebuild` gets it too; `eas.json` sets the same `channel` on the
`production` and `development` profiles. Debug builds, including the EAS
`development` development client, load JS from Metro and fetch no updates on
launch.

`runtimeVersion` uses the `fingerprint` policy: the runtime is a hash of the
native project inputs. A JS-only change keeps the runtime, so an update
reaches the builds already installed. A change to native code, a native
dependency, `eas.json`, an asset the config names, or the native parts of
`app.config.ts` gives a new runtime, which needs a new build; installed
builds ignore updates for another runtime. `xcodebuild` computes the
fingerprint from `app.config.ts` during the build, which is why the phone
build passes `APP_VARIANT` to it. The two variants have different bundle ids,
so they never share a runtime.

The app checks for an update on every launch without waiting for it: it
starts the update it already has and downloads a newer one in the background.
This is the `expo-updates` default. A monitor that opens to glance at a build
should open at once, even on a slow or captive network, and one launch on the
previous JS changes nothing on the Mac. A resumed process never launches
again, so the app also checks whenever it returns to the foreground, at most
once a minute. Once an update has downloaded, the menu lists
**Restart to update** under **Pair a machine**; tapping it asks
before restarting into the new JS, and a restart that fails says so. Nothing
restarts the app on its own.

**About** shows the running update's short id and when it was published, or
**Built-in** when the app runs the JS it was built with. Debug builds show
**Built-in** too.

Publish an update by hand from `apps/mobile`:

```bash
eas update --channel production --environment production --platform ios --message "<what changed>"
APP_VARIANT=development eas update --channel development --environment development --platform ios --message "<what changed>"
```

`eas update` computes the runtime from the checked-out project, so run it on
the commit the builds were made from, plus JS changes only.

## Crash reporting

The app reports JS errors and native crashes to Sentry
(`@sentry/react-native`) only when its JS was bundled with
`EXPO_PUBLIC_SENTRY_DSN` set. The DSN is not in the repository: EAS builds
and updates read it from the EAS `production` and `preview` environments.
Without it, as in local builds, `stim ios`, CI and forks, Sentry is not
initialized and the app sends nothing. Sentry starts from JS in
`src/lib/sentry.ts`, the first import of `index.ts`, so a native crash before
the JS bundle runs is not reported. React Native sends an error thrown while
rendering straight to its native exception handler rather than through
`ErrorUtils`, so Sentry reports a render error only because the root
`ErrorBoundary` in `src/app/_layout.tsx` is wrapped with
`Sentry.wrapExpoRouterErrorBoundary`.

Reports carry no personal data: `sendDefaultPii` is off, there are no
screenshots, view hierarchy, session replay or performance tracing, and the
native SDKs record no network breadcrumbs. Before an event or breadcrumb
leaves the phone, `src/lib/sentry-scrub.ts` replaces URLs (the paired Mac's
`wss://` endpoint among them), IP addresses, `*.ts.net` and `*.local` host
names, Expo push tokens, pairing and device tokens, and `/Users/<name>` home
folders. Events the native SDKs build themselves, such as native crashes and
app hangs, skip that scrubbing, but carry only the JS breadcrumbs already
scrubbed. Each report names the release
(`com.appandflow.stim@<version>+<build>`), the build number as `dist`, and the
running update in the tags `expo.updates.update_id`, `expo.updates.channel`
and `expo.updates.runtime_version`.

With `SENTRY_AUTH_TOKEN` set, a Release build uploads its JS source maps and,
on iOS, its dSYMs; without it, the build prints
`SENTRY_DISABLE_AUTO_UPLOAD=true, skipping ...` and succeeds.
`plugins/sentry-upload-only-with-token.js` makes that decision when the build
runs, not in `app.config.ts`, so the token does not change the fingerprint.
The release workflow uploads an update's source maps after `eas update` when
the `SENTRY_AUTH_TOKEN` secret exists, and skips that step otherwise.

### Setup

The Sentry organization is `stim-rn` and the project `stim-mobile`.

1. From `apps/mobile`, store the DSN, the slugs and an organization auth token
   (Sentry **Settings**, **Developer Settings**, **Organization Tokens**) in
   the EAS `production` and `preview` environments. The token is `secret`,
   which only EAS builds read; `eas update` reads the plaintext DSN:

   ```bash
   eas env:set --environment production --environment preview --name EXPO_PUBLIC_SENTRY_DSN --value '<dsn>' --visibility plaintext
   eas env:set --environment production --environment preview --name SENTRY_ORG --value stim-rn --visibility plaintext
   eas env:set --environment production --environment preview --name SENTRY_PROJECT --value stim-mobile --visibility plaintext
   eas env:set --environment production --environment preview --name SENTRY_AUTH_TOKEN --value '<auth token>' --visibility secret
   ```

2. In the GitHub repository, **Settings**, **Secrets and variables**,
   **Actions**: add the secret `SENTRY_AUTH_TOKEN` and the variables
   `SENTRY_ORG` (`stim-rn`) and `SENTRY_PROJECT` (`stim-mobile`).
3. Build and submit a new TestFlight build. The DSN reaches only builds and
   updates bundled after step 1.

## Open source licenses

Settings > More > **Open source licenses** lists Stim's own license and every
npm package compiled into the app or linked natively, each with its version,
license and repository link. Tapping one shows the license text. The list comes
from `src/generated/licenses.json`, which `pnpm run licenses` writes: it runs
`expo export` for iOS and Android with source maps, takes the packages the
Metro bundles pull in, adds the direct dependencies of `package.json`, and reads
each package's `package.json` and license file. A package that ships no license
file uses the text of another bundled package from the same repository under the
same license, or its file in `scripts/licenses`, and otherwise shows none. Identical texts are stored once. The
list does not include native libraries that no npm package vendors, such as the
Hermes engine and CocoaPods or Gradle transitive dependencies.

Run `pnpm run licenses` and commit the file after a dependency change: a change
to the dependencies or `pnpm-lock.yaml`, including an automated update, fails the
Mobile workflow until the file is regenerated. `scripts/licenses/<name>.txt`
holds the upstream license text of a package that ships no license file; the
generator prints the packages that still have none.
`pnpm run licenses:check` regenerates the list and fails when the committed file
differs; the Mobile workflow runs it. The page is JavaScript and JSON only, so
it changes no native fingerprint and ships over the air.

## Localization

The app is localized with [Lingui](https://lingui.dev) 5. Its messages are English only
for now: the source locale `en` has no translations. Mark every string a person
reads: `<Trans>` for text in JSX, `t` from `@lingui/core/macro` for props and
strings built outside JSX, including in `src/lib`, and `<Plural>` or `plural`
for counts. `@lingui/babel-plugin-lingui-macro` compiles the macros, and
`src/intl/i18n.ts` loads the compiled catalog before the router, so a `t` at a
module's top level also works. Jest loads the same file through `setupFiles`.

`pnpm run intl:extract` writes the messages to `locales/en.po`, and
`pnpm run intl:compile` compiles them to `locales/en.ts`, which the app
imports. Commit both after changing a message: `pnpm run intl:check` runs the
two and fails when either file changes, and CI runs it. The catalogs live
outside `src` because the extracted messages carry the non-ASCII characters
that `src` writes as `\uXXXX` escapes.

Dates, numbers, sizes and durations go through `src/intl/format.ts`
(`formatDateTime`, `formatDuration`, `formatBytes`, `formatSize`,
`formatMemoryMb`). Dates follow the device's region, as `toLocaleString()`
did; sizes follow the messages' language, so they read `3.3 GB` in any region. Hermes has no
`Intl.PluralRules` or `Intl.Locale`, so `src/intl/polyfills.ts` loads the
formatjs polyfills with English plural rules only; each installs only when the
API is missing. Hermes on iOS also rounds half to even and ignores
`style: 'unit'`, so sizes round with `toFixed` and carry their unit in the
message. The shared `@stim-cli/core/oversight` rules stay unlocalized; the
app localizes their notifications in `src/lib/notifications.ts`.

The `lingui/no-unlocalized-strings` lint rule, through oxlint's `jsPlugins`,
fails on an unmarked string anywhere in `src`. It skips single lowercase words,
which are mostly identifiers, so wrap a lowercase word a person reads by hand;
and it skips strings that start with `stim `, `stim-server `, `cd ` or `at `
(commands and stack frames), and a string assigned to a `SCREAMING_CASE`
constant, for a value sent to the server. It is off for tests, for `src/design` and
`src/lib/agent-prompts.ts`, which Stim Desktop's generator imports without the
Lingui macros, and for the components
that hold SVG paths.

## Checks

```bash
pnpm run format:check
pnpm run lint
pnpm run intl:check
pnpm run typecheck
pnpm test
pnpm run licenses:check
```

Run `pnpm run knip` from the repository root instead of from `apps/mobile`: it
covers the app as one workspace of the root `knip.json`, so it reports unused
files, exports and dependencies across the app and the rest of the repository.
knip's Expo, Jest, Metro and Babel plugins find the `src/app` routes and the
config files; the workspace entry adds the config plugins, the mock server,
the scripts and `fingerprint.config.js`. It ignores `expo-screen-orientation`,
which the app
never imports: its iOS app delegate is what applies the per-screen
`orientation` of `src/app/_layout.tsx`.

The app uses TypeScript 7, the same version as the root. TypeScript 7 has no
JavaScript compiler API, so Expo loads `app.config.ts` by stripping its types
with Node, which does not add default-import interop. Import only types in
`app.config.ts`, and name config plugins by string in `plugins` instead of
importing them (expo/expo#49564).

`pnpm run lint` runs oxlint with `.oxlintrc.json`, which includes oxlint's React
Compiler rules. A component or hook the compiler would skip fails lint, so fix
the code rather than suppress the rule. oxlint ports the compiler from React's
main branch, while the app builds with `babel-plugin-react-compiler` 1.0.0, so
a few 1.0.0 bailouts pass lint. One is a conditional, `??`, `||` or optional
chain inside a `try` block.

`.github/workflows/mobile.yml` runs them for changes under `apps/mobile` and to
the root `knip.json`, `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`.

`src/app-boot.test.tsx` is the boot test. It renders the whole app, from
`src/app/_layout.tsx` down to home, in Jest. The phone starts from what the
previous release stored: a paired machine, that machine's cached status from an
older `stim`, notification preferences and state in their old shapes, and that
release's marker. The test checks that the launch clears the cached status and
the notification state, and keeps the pairing and the
preferences. The machine then connects to a fake `stim-server` that serves
`mock-server/fixtures/status.json`, and the app turns `active` the way iOS does
after launch. The test fails when React reports an error or anything throws,
so it catches JS that throws while launching over an earlier release's state,
on the screens it renders. Reanimated, the drawer and Lottie are stubbed, so
the test does not cover animations or native code.

When a change stores something new on the phone, decide whether it is derived
data, which `clearDerivedDataOnChange` in `src/lib/derived-data.ts` must clear
on a new build or update, or user data, which must stay; then seed the previous
shape in `seedPreviousInstall`.

## Ship to TestFlight

The app ships to TestFlight with EAS, under the App&Flow Expo account
(`appandflow`) and the App&Flow Apple Developer team. `eas.json` has three
build profiles:

- `development`: a development client of the Stim Dev variant (see
  [Variants](#variants)), distributed internally.
- `preview`: a release build of the production variant, distributed
  internally. It replaces the TestFlight app on a phone and gets updates from
  channel `production`.
- `production`: an App Store build on update channel `production`. EAS owns the build number
  (`appVersionSource: "remote"`) and increments it on every build. The
  marketing version is `version` in `app.config.ts`.

`development` and `preview` builds install only on devices registered with
`eas device:create`.

EAS installs from the repository root with pnpm. Each profile sets `pnpm` to
the root `packageManager` version: the EAS images ship pnpm 11, which cannot
switch to pnpm 12.0.0 on its own (pnpm/pnpm#14346). Change both together.

The app declares `ITSAppUsesNonExemptEncryption` as `false`: it uses only the
TLS that iOS provides, so App Store Connect does not ask the export compliance
question for each build.

### One-time setup

Run these from `apps/mobile` with the EAS CLI (`npm install --global eas-cli`,
or prefix each command with `npx`).

1. Log in to Expo with an account that belongs to the `appandflow`
   organization:

   ```bash
   eas login
   eas whoami
   ```

2. Create the EAS project under the App&Flow owner and link it:

   ```bash
   eas init --account appandflow
   ```

   This prints the `owner` and `extra.eas.projectId` to set in
   `app.config.ts`; commit that change. If the project already exists on expo.dev, link it with
   `eas init --id <project-id>` instead.

3. Create the App Store Connect app record, if it does not exist yet. In
   [App Store Connect](https://appstoreconnect.apple.com), under the App&Flow
   team, open **Apps**, choose **+**, then **New App**: platform iOS, name
   `Stim`, bundle ID `com.appandflow.stim`, and any SKU. If the list does not
   offer the bundle ID, run step 4 first, which registers it, or register it
   under **Certificates, Identifiers & Profiles**. `eas submit` can create the record only when it signs in with an
   Apple ID; an App Store Connect API key cannot create apps.

   Copy the app's **Apple ID** (a number, under **App Information**) into
   `eas.json`:

   ```json
   "submit": { "production": { "ios": { "ascAppId": "<Apple ID>" } } }
   ```

4. Set up signing and submission credentials:

   ```bash
   eas credentials --platform ios
   ```

   Choose the `production` profile, sign in with an Apple ID on the App&Flow
   team, and let EAS create or reuse the distribution certificate and the App
   Store provisioning profile. In the same menu, under **App Store Connect:
   Manage your API Key**, add an API key so `eas submit` runs without Apple ID
   prompts. To create the key yourself: App Store Connect, **Users and
   Access**, **Integrations**, **App Store Connect API**, a key with the **App
   Manager** role; keep the downloaded `.p8` file out of the repository.

### Each release

`.github/workflows/mobile-release.yml` releases from `main`. It runs in the
`release` environment and signs in to Expo with the `EXPO_TOKEN` secret.

- **Actions**, **Mobile release**, **Run workflow**, with a `mode`:
  - `auto`, the default: computes the iOS fingerprint of the checked-out
    project (`npx expo-updates fingerprint:generate --platform ios`) and
    compares it with the runtime of the latest finished `production` build.
    The same runtime publishes an update; a different one, or no build with a
    runtime, builds and submits.
  - `update`: publishes an update to channel `production` with the commit
    subject as the message. Use it only when you know the change is
    JS-only; an update for a runtime no build has reaches no one.
  - `build`: builds with the `production` profile and submits to
    TestFlight (`eas build --auto-submit`).
  - `rollback`: points channel `production` back at the JS embedded in the
    build (`eas update:roll-back-to-embedded`). By default it uses the runtime
    of the latest finished production build; the `runtime` input names
    another one. See [Roll back a bad update](#roll-back-a-bad-update).
  - `republish`: publishes the update group named by the `group` input again
    on channel `production` (`eas update:republish`), so installed builds go
    back to that update.
- A `mobile-v<version>` tag on `main` always builds and submits. The version
  must equal `version` in `app.config.ts`, so raise it first.

Every mode except `rollback` and `republish` runs the unit tests, the boot test
included, before the step that loads `EXPO_TOKEN`. A failing test stops the run
before anything is published or built. `rollback` and `republish` skip them
because they must still work when `main` is broken.

`eas build` records as the build's runtime the fingerprint computed on the
machine that starts it, so a build from this workflow and the fingerprint
`auto` compares are both computed on the Linux runner. A build started by hand
on a Mac records the Mac's fingerprint; if a platform difference ever made
the two disagree, `auto` would build for a JS-only change. `auto` compares
with the newest production build from any branch, so start production builds
only from `main`.

`--auto-submit` and `eas submit` read the App Store Connect API key from EAS
credentials, not from GitHub. Store it once, from `apps/mobile`:

```bash
eas credentials --platform ios
```

Choose the `production` profile, then **App Store Connect: Manage your API
Key**, **Set up your project to use an API Key for EAS Submit**, and use an
existing key: give the path to its `.p8` file, its key ID and issuer ID.
EAS keeps the key on expo.dev for the Expo account; the `.p8` stays out of
the repository.

To release by hand instead:

```bash
eas build --platform ios --profile production --auto-submit
eas update --channel production --environment production --platform ios --message "<what changed>"
```

The build appears in TestFlight after Apple finishes processing it, usually
within 30 minutes. Add testers under the app's **TestFlight** tab. Raise
`version` in `app.config.ts` for a new marketing version; build numbers need no
change.

### Roll back a bad update

An update reaches every installed build on its runtime the next time the app
launches, and it runs on the launch after that. A bad update shows up as:

- the app closing at launch, or showing an error screen, on phones that were
  fine before;
- crashes in `eas update:view <group> --insights` for the newest group.

Find the newest groups and the one that was good before the bad one:

```bash
cd apps/mobile
eas update:list --branch production --limit 10
eas update:view <group> --insights
```

Roll back to the JS embedded in the build. This works whatever is on the
channel, and needs no group id:

```bash
gh workflow run mobile-release.yml --ref main -f mode=rollback
gh workflow run mobile-release.yml --ref main -f mode=rollback -f runtime=<runtime>
```

Or go back to a specific update that worked:

```bash
gh workflow run mobile-release.yml --ref main -f mode=republish -f group=<group>
```

Both runs wait for approval in the `release` environment. They queue apart
from the publishing modes, so a build in progress does not hold them up. A
publishing run that is still in progress or waiting for approval can publish
after the rollback and undo it, so cancel it first
(`gh run cancel <run-id>`). Approve them as in
step 7 of [RELEASE.md](../../RELEASE.md#4-cut-the-release), with the run id
from `gh run list --workflow mobile-release.yml --limit 1`. The run log's
notice names the runtime and group it acted on. `republish` warns when the
group's runtime is not the latest production build's, because only builds on
that runtime get it. When the group is on a branch other than `production`,
`republish` publishes it to channel `production` with `--destination-channel`.

Phones pick up the rollback when a launch checks for updates, and run it on the
launch after that. A phone that crashes at launch may need a few launches.

After a rollback, fix the bug on `main`. The next `auto` run publishes the fix
as a new update, which replaces the rollback. Build for TestFlight (`mode=build`)
instead when the fix changes native code or dependencies. Do the same when the
embedded JS itself is broken, because then a rollback cannot help: `auto` builds
only when the runtime changes, so pick `build` explicitly.

The workflow has no staging channel. Publishing to a staging branch first and
promoting it with `republish` would need a build that reads that channel,
installed on a phone someone checks before promoting. Without that build,
staging adds a step and verifies nothing. A simulator run of each update on a
macOS runner, using a production-runtime simulator build per runtime, would
catch native and render crashes. It would also cost a macOS runner and an EAS
simulator build for every runtime. The boot test catches JS errors on launch,
which covers this class of crash, at no extra cost. To check an update by hand
before publishing it, run a Release build of the same commit on a simulator
with `stim ios --configuration Release`. Stim puts the current JS into the
cached build, so this works without Metro. Then read `stim logs --errors`. A
Release build ignores `.env.local`, so it starts with no paired machine unless
you pair it.
