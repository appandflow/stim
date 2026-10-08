---
title: 'Stim Desktop'
description: 'A macOS app that shows every workspace, device and build Stim runs'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

Stim Desktop is a macOS app for watching and steering the work Stim runs:
every workspace with its live simulators and emulators, builds, logs and the
agents driving them. It runs `stim` for you, so it needs the CLI from
[Getting started](./getting-started.md).

![The workspace page in Stim Desktop: two iPhone simulators side by side with the build stage, git branch and pull request above them](/img/desktop/workspace.webp)

Apps in one linked worktree share a detail page and one sidebar row, with platform
badges for each app. Selecting the row opens the page; a link or action for one app
scrolls to that app. The row's context menu has per-app submenus, **Stop all** and
**Remove worktree**. The canvas combines all devices, with one stage and git chip. Build cards keep platform titles, adding project
subtitles only for repeated platforms. The inspector aggregates resources,
labels each Metro and deduplicates agents. The logs drawer follows app selection
and has an **App** picker. The actions menu keeps each app's commands plus
**Stop all** and one **Remove worktree** action.

## Download

<a className="button button--primary button--lg" href="https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg">Download Stim.dmg</a>

Open the disk image and drag **Stim** to **Applications**. Or use Homebrew:

```sh
brew install --cask appandflow/tap/stim
```

- macOS 14 or later, on Apple silicon or Intel.
- The `stim` CLI, on your login shell's `PATH` or set in **Stim > Settings >
  App**. See [Install Stim](./getting-started.md#install-stim).
- Xcode 27 for live simulator screens.

Hosted iOS simulators and Android emulators started with
`stim ios --remote <machine>` or `stim android --remote <machine>` appear as device
tiles with an **on &lt;machine&gt;** label. You view and control them through this
Mac's stim-server relay. Touch and text reach the
hosting Mac; controls that need a local simulator, and replay, are hidden.
The tile reports connecting, unavailable or stopped sessions. Android hardware
buttons also use the relay; rotation and posture are unavailable.
On a remote Mac, Stim Desktop shows build requests from other Macs as a
notification and inbox entry with **Allow** and **Deny**. It watches a
stim-server already running there even when **Serve to phones** is off.
Placement is set by config or agents: use
`stim settings set ios.remote auto --scope machine` (or `android.remote`; a
workspace, repo or committed value overrides the machine default),
or per run `stim ios --remote auto` / `stim ios --remote <machine>`.
Desktop passes no `--remote` flag for new iOS and Android runs, so the project's
settings apply. Recorded hosted sessions stay fixed until `stim stop`.
When a device is not on this Mac, its tile, workspace page, viewer toolbar and
sidebar row show **on &lt;machine&gt;**, with the placement reason as hover text.
Local devices show no placement label. See [iOS on an approved Mac](./owned-devices#run-ios-on-another-mac).

Desktop uses the non-empty launch `STIM_HOME`, then the login shell's value, then
`~/.stim`; **Settings > App > Stim CLI** shows the home, and private-home copies
refuse servers for another home.

The app updates itself. Release builds report crashes to Sentry with file paths,
host names, addresses and credentials removed, and send no screenshots or
performance traces. Every release is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true).

## Tutorial

Open **Help > Stim Tutorial…**, or choose **Take the tutorial** on the setup
guide's last screen. The trailing tutorial column replaces the inspector;
**⌘⌥I** returns to the inspector. Starting the tutorial with your agent also
opens the panel once for that tutorial path, after any open sheet closes.

<img src="/img/desktop/tutorial-panel.png" alt="Stim Tutorial panel showing the agent actions step" width="320" />

<PromptBox title="Run the Stim tutorial">
{`Run the Stim tutorial.`}
</PromptBox>

The panel follows a small iOS app in its own worktree. It shows:

- **Create the tutorial / Workspace in sidebar:** the run prompt and the new workspace.
- **First iOS build:** build progress, phase timings and build failures.
- **Rebuild from cache:** the repeated build's cache hit or miss reason.
- **Live view and control:** Open the live view, then tap Log an error.
- **App logs:** find the tagged error; **Crash me** and **Slow request** are optional checks.
- **Agent actions and replay:** watch the agent drive the simulator and inspect its recording. If recording is off, the panel points to Settings.
- **Fast Refresh:** change the title to purple and watch the app update; new errors point to Logs.
- **Watch on your phone:** **Pair a phone** opens the Pair a Phone wizard, which turns on serving itself. An existing pairing shows **Done already**, then "Open Stim on your phone: the tour workspace is there". **Skip** stays available.
- **Build on another Mac:** **Add remote Mac** opens the wizard for the tour workspace. With no machine configured, **Skip** is the primary action. Approval completes the step and reveals the prompt below; name the approved machine to your agent. An iOS build offloaded after this step started ticks **Build ran on another Mac**.
- **Finish and archive:** revert the tutorial edit, stop, then remove only its worktree. **Open Archived** opens the same workspace page as a read-only archive, with retained build history, logs and recordings. Archived sidebar rows keep the live repository/worktree grouping and app labels. The page also shows removal and last activity, retention dates and sizes, build totals, final branch head, PR number and title (only Merged is treated as a final state), and ended agent sessions.

<PromptBox title="Try an approved remote Mac">
{`Continue the Stim tutorial: machine`}
</PromptBox>

Completed optional steps stay expanded so you can follow the phone handoff or
copy the machine prompt. The tutorial does not start the server, pair phones,
grant access or run builds.

Accent rings and short callouts point to existing controls without covering the
app with a dimming layer. **Show me** selects the tutorial workspace when its
control is not visible. Build details and the device viewer keep their own
highlights when opened.

Progress stays in this app's preferences. Closing the panel preserves it;
Help reopens it. At launch an unfinished tutorial resumes when Stim still lists
its path, and an archived tour opens as complete. **Skip step** advances without
waiting for a signal. **Mark done** appears after two minutes. The **…** menu
also offers **Restart tutorial**, which shows a restart prompt and resets
checkpoints when the tracked tour disappears and returns, or its oldest build
starts after Restart. A newer phase timestamp alone does not reset progress.

Choose **Show commands instead of prompts** for manual mode. Copy the commands
into your terminal, including the app-file heredocs. After creating the base
app, expand **First iOS build** to copy the worktree and build commands; the
workspace checkpoint ticks once those run. Paths come from the tour's
repository and agent-device state directory when known; the default base is
`~/stim-tutorial`. A machine command needs the name of an approved Mac.
Copying manual commands does not start the three-minute workspace warning.
Desktop never executes these tutorial commands. To read the complete manual:

<StimTabs code={`stim guide tutorial manual`} />

Desktop reads the archive setting through `stim settings --json`. If that
setting cannot be read, finish waits ten seconds after a previously stopped
workspace disappears before completing without an archive. In that fallback, a
workspace that vanishes without an observed stop offers Restart.

The panel cannot see a removal refusal from a command run by your agent. If
removal is refused, the finish step keeps showing the finish prompt; check the
agent's output and revert the tutorial edit before trying again. Desktop can
show refusals for removals started from its own workspace actions.

## What it does

:::note[Phone app feature flag]
Stim Desktop hides everything about the phone app unless the **Phone app**
feature flag is on: the Phones page, **Serve to phones**, pairing, the phone
steps of the setup guide and tutorial, and phone suggestions. Turn it on in
**Settings > Advanced > Feature flags**. A Mac that already serves phones or has
a paired phone starts with it on. Turning the flag off revokes no pairings;
Desktop's own `stim-server` then listens on loopback only.
:::

Desktop runs its own `stim-server` whenever it is open, on loopback only (it refuses
anything a `tailscale serve --https` route forwards to it), with no switch. Replay, the diff viewer, archived logs, hosted views and recordings use it. If
a stim-server already serves the same Stim home, for example the `stim-server
service` LaunchAgent on a Mac that hosts for others, Desktop uses that one and never
stops or reconfigures it. When the server cannot start, a warning icon in the
sidebar footer says why; click it to retry. Serving phones over the tailnet stays
opt-in (**Serve to phones**, with the Phone app flag on).

- **Every workspace at a glance.** Each workspace shows its stage (warming,
  building, running, failed), its devices side by side, and its branch and pull
  request status.
- **Hide a workspace.** **Hide** in a sidebar row's context menu or the page's
  "..." menu moves a worktree, a multi-app worktree, a Not set up worktree or an
  archive out of the list. Turn on **Hidden** in the sidebar's Status filter, or
  use the "3 hidden - Show" line at the foot of the sidebar, to see them again;
  **Hide again** turns it off. Hidden is not part of All. A hidden workspace
  that becomes active (its dev server runs, a build starts, a device boots or
  connects, or a run starts) shows again. The list lives in this Desktop's own
  preferences on this Mac and is not shared with the phone app.
- **Watch and take over a device.** Open a device to see its screen large,
  take it over with your mouse and keyboard, and read what the agent did
  and when. Hardware, rotation and posture controls sit in groups below the
  screen, wrapping when space is tight.
  Local iOS input connects in the background and drops clicks and keys while
  the screen shows **Connecting input** or **Input unavailable**. Lookups time
  out after 10 seconds; Desktop stays responsive and waits for CoreSimulator's
  blocked call to return before trying again. Rotation, hinge input and
  development controls share that per-device guard.
  Legacy input stays usable during background retries. Cancelling a development
  request stops waiting while its lookup guard remains held until CoreSimulator returns.
- **Replay.** Scrub back through a device's recent screen, with agent actions
  and errors marked on the timeline.
- **Simulator options.** While **Control** is on for a running local iOS
  simulator, change appearance, text size, contrast, motion, transparency and
  button borders in its options popover. Values come from the selected device;
  **Refresh** reads changes made elsewhere. Unsupported options say
  **Unavailable**. Requires Xcode's simulator appearance API; audio, location,
  VoiceOver, color filters and Liquid Glass options are not included.
  Without Control the popover shows only **Show device frame**. Its **Development** section also offers **Slow animations** and **Shake**
  where CoreSimulator supports them. Slow animations changes guest UIKit
  animation speed and reads the setting back; Shake sends a shake event to the
  foreground app. Android animation settings are unchanged.
- **Logs.** Separate Metro and App / native inspector sections open the same
  viewer with their source filters selected. Filters remain editable; repeated
  errors are grouped. **Build output > Readable** simplifies Xcode output; **Raw** restores
  every line. Copying and record details retain the original output.
- **Builds.** The inspector card keeps progress and the last and next build
  summaries. **Details** opens a sheet with a platform switch, recent runs,
  elapsed time and estimate, phase timings, the wait holder, build and device
  slot waits with capacity counts and elapsed wait time, cache lookup and
  full miss reason with changed sources and baseline, remote Mac and offload
  fallback reason, compiler diagnostics, retained output, and the next-build
  plan with **Check**. The header's running-build progress opens the current
  run in the same sheet. **Open in logs panel** opens the selected run in the
  logs drawer, filtered by platform, slot and timestamps. Clear the Build run
  chip to return to generic logs. **Run** starts iOS or Android; a failed last
  build offers **Rebuild**. For multi-app worktrees, the sheet switches among
  all apps' iOS, Android and macOS entries, adding project names only for repeated
  platforms; checks, runs, history and logs use the selected app. The macOS panel
  shows the product, build state, duration, error and build logs.
- **Other tools storage.** The Storage page reports agent-device runner builds,
  sessions and logs under **Other tools**, with Reveal opening its state
  directory. It also reports the user-level **SwiftPM cache**, shared by every
  SwiftPM build on this machine, with Reveal opening its cache directory.
  The `~/Library/Caches` row excludes SwiftPM bytes counted in that separate
  row, as it excludes Stim caches, so **Other tools** counts them once.
  Stim never offers a cleanup action for either report-only location.
  Stim never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.
  Stim never deletes the SwiftPM cache.
- **Machines.** Select **This Mac** for local disk, memory and cleanup, or a
  configured remote Mac for its readiness, capacity and build history.
  Click the toolbar's CPU, memory or disk figure for details. While open, hover another resource figure to switch details; click outside to close. **Open Machines**
  in each popover opens the Machines page. CPU covers active workspace processes,
  while memory covers the whole Mac.
  **Link machine** opens the existing **Remote Macs** settings flow, whose
  **Add...** button walks through picking a Mac, choosing Builds and Hosted
  simulators, and running a generated `stim-server setup` command in Terminal on
  that Mac. Running it there, and answering its y/N question for each request, is
  the approval. Desktop mirrors the setup live and waits for both approvals.
  A remote Mac on another Stim build offers **Install This Mac's Build**. It
  installs this Mac's npm release there, or this checkout's own build when the
  machine allows it with `server.acceptClientBuilds`. The update goes over the
  tailnet, with no ssh, and the old server comes back if the new one does not
  start. **Settings > Remote Macs** can keep them on this Mac's Stim version automatically.
  A removed selection returns to **This Mac**; remote selections have no local
  cleanup actions. Select checklist items to enable **Free space**;
  cleanup previews or confirms the selection before deleting anything.
  Build-cache stats and placement totals use the
  existing local server connection when it allows reads for the same Stim home;
  otherwise they use the CLI. A
  cancelled stats refresh stops waiting without disconnecting device viewing;
  its server read may continue until it finishes or reaches its existing limit
  (normally 60 seconds). The shared connection limits each complete response to
  16 MiB, including its JSON envelope; an oversized response shows a read error
  without retrying through the CLI.
- **Workspace changes.** Click the workspace header's Git chip, then **Review
  changes**, to browse staged, unstaged and new files. The built-in viewer loads
  each patch when you select its file, with a 200-file list and 256 KiB preview
  limit. It labels binary, oversized and unavailable previews, and needs the
  local server to be read-capable with workspace diff
  support, for the same Stim home. In **Settings > Integrations > Review changes in**, choose
  **Built-in** or **Visual Studio Code**. VS Code opens the local repository for
  review in Source Control, rather than exporting a selected comparison. A
  missing app or failed launch reports an error.
- **Phones.** Pair the Stim phone app, and watch a leased phone from the
  desktop: Android can be controlled, an iPhone over USB is view only. Needs
  **Serve to phones**. The phone's workspace list groups app projects from one
  linked Git checkout under one branch heading. The heading and each app child
  open one screen for the whole checkout, with every app's devices, builds,
  logs and commands; a child scrolls to its app's devices. In the phone's **Work** sheet, **Changed** and
  **Untracked** open a file list; choosing a file shows staged/unstaged patches
  or new text. Diffs load only on demand, with virtualized lists, up to 200 files
  and a 256 KiB preview limit. Binary files and unsupported previews are labeled.
  Changed lists include submodules only when their recorded commit differs;
  uncommitted edits inside submodules are not listed.
  Active Git clean/process filters, including Git LFS, refuse without running
  them. Viewing needs a Mac server with workspace diff support; edits and staging
  stay on the Mac. Different machines and checkouts remain separate.
  Primary checkouts and older servers lacking checkout identity still show separate
  app rows; [#2418](https://github.com/appandflow/stim/issues/2418) tracks that addition.
  The phone's Logs screen starts with 200 recent records. **Load older logs**
  expands that recent window by 200 up to 5,000; each request repeats the
  recent window. Opening a specific agent action retains the larger window.
  Log followers pause while their route is covered or the phone app is in the
  background and refresh the retained window when visible again. This reduces
  initial phone transfer; the server still reads its captured log timeline.
  Desktop's sidebar shows one row per multi-app worktree, with platform badges for each app.
  On wide iPad and Duo windows, the app keeps its navigation beside the main screen; details use the full window. A book fold aligns the panes with the display
  division; a narrow cover screen uses the menu drawer. Duo fold detection
  needs an app built with the iOS 27.1 SDK and an iOS 27.1 runtime.
  On supported phones, light haptics mark menu opening, section and custom-filter
  changes, and successful diagnostic or log copies; scrolling and live updates stay silent.
- **Tablet phone-app layout.** Workspace summary cards use one row when the
  content pane has room for all four, and wrap on smaller panes. Device cards
  stay centered, fill available width up to 640 points, and form extra columns
  only when full-width cards fit.
- **Notifications and cleanup.** Alerts for stuck agents and builds that keep failing, and
  automatic removal of worktrees after their pull request merges. The **Needs
  you** category lists only what agents cannot handle, such as a doctor
  finding, a signing failure or an expired device lease, with **Run**, **Copy
  command**, **Fix**, **Open logs** or **Show in Finder** on its row in
  **Notifications**. It is Silent by default, and **Work started** is Off. An agent stop
  notifies **Work finished** once per workspace per run, **Needs you** comes once
  per workspace per run, and a folder that is not a React Native or Expo app
  raises none. While Desktop is in front, every new
  Alert or Silent entry gives the top-right bell one small wiggle and bumps its
  count (a burst within two seconds wiggles once, and not while Notifications is
  open); Off entries are kept as Muted, already read, with no wiggle or count; under Reduce Motion the bell keeps
  its colour change and skips the wiggle. A build or hosting request and an Alert-level machine problem also
  open a card in the window. Background macOS alerts follow notification settings.
  The inbox starts with 50 matching
  notifications; **Show older notifications** loads another 50. Changing a filter
  returns to the first batch. **Mark all read** and **Clear** apply to all matching
  notifications, including rows that have not been loaded.

![A device viewer: the simulator screen with the agent's recent actions, including two that failed](/img/desktop/viewer.webp)

![The logs drawer with a Metro syntax error and its code frame grouped into one entry](/img/desktop/logs.webp)

![The Machine page: free disk split by category, and a checklist of what Stim can free](/img/desktop/machine.webp)

Workspace device cards fill the available width up to 640 points and wrap into
centered rows. Each complete card, including its header, fits the canvas height;
additional rows scroll vertically. Screens keep their aspect ratio and a
900-point height cap. Small previews use a 6-point inner inset, while the canvas
keeps 20 points of outer padding. Stopped devices use compact, consistently sized
cards up to 420 points wide. **Boot** runs the device's platform and slot through
Stim, building and launching when needed; the button is disabled while the workspace
has an action running. Unowned and physical devices have no Boot button. Closed web
cards offer **Open** instead. Workspace cards show **Control** for a running
controllable device, or **View** otherwise. Clicking the rest of the card opens the
viewer, with Control already on when the device allows it. Physical iOS devices
and remote previews stay view-only; Android phones require a valid lease and a
control-capable pairing. **Release control** or Escape returns to viewing.

A live local simulator or emulator viewer draws matching installed hardware artwork
by default. Turn it off with **Show device frame** in the options popover (the
sliders button); Desktop remembers the choice per device type. When no frame can be
drawn the checkbox is disabled and says why. Frames rotate with the display, preserve its aspect ratio and input
coordinates, and do not require Control. Apple frames use installed DeviceKit
chrome. Android frames use the AVD's configured skin or matching hardware profile
artwork in `/Applications/Android Studio.app`, with matching screen dimensions.
Missing artwork and unsupported skin layouts stay frameless; Android foldables,
physical and remote devices, web pages and replay do too. For a local iPhone Duo,
an installed Xcode with DeviceKit's V68 model and a valid observed hinge angle
enables genuine hardware that follows the hinge and rotation, with input mapped
to the posed active screen. Xcode 27.0 lacks the model; Desktop uses the selected Xcode's copy, then another
installed Xcode's. Without it, the viewer stays frameless and the popover says so.
Desktop snapshots the departing panel before its own posture controls change the
hinge; external handoffs can leave that panel blank or retain an older snapshot.
Stim does not bundle the artwork.

The phone app's bottom toolbar offers **Device frame** for ordinary live iOS
simulators and Android emulators when the paired server supports it. Frames
start off. The Mac sends installed housing pixels to the authenticated read
subscriber; the app keeps its existing guest screen inside the housing's
aperture, so bezel taps send no input. Missing artwork or mismatched rotation
keeps the screen frameless. Phone replay, physical devices, web pages and
Android foldable/circular devices do not use this mobile frame path.

Framed H.264 requires a current Stim phone build with native orientation-clear support; older phone builds keep the video frameless.

For a live iPhone Duo, **Device frame** uses the paired Mac's installed V68 model
when the server advertises `duo-frames`. The Mac composes the hardware and screen
pixels into JPEG images with the observed hinge angle and rotation. A missing
model or angle reading keeps the raw screen visible. Input is enabled only after
the image is displayed, and a drag stays bound to that image's pose. Bezel and
hinge taps send no input. Raw subscribers and recordings are unchanged; turn the
frame off to replay them.

The live local viewer's scale menu defaults to **Fit**. **Point Accurate** maps
iOS points or Android profile dp to Mac points; **Pixel Accurate** maps guest
pixels to display backing pixels. **Physical Size** uses installed iOS device DPI
and the current monitor's reported dimensions, which can be approximate. It is
unavailable without those measurements and on Android; Android dp density does
not describe physical size. Moving between monitors updates the scale.
Accurate modes keep their size when the viewer is small. Scroll outside the device
screen, or release Control to scroll over it; **Fit** always returns to the full
device view. Hardware frames retain the screen scale through rotation. Android
accurate modes use native-resolution images; Fit and wall previews keep their 960-pixel limit.
Duo's projected housing and folded screen, replay, physical devices, web and remote
previews remain in **Fit**.

While controlling a local iOS simulator or Android emulator, hold **Option** and
drag to pinch or rotate two fingers around their center. Hold **Option-Shift**
to move both fingers together. Trackpad pinch also sends a two-finger pinch.
Two markers show the contact positions, including on a framed or folded screen.
Releasing Option, ending the gesture, changing orientation or releasing Control
lifts both contacts. Option and the gesture's Shift modifier stay on the Mac.
These gestures are not available for physical devices, remote previews or web pages.

With **Control** on an owned local simulator or emulator, the Mac and the device
share their clipboard text automatically. Switching to the viewer window, or
a new Mac clipboard item while the window is focused, sets the device clipboard; text copied on
the device reaches the Mac within about two seconds while the window is focused,
and once more as the window loses focus while it stays visible. Nothing syncs while
the window is hidden, minimized or covered. Mac items marked concealed or transient
(as password managers do), items carrying files or images, empty text and text over
256 KB are never sent to the device; text read from the device cannot be classified,
so it reaches the Mac marked transient, which clipboard-history apps skip. The
device's apps, and agents driving it, can read text sent to it. Opening a viewer never replaces the Mac clipboard with the device's.
Turn it off with **Sync clipboard** in the options popover (the sliders button),
which also has **Paste Mac clipboard** and **Copy device clipboard** for one-off
transfers. Syncing only sets the device clipboard; to insert text, paste in the
guest. An iOS simulator shows its own "Allow Paste" prompt for text that came from
another source; click **Allow Paste** in the viewer. Unicode and line breaks are
preserved. Physical devices, hosted and remote sessions and replay never sync, so
no clipboard text crosses the network or reaches another Mac.

Overview opens first. The **Active** section comes first, with a card and a live preview
of one device for each running project; click a card to open the project. With nothing
running, it says where active projects will appear. **Idle projects** follow as compact
cards in an adaptive grid, with their last activity, an open pull request, a failed last
build and errors. The grid shows the first six, and **Show more (N)** expands the rest in
place. Click a card to open the project with all of its worktrees listed, under a
**Showing all workspaces** chip you can clear to return to the active ones. A project page
whose worktrees are all inactive says so and has a **Show all** button. A **Recently archived** row and a **Try this** section
follow. **Try this** suggests one feature a day, preferring ones you have not used yet, such as EAS
development builds and simulators, another Mac for builds or simulators, `stim macos`,
running on a phone with `--device`, `stim web` and `stim logs --errors`, each with a
copyable prompt for your coding agent. A tip appears only when it applies, so EAS tips
need an `eas.json`, and Mac tips disappear once `remote.machines` is set. Dismiss a tip
with the **x** and the next one appears; it stays dismissed on this Mac. **Next tip** shows another
for today. The tip stays the same all day, and the next day shows the least recently shown one. It never repeats the
sidebar's tip card, and the section is hidden when no tip applies.

**Active workspaces** shows every worktree with something running, building or warming
as one full-width card. A worktree with several apps, such as `apps/mobile` and
`apps/desktop`, gets one card; each app is a labelled group inside it with its own
Metro port, errors, CPU and memory, followed by its device tiles. Click an app's label
to open that app's workspace.

For a worktree with one app, the header shows the name, project, Metro port, who drives it,
CPU, memory and errors (a card with no running device shows only Metro and errors), with the device tiles under it at the device tile size. The tiles
wrap onto more rows when they do not fit. Click a card or its header to open the
project (on a project page, the worktree), or a tile to open its
workspace with that device focused.

On the Active workspaces and project wall, offscreen previews pause and reconnect when you return to them.

On the Active workspaces and project wall, active workspaces without running or building
devices show a **No running devices** line under their header, with Metro status
and error links. CPU stays on the workspace page.

Run, Reload app, Start dev server and Stop from the workspace or sidebar menus keep
you on the workspace page, as do Stop or Shut down in the now band and Build and run and Stop
on a macOS app card. Open **Last output** or **Operations** for command details,
including failed runs. The device viewer's Run, Stop (including a remote session's), Reload web and Close web
also run without opening a sheet. Progress and failures appear on a line under
the viewer toolbar; **Show output** opens the failed run's output, and **Dismiss**
hides that failure. Click the **Recent builds** label or chevron to expand
the build history. Each row shows outcome, duration and age; click a row to
open that run in the build details sheet. Disclosure content and chevrons animate
unless Reduce Motion is enabled.

An empty workspace shows a purple device floating above a round plinth and a
short launch hint. Reduce Motion stops the illustration's animation.

On a foldable held like a book, the phone app's device viewer places the screen
and replay controls on the leading side of a vertical fold, with Control
toolbars and agent actions on the other side. An iPhone Duo needs a build
compiled with iOS SDK 27.1 or newer and an iOS 27.1 or newer runtime. Android
needs WindowManager fold support. Builds using an older iOS SDK receive no fold
divisions and keep the default viewer layout.

When the phone is partly folded like a laptop and reports a horizontal fold,
the viewer places its title and screen above the fold, with read-only messaging,
Control toolbars, replay controls and agent actions below it. This tabletop
layout uses `react-native-hinges` posture readings and the reserved fold geometry;
without both, the default layout remains. The same iOS SDK/runtime and Android
WindowManager requirements apply.

Actions open a sheet with progress and one completion or failure status. The sheet
stays open until you close it. Expand **Command output** to see the command and
raw output during or after a run; it is collapsed by default. Launch progress
uses **Launching app** and **Verifying launch** labels.

Closing the window leaves Stim Desktop running, so notifications and the phone
server keep working. Click the Dock icon to reopen the window, or press
Command-Q to quit. Command-1 through Command-4 open Overview, Active workspaces, Notifications and Machines.
The bell at the top right opens Notifications and shows the unread count; it stays visible when there are no unread notifications.

Stim Desktop checks the npm registry once a day for a newer `stim`. When the
`stim` it runs was installed by npm, pnpm or bun and is older, the sidebar
footer says so and **Settings > App > Stim CLI** has an **Update** button that
runs that package manager's update command. It never updates by itself, and it
never offers an update for a `stim` that no package manager installed, such as a
linked checkout.

## First steps

Unless you are already set up, the first launch opens a setup guide that
installs the `stim` CLI with npm, pnpm or
bun, whichever of them you use, and the agent skill, asks for notification
permission, offers an optional step that turns on Serve to phones and pairs a phone, and checks Xcode, the Android SDK and a project with `stim doctor`.
Each step shows the command it runs and runs
it only when you press **Run**. The project check lists each `stim doctor`
finding with its fix, and offers **Fix** for the findings `stim doctor --fix`
repairs. Reopen the guide from **Help > Setup Guide…**.

In a project, warm a worktree and run the app:

<StimTabs
code={`git worktree add -b my-feature ../my-app-feature
cd ../my-app-feature
stim worktree warm
stim start
stim ios`}
/>

1. The workspace appears in the sidebar as soon as it warms. Its simulator
   shows in the app instead of a separate Simulator window.
2. Click a device to open its viewer. **Take over** lets you use it; Escape
   gives it back.
3. To use the phone app, open **Stim > Settings > Phones** and choose **Pair a
   Phone…**. The wizard checks Tailscale, turns on serving, sets up a private
   tailnet route, shows a code and waits for the phone. Setup keeps existing
   Tailscale routes and never enables Funnel. If Tailscale asks to enable HTTPS,
   approve its browser setup and retry. Pairing waits for a verified private
   route; a timeout changes nothing.

Revoking a paired phone closes its active connections on the next pairing
check. The server checks pairings on changes and once a second. If QR pairing
fails, the phone keeps the error visible until **Retry** or manual entry is
chosen.

See [Phone app](./phone-app.md) for installation, pairing, notifications and access.

On the hosting Mac, **Stim > Settings > Remote Macs > Running here**, below
**Macs using this Mac**, lists the simulators, emulators and apps approved Macs run
here, with their client, device, app, state and session age. **Stop** asks for
confirmation, then ends the session and deletes or parks its device on this Mac.
Parked sessions remain listed without a Stop button. The list refreshes every
five seconds and stays hidden when an older local server does not support it.

The phone validates server replies and live events before displaying them.
Malformed known data triggers a reconnect with a connection error; message
contents are not logged. Older compatible payloads and extra fields remain
supported. Binary video uses its existing stream format.

![The Pair a Phone sheet with a QR code to scan with the phone app](/img/desktop/pair.webp)

Stim prints `Open in Stim Desktop: stim-desktop://workspace?path=...` when it
starts work, and coding agents share the same link, so you can jump straight to
a workspace. When no active workspace matches the exact path within 10 seconds, the
link opens its newest archive; an optional `&archive=<id>` opens a specific archive
belonging to that path at once. Settings and other details are in the
[app's README](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md).

## Add a remote Mac

**Settings > Remote Macs** lists your remote Macs with a status
(**Approved**, **Waiting for approval**, **Unreachable** or **Not offloading**),
a line with its running builds and free disk, any problem that keeps builds on
this Mac with its fix, what each does (**Builds**, **Simulators**) and a **...** menu with **Details**
and **Remove**. It updates itself; there is no Refresh button. With none, it
offers **Add Remote Mac…**, which guides you through five steps:

1. Check Tailscale and pick a Mac on your tailnet.
2. Choose Builds and/or Hosted simulators.
3. Run setup there.
4. Compare tools.
5. Choose when to offload.

Run the generated setup command in Terminal while signed in at the build Mac
and answer each y/N approval there. Permission prompts appear on that Mac.
There is no SSH option. The wizard refreshes by itself; there is no Check again
button.

Only a problem that stops the chosen capability blocks the Tools step. A Stim
build mismatch, which **Install This Mac's Build** fixes, is one. Other tool
differences, such as a different project-selected CocoaPods or missing Android tools, are
warnings that say what they cost and offer copyable fixes.

The last step offers a **Try it** agent prompt and `stim ios --remote-build
<machine>`. It sets **Builds** (`remote.buildMode`, Auto by default for your
first remote Mac). With Hosted simulators chosen, it also sets **Simulators**
(`ios.remote` and `android.remote` for this Mac). **Run a
test build with a sample app** runs the optional sample test in Desktop's own
pinned Expo SDK 58 sample. Desktop also uses that sample for setup requests if
you have no listed workspace. The wizard removes it when it closes.
Cancel removes only settings the wizard added and shows revoke commands for the
build Mac. **Remove** in Remote Macs shows the optional cleanup to run on that
Mac.

See [Remote Macs](./remote-machines.md) for requirements, CLI setup, permissions and troubleshooting.

## SwiftUI playground for contributors

A DEBUG build provides **Window > SwiftUI Playground** with production notification filters, build
cards and disclosures, simulator appearance controls, Settings scope tabs and design tokens. Named
scenarios cover each view's applicable loading, empty, error, long-text and large-data states.

Run `swift run StimDesktop --playground` from `apps/desktop` to open only the playground, without
starting the normal app's CLI or server. Fixture interactions stay in memory. Compact/regular
viewports, light/dark, large text and increased contrast help inspect layout without
changing system preferences. Release builds exclude it. See the [desktop development guide](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#swiftui-playground) for adding a fixture.

## Suggestions

Desktop suggests remote Macs, hosted simulators, cache review, or phone pairing when recent builds, tailnet peers, disk pressure, or device limits make them useful. Each kind shows once unless you dismiss it with the X to snooze it for 7 days, after which it may show again. Choose **Don't suggest again** to dismiss that kind permanently. Device-limit suggestions use refusals from Desktop commands and recent `stats --json` capacity events, including agent terminal runs, within 6 hours of the refusal. Three device waits of at least one minute each within the same 6-hour window also trigger a suggestion. When a Mac is already approved for hosted simulators, the device-limit suggestion offers **Use Auto** instead of the setup wizard. It runs `stim settings set ios.remote auto --scope workspace` (and `android.remote`, for the refused platform, or both when it is not known), so runs place on the hosting Mac when this Mac is full, from Desktop and from agents in a terminal. While it is set, `--plan` and `--device` runs in that workspace refuse; undo it with `stim settings unset ios.remote --scope workspace` (and `android.remote`). A tailnet Mac already in `remote.machines` is not announced as new. Suggestions never appear during a build or install, before setup is complete, or on the first launch, and appear at most once per day. Nothing is set up until you open and follow the wizard.

The **Tip** card at the bottom of the sidebar appears after setup is complete and
Desktop has been used on at least **3 calendar days**, with either **3 distinct
workspaces seen running** or **5 builds observed**. It stays hidden while a build
runs, the setup guide or tutorial is open, the main window is closed, or any
notice is showing. Only builds that start after Desktop first sees status count.
Usage is stored locally in Desktop preferences: the latest 30 active days and,
until the thresholds are met, the workspace paths and build IDs counted.

Tips cover remote Macs, phone pairing, the tutorial, hiding workspaces when
there are more than 10 workspace rows and none are hidden, status filters, replay, and hosted
simulators. Only applicable tips appear. One tip stays for the calendar day;
the next day picks the least recently shown applicable tip, with unseen tips
first. **Next tip** cycles through the remaining choices. The X hides the card
until tomorrow. Turn off **Settings > App > Show tips** to disable tips; the Machine page card stays.

Tips and suggestions share state for remote Macs, phone pairing, and
hosted simulators. A shown, permanently dismissed, or currently snoozed
suggestion suppresses the matching tip. Once that tip has been shown, the
matching suggestions (new Mac, slow cold builds, build slot waits, away
builds, device limit) no longer appear. Disk-pressure suggestions are
unaffected. Suggestions keep their own once-per-day limit.

**File > Add Remote Mac…** (**Cmd+Shift+B**) always opens the existing build
machine wizard. After the same usage threshold, **Machines > This Mac** shows a
card when no remote Mac is configured. With another Mac on the tailnet it
offers **Add Remote Mac…**; otherwise it explains how to connect both Macs
with Tailscale. The existing **Link machine** button is also available. Build
machines are not a step in the first-run setup guide.
