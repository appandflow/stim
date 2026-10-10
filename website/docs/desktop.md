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
scrolls to that app. The row's context menu has per-app submenus, **Stop All** and
**Remove Worktree**. The canvas combines all devices, with one stage and git chip. Build cards keep platform titles, adding project
subtitles only for repeated platforms. The inspector aggregates resources,
labels each Metro and deduplicates agents. The logs drawer follows app selection
and has an **App** picker. The actions menu keeps each app's commands plus
**Stop All** and one **Remove Worktree** action.

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
tiles labeled with the machine's name. You view and control them through this
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
sidebar row show the machine's name with a computer icon, with the placement reason as hover text.
Local devices show no placement label. See [iOS on an approved Mac](./owned-devices#run-ios-on-another-mac).

Desktop uses the non-empty launch `STIM_HOME`, then the login shell's value, then
`~/.stim`; **Settings > App > Stim CLI** shows the home, and private-home copies
refuse servers for another home.

The app updates itself. Release builds report crashes, app hangs of 2 seconds or
more and a few handled failures to Sentry, with file paths, host names,
addresses and credentials removed. They send no screenshots, performance traces
or usage analytics. The handled failures are a failed `stim` command (the
command name, exit code and `STIM_*` error code, never its arguments), a
payload that did not decode (the type and the field names, never values), and
a `stim-server` that did not start. Each is sent at most once per launch, with
breadcrumbs of the page kinds you visited, command names with durations and the
server's state. Builds without a Sentry key, including every development build,
send nothing. [Crash reports](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#crash-reports)
lists every field. Every release is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true).

## Tutorial

Open **Help > Stim Tutorial…**, or choose **Take the Tutorial** on the setup
guide's last screen. The trailing tutorial column replaces the inspector;
**⌘⌥I** returns to the inspector. Starting the tutorial with your agent also
opens the panel once for that tutorial path, after any open sheet closes.

<img src="/img/desktop/tutorial-panel.png" alt="Stim Tutorial panel showing the agent actions step" width="320" />

<PromptBox title="Get the test app">
{`Clone appandflow/stim-tutorial into ~/stim-tutorial and follow stim guide tutorial run.`}
</PromptBox>

The tutorial shows what worktree isolation and automated validation buy you.
Two agents work on two changes at once, each in its own linked worktree of the
clone with its own simulator and dev server, and each checks its own work on the
device. The panel clones [appandflow/stim-tutorial](https://github.com/appandflow/stim-tutorial),
a tiny Expo app, and shows:

- **Get the Test App:** the prompt above. It clones, installs and runs `stim doctor` so Stim registers the clone, and builds nothing; the clone is the base for your changes and is never run; only the optional last step and **Restart Tutorial** remove it. An existing `~/stim-tutorial` that is a clean clone of the tutorial repository is reused; any other existing folder makes your agent ask for another one. **Restart Tutorial** asks before it deletes the folder and its tutorial worktrees through `stim worktree remove`, then moves the folder to the Trash; a folder without the tutorial marker is left alone. While your agent works, the step ticks **Test app cloned**, **Dependencies installed** and **Registered with Stim**. The first two read `~/stim-tutorial` itself, so a clone in another folder ticks only the last.
- **Make a Change:** ask your agent for a visual change, for example "Make the title purple in the Stim tutorial app and check it on the simulator." (the step has a prompt to copy). It builds in the first linked worktree of the clone with its own simulator, and checks the result on the device. The first build, usually a cache miss on a fresh Mac, takes a few minutes.
- **Change It Again in Parallel:** while that builds, copy the step's prompt, "While that builds, make the Tap me button green in a new worktree and check it on the simulator." The next linked worktree of the clone, made after the first change step began, has its own simulator and Metro port, and its first iOS build is a cache hit.
- **Live View and Control (optional):** open a tutorial simulator's live view and tap the app yourself. A glow points at the device's live view, then its screen: tap **Tap me** and watch the counter. While the live view is open, a small card in it shows the step and its ticks, **Live view opened** and **Device controlled**; the step moves on once both are ticked.
- **Agent Actions and Replay (optional):** see what your agent did on the first change's simulator, then replay it. A glow points at its live view, then its Agent Actions list, then the replay's Play button. The step ticks **Agent actions viewed** and **Replay played** and stays open so you can keep watching; **Next** then records it done. When no agent actions were recorded on that simulator, the step says so.
- **App Logs (optional):** read the app's output and any errors in Logs. The step ticks **Logs opened** and completes when you show the Logs of either tutorial worktree, or press **Show me**, while the step is current.
- **Watch on Your Phone (optional):** **Pair a Phone** opens the Pair a Phone wizard, which turns on serving itself. An existing pairing shows **Done Already**, then "Open Stim on your phone: the tutorial workspaces are there".
- **Share Your Finish (optional):** a prompt you may paste before finishing, while your change still exists, to fork the tutorial repo and open a public pull request with before and after screenshots of your change, a short note on how Stim verified it, and a link to Stim. It is public, needs your agent to have GitHub access (`gh`), and a bot replies and closes it. Desktop never runs it and nothing depends on it. When Stim reports a pull request for the first change's worktree, including one from your fork, the step ticks **Pull request opened**, links it and completes; Stim checks GitHub every few minutes, so the tick can take up to five minutes.
- **Finish and Archive:** the prompt names the two worktrees; your agent stops their apps and removes only those, dropping their changes (a forced removal is allowed for exactly those two, after a plain remove refuses). The clone stays. **Open Archived** opens the same workspace page as a read-only archive, with retained build history, logs and recordings. Archived sidebar rows keep the live repository/worktree grouping and app labels.
- **Delete the Test App (optional):** a prompt to remove the tutorial for good. Your agent removes any worktrees of the clone and then the clone itself with a plain `stim worktree remove`, stopping to ask if one holds changes, so their simulators, Metro ports and Stim records are torn down, and then deletes the clone's folder. The step completes when Stim no longer lists the clone and its folder is gone. Press **Next** to keep the clone.

When the tutorial ends, the panel shows a completion card: the time from clone to archive, the first build, the second build's cache hit and the time it saved, the two worktrees, the agent actions you can replay, and the space Delete freed, each only when Stim measured it. Each optional step you finished is a badge; a skipped one stays dashed.

Your agent checks each change on its simulator with agent-device, following
`stim guide tutorial run`: it taps **Tap me**, toggles **Dark accent**, types a
name and takes a screenshot, so Desktop records its actions for the Agent
Actions and Replay step.

When agent-device is not installed, **Make a Change** shows a card with
`npm i -g agent-device` and a prompt that installs it. The tutorial completes
either way; without it your agent can only check the build and logs.

Completed optional steps stay expanded so you can follow the phone handoff. The tutorial does not start the server, pair phones or
grant access, and it runs no builds itself.

A soft glow with a short label points at the control a step needs, without
covering the app with a dimming layer, and fades after a few seconds; it shows
again when the step or page changes. On **Make a Change**, it points at the
**Show** button of the "launched for" notice for your first change's worktree;
if that notice is gone, **Open the build** in the step does the same. **Show
me** selects the tutorial workspace when the control is not on the page.

Progress stays in this app's preferences. Closing the panel preserves it;
Help reopens it. At launch an unfinished tutorial resumes when Stim still lists
its path, and an archived tour opens at Delete the Test App. Every step has
**Next**, which moves on without waiting for a signal. It records the step as
done when its checks are all ticked or Desktop detected it, and as skipped
otherwise. Steps Desktop detects move on by themselves. The **…** menu
also offers **Restart Tutorial**, which starts over at Get the Test App as on a
first start; worktrees from before the restart stay and no longer count. When
the tutorial workspace comes from an older tutorial version, the panel says so
and offers only **Restart Tutorial**.

A step that needs your agent shows a plain request to copy, with the paths
filled in from the tour's repository. The default base is `~/stim-tutorial`.
The agent keeps the tutorial's own runs local, whatever `ios.remote` or
`remote.build` say.

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
stops or reconfigures it. Desktop reads workspace status from that server's status
feed while the server allows reads and serves the same Stim home, so one `stim status --watch` serves both; it runs
its own only while the server is unavailable. When the server cannot start, a warning icon in the
sidebar footer says why; click it to retry. Serving phones over the tailnet stays
opt-in (**Serve to phones**, with the Phone app flag on).

- **Every workspace at a glance.** Each workspace shows its stage (warming,
  building, running, failed), its devices side by side, and its branch and pull
  request status.
- **Back and forward.** The chevrons at the left of the window toolbar, **Go > Back** (**Cmd+[**) and
  **Go > Forward** (**Cmd+]**), the mouse back and forward buttons and the trackpad's swipe between pages (when that macOS setting is on) step through the
  pages you have visited, like Finder. The history keeps the last 50 pages, with the **Showing all worktrees**
  scope of a project page and the device you clicked. Opening something new after going back drops the pages
  ahead. A workspace that was removed or archived since is skipped.
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
- **Simulator Options.** While **Control** is on for a running local iOS
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
  plan. While a run boots its simulator or emulator, builds the app's first JS
  bundle in Metro, or waits for the app to report ready, the progress and the
  current phase say so with that step's own elapsed time: **Booting
  simulator**, **Bundling JS 45%** (Metro's own percentage, once it reports
  one) or **Waiting for app ready**. A step with no percentage draws its bar
  segment as indeterminate. Checks run automatically while visible, reusing a completed build or check
  for 60 seconds and skipping running builds; there is no manual Check button. The header's running-build progress opens the current
  run in the same sheet. **Open in Logs Panel** opens the selected run in the
  logs drawer, filtered by platform, slot and timestamps. Clear the Build run
  chip to return to generic logs. **Run** starts iOS, Android or macOS; a failed last
  build offers **Rebuild**. For multi-app worktrees, the sheet switches among
  all apps' iOS, Android and macOS entries, adding project names only for repeated
  platforms; checks, runs, history and logs use the selected app. macOS uses the
  same Details/Run and Last Build/Next Build card layout. Its plan validates
  packaging settings but does not predict SwiftPM incremental work, worker
  availability, a cache outcome or duration.
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
  **Link Machine** opens the existing **Remote Macs** settings flow, whose
  **Add...** button walks through picking a Mac, choosing Builds and Hosted
  simulators, and running a generated `stim-server setup` command in Terminal on
  that Mac. Running it there, and answering its Y/n question for each request, is
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
- **Workspace Changes.** Click the workspace header's Git chip, then **Review
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
  command**, **Fix**, **Open Logs** or **Show in Finder** on its row in
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
  notifications; **Show Older Notifications** loads another 50. Changing a filter
  returns to the first batch. **Mark All Read** and **Clear** apply to all matching
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
control-capable pairing. **Release Control** or Escape returns to viewing.

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
which also has **Paste Mac Clipboard** and **Copy Device Clipboard** for one-off
transfers. Syncing only sets the device clipboard; to insert text, paste in the
guest. An iOS simulator shows its own "Allow Paste" prompt for text that came from
another source; click **Allow Paste** in the viewer. Unicode and line breaks are
preserved. Physical devices, hosted and remote sessions and replay never sync, so
no clipboard text crosses the network or reaches another Mac.

Overview opens first. The **Active** section comes first, with the same grid of live workspace
cards as the Active workspaces page (see below). With nothing running, it says where active projects will appear. **Idle projects** follow as compact
cards in an adaptive grid, with their last activity, an open pull request, a failed last
build and errors. The grid shows the first six, and **Show more (N)** expands the rest in
place. Click a card to open the project with all of its worktrees listed, under a
**Showing all workspaces** chip you can clear to return to the active ones. A project page
whose worktrees are all inactive says so and has a **Show All** button. A **Recently archived** row
follows.

**Active Workspaces** shows every worktree with something running, building or warming
as a card in a grid: two columns at typical widths, one when the window is narrow and
three when it is very wide. The Overview's **Active** section uses the same cards. A
card's header has the name, project and app path, with chips for Metro, who drives the
devices, CPU, memory and errors. Its body streams the worktree's first device live, at the
device tile size and the live frame rate from Preferences. When a worktree has several
devices, a Mac app or several apps, a row of buttons switches which one streams (labelled
by app when there are several); Desktop remembers the choice until it quits. A workspace
with no running device shows its build progress, setup state or Metro status in that area.

Click a card or its header to open the workspace (on the Active Workspaces page, the
project), or the stream to open the workspace with that device focused. Cards that scroll out of view
stop streaming and reconnect when you return to them.

Run, Reload App, Start Dev Server and Stop from the workspace or sidebar menus keep
you on the workspace page, as do Stop or Shut down in the now band and Build and Run and Stop
on a macOS app card. Open **Last Output** or **Operations** for command details,
including failed runs. The device viewer's Run, Stop (including a remote session's), Reload web and Close web
also run without opening a sheet. Progress and failures appear on a line under
the viewer toolbar; **Show Output** opens the failed run's output, and **Dismiss**
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
stays open until you close it. Expand **Command Output** to see the command and
raw output during or after a run; it is collapsed by default. Launch progress
uses **Launching app** and **Verifying launch** labels.

Closing the window leaves Stim Desktop running, so notifications and the phone
server keep working. Click the Dock icon to reopen the window, or press
Command-Q to quit. Command-1 through Command-4 open Overview, Active Workspaces, Notifications and Machines.
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

Desktop shows owned simulators itself, so you never need to open Device Hub. If
you open it and quit it by accident, Xcode 27 can shut down booted simulators.
[Owned devices](./owned-devices.md#keep-simulators-running-when-device-hub-quits)
lists optional `defaults write` preferences you can set yourself, with their
limits and how to undo them. Stim never sets them.

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
**Macs Using This Mac**, lists the simulators, emulators and apps approved Macs run
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

**Settings > Remote Macs** also shows **Builds enabled** and **Simulators enabled**
for this Mac, in a card under **This Machine**, and on each remote machine's card. These switches control new automatic placement
requested by this Mac without unpairing or stopping anything. Each pool retains at
least one local or configured, approved remote member. Explicit placement is unchanged.
See [automatic machine pools](./remote-machines.md#automatic-machine-pools) for CLI controls.

**Settings > Remote Macs** lists your remote Macs with a status
(**Approved**, **Waiting for approval**, **Unreachable**, **Needs update** or the reason it is not offloading),
a line with its running builds and free disk, any problem that keeps builds on
this Mac with its fix, what each does (**Builds**, **Simulators**) and **Remove...**. It updates itself; there is no Refresh button. With none, it
offers **Add Remote Machine…**, which guides you through five steps:

1. Check Tailscale and pick a Mac on your tailnet.
2. Choose Builds and/or Hosted simulators.
3. Run setup there.
4. Compare tools.
5. Choose when to offload.

Run the generated setup command in Terminal while signed in at the build Mac
and answer each Y/n approval there. Permission prompts appear on that Mac.
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

Desktop suggests a remote Mac, cache review, or phone pairing when recent builds, tailnet peers, disk pressure, or device limits make them useful. The low-disk suggestion points to the Machine page, where caches are reviewed and cleared; it does not mention another Mac. Suggestions to add a Mac (a new tailnet peer, a build that waited for a build slot, the device limit) appear only while `remote.machines` is empty. The build-slot and device-limit ones appear once, ever, across both. Each kind shows once unless you dismiss it with the X to snooze it for 7 days, after which it may show again. Choose **Don't Suggest Again** to dismiss that kind permanently. Device-limit suggestions use refusals from Desktop commands and recent `stats --json` capacity events, including agent terminal runs, within 6 hours of the refusal. Three device waits of at least one minute each within the same 6-hour window also trigger a suggestion. A build that waited for a build slot within the last 7 days triggers one. When a Mac is already approved for hosted simulators, the device-limit suggestion offers **Use Auto** instead of the setup wizard. It runs `stim settings set ios.remote auto --scope workspace` (and `android.remote`, for the refused platform, or both when it is not known), so runs place on the hosting Mac when this Mac is full, from Desktop and from agents in a terminal. While it is set, `--device` runs in that workspace refuse and the Next build card plans for where `auto` would place the run now, naming the Mac in its placement line; undo it with `stim settings unset ios.remote --scope workspace` (and `android.remote`). A tailnet Mac already in `remote.machines` is not announced as new. Suggestions never appear during a build or install, before setup is complete, or on the first launch, and appear at most once per day. Nothing is set up until you open and follow the wizard.

The **Tip** card at the bottom of the sidebar appears after setup is complete and
Desktop has been used on at least **3 calendar days**, with either **3 distinct
workspaces seen running** or **5 builds observed**. It stays hidden while a build
runs, the setup guide or tutorial is open, the main window is closed, or any
notice is showing. Only builds that start after Desktop first sees status count.
Usage is stored locally in Desktop preferences: the latest 30 active days and,
until the thresholds are met, the workspace paths and build IDs counted.

Tips cover remote Macs, phone pairing, the tutorial, hiding workspaces when
there are more than 10 workspace rows and none are hidden, status filters, replay, and hosted
simulators. The replay tip appears when an archived workspace still has recordings and opens it.
Three tips offer **Copy Prompt** for your coding agent instead of a button that opens a page: EAS
development builds when a project has an `eas.json`, `stim macos` when a project has a Swift
package app that has not run as a macOS app yet, and `stim logs --errors` when a workspace has
errors. Only applicable tips appear. One tip stays for the calendar day;
the next day picks the least recently shown applicable tip, with unseen tips
first. **Next Tip** cycles through the remaining choices. The X hides the card
until tomorrow. Turn off **Settings > App > Show tips** to disable tips; the Machine page card stays.

Tips and suggestions share state for remote Macs, phone pairing, and
hosted simulators. A shown, permanently dismissed, or currently snoozed
suggestion suppresses the matching tip. Once that tip has been shown, the
matching suggestions (new Mac, build slot waits, away
builds, device limit) no longer appear. Disk-pressure suggestions are
unaffected. Suggestions keep their own once-per-day limit.

**File > Add Remote Machine…** (**Cmd+Shift+B**) always opens the existing build
machine wizard. After the same usage threshold, **Machines > This Mac** shows a
card when no remote Mac is configured. With another Mac on the tailnet it
offers **Add Remote Machine…**; otherwise it explains how to connect both Macs
with Tailscale. The existing **Link Machine** button is also available. Build
machines are not a step in the first-run setup guide.
