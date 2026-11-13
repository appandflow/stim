---
title: 'Dev server and logs'
sidebar_position: 4
description: 'A supervised Metro server and a queryable launch timeline'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

`stim start` reserves a port for the workspace and has the Stim home's stimd
start its React Native or Expo dev server. The command exits only after the
server answers and Stim verifies its project identity. It starts stimd when
none runs, whatever `daemon.mode` says. The dev server runs under a small
helper process, its parent, which records what the dev server writes and its
exit code even while stimd restarts or updates. On macOS, output still buffered
inside the dev server when it calls `process.exit()` after a burst larger than
the pipe buffer (64 KB) is lost; everything it wrote before exiting is recorded.

A Debug `stim ios` or `stim android` run starts the dev server the same way
when it is not running, so `stim start` is optional. Running it first lets
Metro warm up while you do other work.

Bare React Native runs Metro in Stim's Metro host process. Expo runs the
project's Expo CLI. Re.Pack runs through the project's Rock CLI, or the React
Native CLI when `react-native.config.js` (or `.cjs`, `.mjs`) registers Re.Pack's
commands. All of
them run on the Node the project pins. A healthy server that another process
started for the same project can be reused, but Stim cannot capture its full
output.

If Expo cannot be resolved in a linked worktree, run `stim worktree warm`
there before retrying. The refusal includes this command alongside dependency
installation guidance.

For Expo and custom Metro commands, Stim looks for a Node pin from the app
directory up to the repository or worktree root. The nearest `.nvmrc`,
`.node-version`, `.tool-versions` Node entry or `package.json` `volta.node` wins.
When a compatible Node is installed, Stim puts it first on the child's `PATH`.
On Windows, the bare, Expo and Re.Pack dev servers run on the Node that runs
Stim instead: a `node` shim on `PATH` would start Metro in a child process
that Stim cannot identify as the dev server.

## How Stim picks the dev server

Stim never asks which dev server to run and never runs a `package.json`
script. It reads the project's config files as text and takes the first match:

1. `metro.command` is set, so Stim runs that command.
2. A `rock.config.*` file imports `@rock-js/plugin-repack`, so Stim runs
   Re.Pack through Rock.
3. There is no `rock.config.*` and `react-native.config.js` (or `.cjs`, `.mjs`)
   requires
   `@callstack/repack/commands`, so Stim runs Re.Pack through the React Native
   CLI.
4. The app uses Expo, so Stim runs the Expo CLI.
5. Otherwise Stim runs Metro in its own host.

Only a value or side-effect `import`, a `require` or a dynamic `import()` of
the package counts. A comment, a string, `import type` or an
`import('...').Name` type does not. An app that installs `expo`
only for Expo modules but bundles with Re.Pack gets Re.Pack. Every other app,
including a Rock app on Metro, gets the same dev server as before Stim
supported Re.Pack. `stim start` names the file that decided, for example
`starting on port 8082 (repack-child from rock.config.mjs)`.

Stim starts Re.Pack with `--json --log-requests`, so each bundle request and
compile becomes a record in `stim logs --source metro`, and `stim ios` and
`stim android` use the bundle requests to confirm the launch. In development
Re.Pack still serves a bundle that compiled with errors. When the compile
that produced the delivered bundle logged an error, the launch reports
`launched: "unverified"` instead of `true`, and the errors are in
`stim logs --source metro`. Stim needs Re.Pack 5 or later; set
`metro.command` for Re.Pack 4. `stim start --reset-cache` passes Re.Pack's
`--reset-cache`. Stim turns off Re.Pack's own `adb reverse`, because it would
reach every connected device, and manages the reverse for its port itself.
`stim reload` reaches a Re.Pack app through the dev server's `/message`
socket. That socket cannot name its connected apps, so the reload goes to
every app connected to the dev server, and Stim skips its Metro warmup
request.

Stim starts Re.Pack on `localhost`, and Re.Pack writes that host into the
bundle's asset and chunk URLs. Simulators, emulators and Android phones reach
it. Runs that cannot reach it refuse before they build: `stim ios --device`
with `STIM_LAN_METRO_UNREACHABLE`, and a `--remote`, tunnel or hosted run with
`STIM_REMOTE_METRO_UNREACHABLE`. For those, set `metro.command` to the
project's own start command with the host the device can reach, for example
`["npx", "rock", "start", "--port", "{port}", "--host", "0.0.0.0"]`. If the
config imports Re.Pack but its CLI (`rock`, or `react-native` for a
`react-native.config.*`) or `@callstack/repack` 5 is not installed,
`stim start` refuses with `STIM_REPACK_BIN` and names the version it found,
instead of falling back to Expo.

Try it with an agent:

```text
Run stim start in this app and tell me which dev server Stim picked and which
file decided it. Then run stim android and check that the launch is verified.
```

## Start Metro with your own command

Some apps only start Metro through their own command, for example an app
inside a monorepo whose packages need the repository's Babel setup. Set
`metro.command` in the app's `.stim.json` to the argv that starts it, and pass
`{port}` where the port goes:

```json
{
  "metro": {
    "command": ["node", "../react-native/cli.js", "start", "--port", "{port}"]
  }
}
```

Stim runs it from the app directory without a shell, in its own process group,
and replaces `{port}` with the workspace's reserved port. Metro must keep
running from inside the app directory, which is how Stim proves it belongs to
the app. Set it in the workspace layer or the app's `.stim.json`. `stim start --reset-cache` refuses for this server: put the
command's own reset flag in `metro.command` instead. Windows is not supported.
The output is captured as text, with levels inferred from each line, under
`command_stdout` and `command_stderr` events. Stim adds no reporter to this
server, so `stim ios` and `stim android` report the launch as unverified;
check `stim logs --source metro` for the bundle lines.

Try it with an agent:

```text
This app only starts Metro through its own command. Add a metro.command entry
to its .stim.json that runs that command with {port}, then run stim start and
show me stim logs --source metro.
```

## Choose the port

Stim picks a free Metro port from 8082 up. It finds listeners in the native
TCP table (`netstat` on macOS and Windows, `/proc/net/tcp*` on Linux). When
that table is denied, empty or unreadable, as in some sandboxes, it checks each
port with `lsof` and connects to `127.0.0.1` and `::1` instead. If none of
these can answer, `stim start` refuses with `STIM_PORT_INSPECTION_FAILED`.

When a workspace's own tools already expect a port, set it with the
`metro.port` setting or `STIM_METRO_PORT`, and Stim reserves that number
instead. A committed value
suits a single checkout. Give each worktree its own, in the workspace layer or
the environment: `stim start` refuses with `STIM_BAD_ARG` when another
workspace reserves the port or another process holds it.

Another process, such as a second Stim home, can take the port between
Stim's check and the dev server's bind. Without a pin, `stim start` then
releases the reservation, reserves another free port and starts again, up to
three attempts. A pinned port and `--remote` starts are not retried.

<StimTabs code={`stim settings set metro.port 25062 --scope workspace`} />

Changing the pin while this workspace's dev server runs is refused until
`stim stop`; an unverified supervisor also blocks the change until you stop it
with the tool that started it. You can also unset or restore the pin. A foreign process on the pin is refused before
anything starts or the port is reserved. This project's own Metro already
on the pin is attached to. `stim web` follows the same rules when its page
uses Metro.

For `stim ios` and `stim android`, `--no-metro-check` uses the pin, then the
recorded port, then 8081, without probing, reserving or writing the registry.
An invalid pin still refuses with `STIM_BAD_ARG`. Release builds skip Metro.

## Idle stop

After 15 minutes of inactivity by default, Stim can stop Metro, keep its port, shut down owned devices and clear regenerable build output. The next Debug run starts Metro again.

Stim counts commands, builds, Metro bundle and HMR requests, device input and active leases. App logs and a view that only streams frames do not count. Running builds, live shares and pinned workspaces are protected. Custom Metro commands, Re.Pack and Expo SDKs before 54 do not report enough activity for idle stop.

Set `idle.minutes` to `0` to disable idle stop. Under [disk pressure](./build-caches.md#disk-pressure), cleanup can act after two idle minutes.

<StimTabs code="stim settings set idle.minutes 60 --scope workspace" />

### Resume after an idle stop

An app relaunched while its dev server is stopped shows "could not connect" or
a blank screen. [`stim revive`](./commands.md#revive) resumes exactly what the
idle stop paused, and nothing more: it restarts the dev server, boots the owned
simulators and emulators the app last ran on, and relaunches the app from cold
from the build cache entry that launch installed. In-app state is gone. It
never builds, and never creates or adopts a device. For an app that runs
without Metro, such as an Exact app, it boots the owned simulator and
relaunches the app installed there.

<StimTabs code={`stim revive`} />

:::tip[Ask your agent]

```text
The app shows "could not connect" after a pause. Run stim revive, then verify
the app's UI again and check stim logs --errors.
```

:::

## Idle workspace stop

Automatic maintenance can stop a workspace with a device or app hosted on a remote Mac after six hours of inactivity. This ends the hosted session and releases the Metro port. If the host cannot confirm the session's state, Stim keeps the workspace.

Set `maintenance.idleStopHours` to `0` to disable this timeout. The worker has a separate timer for clients that disappear. [Hosted idle sessions](./remote-machines.md#hosted-sessions-stop-when-they-are-idle)

<StimTabs code="stim settings set maintenance.idleStopHours 1 --scope workspace" />

## Why the dev server stopped

When a dev server stops, stimd records the cause in the
`supervisor_stopped` line of the timeline and in `stim status`, which prints it after `not running` while
the workspace keeps its port. `stim stop` releases the port, so its own stops
show only in the timeline. In `--json`, the environment's `metro.lastStop`
carries it:

| `reason`        | Meaning                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requested`     | A Stim command stopped it. `by` names the command: `stim stop`, `stim worktree remove`, `stim gc`, `stim start --reset-cache`, or `automatic maintenance` with its [idle reason](#idle-workspace-stop). |
| `signal`        | A SIGTERM or SIGINT with no Stim stop request recorded, so it likely came from outside Stim.                                                                                                            |
| `server-exited` | The dev server exited on its own. Expo CLI also exits with code 0 on SIGTERM, so exit code 0 with no request usually means something outside Stim signalled the Expo process.                           |
| `idle`          | [Idle stop](#idle-stop).                                                                                                                                                                                |
| `vanished`      | The dev server is gone and recorded no cause, usually after a machine restart or when its helper was killed too. `stim stop` logs `supervisor_vanished`.                                                |

## Watchman roots

A Metro that uses [watchman](https://facebook.github.io/watchman/) registers a
watch root in the shared watchman daemon and never removes it. Bare React
Native Metro uses watchman whenever it is installed. Expo SDK 56 and later use
it only when `metro.config.js` sets `resolver.useWatchman` to `true`.

When stimd stops a dev server it started, it runs `watchman watch-del` on the
root its Metro registered, once no other client subscribes to it or has a
trigger on it. It only
removes a root that appeared after the dev server started, contains the
workspace and carried this Metro's subscription. It never starts the watchman
daemon and leaves other roots alone, including those jest registers. The
timeline records `watchman_root_removed`, or `watchman_root_kept` with the
reason. A
dev server that dies, or one a restarted stimd took over, leaves its root; remove it with
`watchman watch-del <root>`.

Removing a root stops watchman from recrawling it. The daemon's memory
footprint shrinks only when the daemon restarts, which also drops every other
client's watches.

## Launch readiness

`stim ios` and `stim android` open the installed app, then check launch
evidence. Debug runs observe Metro; when bundling finishes within the wait
window, Stim also observes up to three seconds of launch logs, fewer once the
app's JavaScript reports `Running "<name>"`. The summary can report
that bundling is still in progress or that launch is unverified. If the wait
window closes and the app process is gone, the run fails with `the app process
exited` and the device log's errors instead. Release runs check process
liveness without Metro.

The wait for the app's bundle request is 20 seconds. An Expo development
client asks the dev server for its manifest before it asks for the bundle, and
Expo recomputes the project fingerprint for every manifest request when the
app uses the fingerprint runtime version policy, so a loaded machine can spend
most of the window there. Stim records each manifest request
from the launched platform in the metro log, as `manifest_request_started`,
`manifest_request_finished` or `manifest_request_failed` at `debug` level, and
counts it as progress: the wait stays open while a manifest request is in
flight and for 15 seconds after one was served, up to 60 seconds after the
launch, whatever the target; a new or adopted emulator already waits 60 seconds. A manifest is not launch evidence. `launched` is `true` or `"bundling"`
only after the app's bundle request, and a launch that never makes one still
ends `unverified`. Bare React Native has no manifest request and keeps the
20-second window.

When the app is already running, from an earlier run or because the install
was skipped, Stim restarts it the way Xcode's Run does: `simctl launch
--terminate-running-process` on a simulator (a separate `simctl terminate` when a
dev client opens through a URL), `am force-stop` then a fresh launch on an
emulator or an Android phone. The launch line reads `restarted running app (was pid <n>)`, and state
held in the running app is lost. An iPhone run already restarts the app through
devicectl, and remote targets relaunch it through Agent Device. If the running
app cannot be stopped, the run fails instead of reusing the old process.

For an unverified debug launch, follow the printed remedy. An Expo development
client may need its server picker; a bare app on a local simulator or emulator
gets a process restart command.

Stim reports bundle, red-screen, and fatal launch errors when those signals are
available. These checks do not prove that a screen rendered correctly.

A nonfatal error still appears as launch evidence. The agent can read the error
and decide whether the change caused it.

Only the human `ios` / `android` launch summary shows up to **10 frames per error,
component, or native stack**. App-source frames take priority over dependencies;
selected frames remain in captured order, followed by the omitted-frame count.
Error stacks describe the call path; component stacks describe the React parent
tree. They are labeled separately. Every `stim logs` command, including
`stim logs --errors`, shows full captured stacks without frame or message-length
limits. The separate default limit of 20 error records never shortens a stack.
Use `--source all` for all log sources, or `--json` for raw records. Text
truncated by the runtime before capture cannot be restored.

A run that builds or reuses an app and then fails before the app is running adds one
`build` error record with event `run_failed`, the error code and the phase it failed
in, so `stim logs --errors` lists the failure that `stim status` shows.

When stimd dies or its logs worker fails, the device log gets one `collector_interrupted` warning with the gap and the reason, and Stim backfills the gap where the platform still holds those lines; `--errors` does not list it.

Symbolication is best effort. In development, Stim asks the verified workspace's
Metro `/symbolicate` endpoint to resolve captured JavaScript coordinates, with a
short timeout and the original coordinates as fallback. Resolved launch context
is saved separately so it remains readable after Metro stops. Expo's printed source
excerpt and stack lines are included when available, even when Stim's own bundle
response records land between them. With `--errors`, this holds in human, `--json`,
and `--follow` output. `--json` keeps the error's `msg` as captured and adds those
lines as a `context` array of strings on the error record. `--follow` waits for
one quiet settle check, about 500 ms, before it prints an Expo error, so its lines arrive
with it. Uncorrelated bare React Native
symbolication events remain explicitly separate context. Shortened bundle locations
are labeled **unsymbolicated**, and a component stack is never used
to invent a missing error stack. OS logging can truncate text before Stim captures
it; “full” means the records actually captured, not a recovered original stack.

Copies from different sources are combined only when their error title, stack
location, platform compatibility, and timing match. Raw copies remain available
with `--json`; repeated errors from the same source are not suppressed.
Human queries can add a correlated device component stack to a selected Metro
error; unrelated device errors are never added as context.

#### Native crashes

On iOS simulators, Stim attaches stdout/stderr on a cold launch and passes Expo's
initial project URL directly, so
an early Swift fatal error or uncaught exception can appear in the launch result.
Console redirection uses the app's writable cache, including when `STIM_HOME` is
on an external volume; captured crash evidence is retained in the workspace logs.
OS crash reports can take about a minute or longer to arrive: rerunning
`stim logs --errors` collects them before you stop or release the simulator.
An OS report of an abort carries the Rust panic messages, such as an Exact
app's, that the app wrote to stderr.
Reports are matched to the app, simulator, and launch time. Existing source locations
and symbol names are retained, and app addresses are resolved with
`atos` only when the local binary's UUID matches the report. Android reads the
crash logcat buffer, including reports emitted outside the dead app's PID. Java
exceptions retain their stack; C/C++ frames use matching local ELF build IDs and
NDK tools where available. Unavailable symbols remain explicitly unresolved.
Android can keep a crashed Java process alive behind its system crash dialog.
Stim treats the crash report as failure even when the PID exists. Fix the error,
then rerun `stim android`, which force-stops that process before launching.

Confirmed app-crash reports are included in default `stim logs --errors` without
including general OS error noise. Use `stim logs --source device --json` for full
captured reports. A missing report is not proof that the app did not crash: OS
reports can be delayed, physical iPhone capture is console-only with no historical backfill, and stripped or
remote builds may not have matching local debug symbols. This does not download
symbols or replace Xcode/Android Studio's full crash-analysis tooling. Physical iPhone launches remain unverified because console output cannot prove complete readiness coverage. Different native timestamp spellings or clock alignments can leave duplicate backfilled records.

For delayed reports, rerun `stim logs --errors` before stopping or releasing the
device. Collection requires the workspace's current launch and device ownership
or lease; after release, already-captured reports remain available without
collecting another workspace's crashes.

Non-follow human queries enrich errors; `--follow` streams captured records and
does not continuously poll OS crash reports. `--json` preserves raw evidence; its
only addition is the Expo `context` field described above.
Stim does not resymbolicate an older error after a recorded Metro rebuild.
Historical unsymbolicated JS coordinates require
the matching bundle/source maps, not an unrelated rebuilt Metro bundle.

### Recommended app-declared readiness

No package or monitoring SDK is required. In a debug app, emit this once at
startup, before initialization that can block the first screen:

```ts
if (__DEV__) console.info('[stim:readiness] pending');
```

Emit the second line when essential initialization succeeds, usable content is
rendered, and the splash screen is hidden:

```ts
if (__DEV__) console.info('[stim:readiness] ready');
```

For example, in an Expo root layout with an existing `isReady` state:

```tsx
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';

if (__DEV__) console.info('[stim:readiness] pending');

// Inside the root component:
useEffect(() => {
  if (!isReady) return;
  let active = true;
  SplashScreen.hideAsync()
    .then(() => {
      if (active && __DEV__) console.info('[stim:readiness] ready');
    })
    .catch(console.error);
  return () => {
    active = false;
  };
}, [isReady]);
```

Use the app's real readiness condition, not an arbitrary timer or merely a
mounted root. Cover login, onboarding, and deep-link destinations. Never emit
`ready` from a failure handler or a `finally` block.

Static imports run before module-scope statements. To cover initialization in
imported modules, emit `pending` from an earlier app entry module before loading
that work. An error before `pending` still uses the default check.

Without an observed `pending`, Stim keeps its default three-second stability
window after bundle delivery. The window ends early, half a second after the
app's React Native runtime logs `Running "<name>"` for this launch on either
platform. A fatal record or an exited process before the window ends still
fails the launch. An error after it, such as a first render that takes longer
than that half second to throw, appears in `stim logs --errors`. Managed Metro
servers report when the native bundle response finishes; build-complete output alone does not close an observed
request. Without response capture, Stim falls back to the build-complete marker.
When Android reports queued JavaScript loading, Stim waits for device JavaScript
activity before starting stability, bounded by the bundle timeout.
Debug Android launches on an owned emulator that the run creates, or whose
adoption from the pool it finishes, get a 60-second bundle timeout, reported in
the verify phase. Existing emulators,
remote targets, and physical devices get 20 seconds, extended up to 60 while an
Expo development client's manifest request is pending or was just served. Fatal errors
still end verification immediately.
A `pending` observed before that window closes, early end included, opts into waiting for `ready`, up
to 30 seconds after the same completion signal.
Repeated `pending` logs do not extend the deadline. A matching `ready` can end
the wait early; an app error or process exit interrupts it. A missing `ready`
prints **readiness not confirmed**, not success or an inferred crash.

Stim reads exact standalone messages from this app's platform-specific device
log, after the current launch. Stale, other-platform, error-level, and embedded
example messages are ignored. Unlabelled shared Metro output cannot identify
which platform is ready. If device-log capture is unavailable or `pending` is
not captured in time, the default check applies. On a simulator or emulator
hosted on another Mac (`--remote <machine>`), the device log is the copy Stim
pulls from that Mac during the launch check, so each window waits up to 10
seconds for the copy to cover it. Release runs and `--no-metro-check` do not use
this debug-only integration.

This is the app declaring readiness, not visual verification. It does not alter
the `launched` JSON field: bundle/process evidence remains separate. Continue
checking the expected UI and `stim logs --errors`. For agent implementation
instructions, run `stim guide lifecycle readiness`.

#### Ask your agent to add it

Copy this prompt into your coding agent:

```text
Add the recommended Stim app-readiness logs to this app. Read `stim guide agent`,
then follow `stim guide lifecycle readiness` from the installed CLI. If Stim
is not installed globally, use `npx stim` instead of `stim`.

Use the app's existing initialization and splash-screen lifecycle without
adding a package or monitoring SDK. Cover its real startup destinations,
including login, onboarding, and deep links; never report ready after failure.

Verify a normal launch, a slow successful launch, a missing ready signal, and
a startup error on the supported platforms. Remove temporary test delays and
errors afterward. Report the changes, observed readiness output, and any
validation you could not complete.
```

## Query the timeline

Local follow uses filesystem change hints, with a ten-second repair scan for
missed events or directory replacement. While its directory watch is unavailable,
it retries and scans every 500 ms. Expo context settling uses a timer only while
an error is pending. Local agent actions follow state and claim directory changes
with the same repair cadence; active hosted log queries retain their pull cadence.
Attachment schedules one 500 ms recovery scan. A moved log directory on Windows
can require the ten-second repair scan.

<StimTabs
code={`stim logs --errors
stim logs --source client --since 5m
stim logs --follow --level warn
stim logs --source agent --follow
stim logs --errors --json`}
/>

The merged timeline includes Metro, client, device, and build records, and the
actions [agent-device](https://github.com/callstack/agent-device) takes on
the workspace's owned simulators, emulators and native Mac app. For hosted iOS
and Android, `stim agent-device` records the command name and result locally.
The host keeps the detailed action records. Logs live
in the global workspace directory under `$STIM_HOME/workspaces`, not in the
project checkout. The Metro, client, and device files are capped at about 8 MiB each.
Stim keeps one previous generation of each file, and queries read both. The oldest
records are dropped first. A file written before Stim capped it can be much
larger. `stim gc --dry-run` reports each workspace's log size, and `stim gc` trims
a file over 16 MiB to its newest 8 MiB in workspaces that are not in use. See
[`gc`](./commands.md#gc).

Exit code 0 means the query succeeded, including when it prints errors. A clean
`stim logs --errors` check requires exit code 0 and no matching errors in the
captured logs. Human mode prints `No matching log records` on stderr for zero
matches; JSON mode writes NDJSON and writes zero bytes for zero matches. A
workspace that has never produced a timeline refuses with `STIM_NO_PROJECT`
and, in a monorepo, names the nearest registered descendant app with logs.

### Placement decisions

A `stim ios`, `stim android` or `stim macos` run that decides where to build or host records where it put the
build and the device. Read the records with:

<StimTabs
code={`stim logs --source placement
stim logs --source placement --json`}
/>

A record has the settings that applied (`remote.build` for a build,
`ios.remote` or `android.remote` for a device) with the layer each came from (`flag`, `env`,
`setting` or `default`), each remote machine that was checked with a reason code
(`accepted`, `unreachable`, `busy`, `disk`, `load`, `version-mismatch`,
`no-matching-device`, `declined`, `memory`, `no-capacity`) and the human
message, the choice (`local` when the run stays on this machine), and a `fallback`
with its reason when a remote machine that was meant to take the run did not.
Records stay in the local logs and include remote machine names. A new run replaces the
previous run's records, because they sit in its build log.

Try this with your agent:

```text
My last stim ios run built on this machine. Read stim logs --source placement --json
and tell me which remote machines were checked, why each was skipped, and which
setting decided it.
```

### Agent-device actions

When an agent drives an owned simulator or emulator with agent-device, `stim logs
--source agent` shows each action as an `info` record with source `agent`: taps
with their coordinates, typing (agent-device redacts the text), app opens, and
screenshots. A failed
agent-device command is an `error` record. Stim reads agent-device's own session
records under `~/.agent-device` (or `AGENT_DEVICE_STATE_DIR`) plus existing
workspace agent-device directories. The only file it writes there is the
workspace directory's boot hook, described below. An iOS session is matched to a simulator through its runner log, including
a session that moved between simulators. An Android session is matched only
while agent-device holds its claim on the emulator, so its actions drop out of
later queries once agent-device releases the claim. Records from a newer
agent-device format that Stim does not recognize are replaced by one `warn`
record saying the session's actions are not shown.

Native Mac sessions match the workspace's isolated bundle ID and current app
launch, using a recorded open with explicit `--surface app`. App switches and
unrecorded lifecycle attempts clear the match, as do event-log rotation and
unknown formats. Native screenshot events are omitted because their surface
override is absent from the event metadata. See [native Mac agent actions](./macos.md#agent-actions)
for the app-scoped command and limits.

[`stim agent-device`](./commands.md#agent-device) runs agent-device in this
workspace's state directory, on its device (a hosted session keeps
agent-device's own), so its actions appear here with no
setup. For agent-device you run directly, use the `agentDevice.stateDir` reported by
`ios`, `android`, `macos`, or each `status --json` environment. Read it once
from `status`, run from the app root, and prefix each agent-device command:

```sh
STATE_DIR="$(stim status --json | jq -r '.environments[] | select(.path=="'"$(pwd -P)"'") | .agentDevice.stateDir')"
AGENT_DEVICE_STATE_DIR="$STATE_DIR" agent-device open <bundle id> --platform ios --session <name>
AGENT_DEVICE_STATE_DIR="$STATE_DIR" agent-device snapshot --session <name>
```

Sessions, logs, metro-sessions, allocations and daemon files live under
`$STIM_HOME/workspaces/<name>/agent-device/`. The Apple runner build cache and
device claims stay shared: leave `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` and
`AGENT_DEVICE_CLAIMS_DIR` unset. Each active workspace adds one daemon, which
exits after five idle minutes with no open session. This is opt-in per command; forgetting the
variable uses `~/.agent-device`.

`stim start`, or a `stim ios` run of an app without Metro such as an Exact app,
also writes `boot-hook.json` into that directory. An agent-device
that reads it runs [`stim revive`](./commands.md#revive) when the simulator or
emulator it was asked to use is shut down, instead of booting the device
itself, then checks that the device is booted. The device comes back through
Stim's device admission with this workspace's Metro running, instead of an app
that relaunches without Metro and shows "could not connect". When revive
refuses, agent-device fails with an error that quotes revive's output.
`stim stop` closes owned-device sessions there; `stim worktree remove` stops its
daemon and removes the directory. Hosted/stim-server sessions already use their
own state directory and need no export.

:::tip[Ask your agent]

```text
Read stim guide agent, inspect the app with stim agent-device, and check
stim logs --source agent.
```

:::

`stim stop` has stimd stop the dev server, and ends the log collectors. It also frees the reserved
port and shuts down the owned local device. On Windows, if the daemon crashes or a log stream exits before its process tree is stopped, Stim retains an unresolved claim. Verify the daemon, launcher and descendants are gone, then remove only the pending child marker using the exact command in the refusal and retry.

When `stimd` restarts on another Stim build, it stops each simulator and
emulator log collector, and the new `stimd` starts it again. `device.ndjson`
misses the lines the app logs between the two, about the time `stimd` takes to
restart. The new `stimd` skips a collector whose workspace was stopped after the
restart began, and notes it in its own log. One whose device or app is gone
starts and then ends, as any collector does: `device.ndjson` records it as
stopped or failed. A `stimd` attached to a command (CI, sandboxes) starts none
and leaves them to the next detached `stimd`. A physical
iPhone's console is not restarted, because that would launch the app again; it
holds the restart until `stim stop`.

## Named server ports

Allocate a port in the workspace whose server you want to isolate:

<StimTabs
code={`stim ports get web
pnpm exec vite --port "$(stim ports get web)" --strictPort

# In another terminal in this workspace:

stim ports
stim ports stop web --dry-run
stim ports stop web`}
/>

Stim keeps allocations in its machine registry and never starts or supervises these
servers. It checks new allocations for existing listeners and skips busy
ports in the 8900–8999 band, announcing retries on stderr. Allocation checks
listeners the same way as Metro's, falling back to `lsof` and loopback
connects when the TCP table cannot be read, and refuses only when none of them
can answer.

A repeated `get` returns the same number even while the server is listening.
The reservation does not hold a socket open: another process can bind it
between allocation and launch. Use the server's strict-port option when
available, and check that it actually bound the supplied port.

`ports stop` kills the TCP listener regardless of its working directory and
prints its PID and command. Stopping listeners requires `lsof` on macOS and
Linux, or `netstat` on Windows. Reserve a port only for a service this workspace
may stop. Use `ports release` to forget the allocation without killing the
server. Both leave Metro alone. `worktree remove`, `gc` and automatic
maintenance release named allocations without stopping their listeners.

Allocations belong to the nearest directory with a `package.json`, resolved
through symlinks. In a monorepo whose web app lives in its own package, a
package that depends on neither `react-native` nor `expo` uses the one Stim app
registered in the same Git worktree, and stderr names it. `web`, `settings`,
`logs`, `reload`, `stop` and `status` follow the same rule. Register the app
first by running `stim ports get web`, `stim start`, `stim ios` or
`stim android` from the app directory, then run `ports` from the web package:

<StimTabs
code={`cd apps/web
pnpm exec vite --port "$(stim ports get web)" --strictPort`}
/>

Every `ports` command there acts on the app's ports. A package that already
holds ports keeps them until you release them. With no registered app in the
worktree, or more than one, the nearest package keeps the allocation; run
`ports` from the app directory instead.

Shared services are not modeled: pass a shared service's port through the
environment instead of allocating one per worktree.

Copy this prompt into your agent:

```text
Read stim guide ports. Allocate a web port for this workspace, start the web
server using that exact port, and verify it is serving this checkout. When
finished, stop its named port with stim ports stop web.
```

## Reverse ports

An app on a workspace's device reaches Metro through a route Stim sets up. For any other server on this machine, `ports reverse` does the same at the server's own port, like `adb reverse`:

<StimTabs
code={`stim ports get api
stim ports reverse api
stim ports reverse 4318
stim ports reverse --remove 4318`}
/>

The argument is a label from `ports get` or a raw port that a tool of this workspace listens on. Stim records up to 16 ports in the workspace and applies them to the devices it has now; running the command again repairs a reverse that was lost. How a device reaches the port depends on the device:

| Device                                       | What happens                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local iOS simulator                          | Already reachable: a simulator shares this Mac's loopback. Nothing is applied.                                                                                                                                      |
| Local Android emulator                       | `adb reverse tcp:<port> tcp:<port>`, applied again by `stim android` when it launches the app and by `stim reload android` when missing. `stim status` reports `android-reverse-missing` when the emulator lost it. |
| Android phone (`android --device`)           | `adb reverse`, removed by `stim stop` and `worktree remove` with the Metro reverse. Stim removes only the ports it recorded.                                                                                        |
| iPhone (`ios --device`)                      | Refused. USB carries no reverse forward.                                                                                                                                                                            |
| Hosted iOS or Android (`--remote <machine>`) | Bridged through the client's links to the host; see [Reverse ports on hosted devices](./remote-machines.md#reverse-ports-on-hosted-devices).                                                                        |

`stim stop` removes the reverses from the devices and keeps the recorded ports, so the next launch applies them again. `worktree remove`, `gc` and automatic maintenance forget them with the workspace. `ports release` and `ports stop` remove a label's reverse before they free the port. An EAS Simulator session (`--remote eas`) cannot reach this machine, so it is not reversed.

Appduct and similar tools that connect from the app back to a daemon advertise an address in a one-time link. Set that address to the loopback, reverse the daemon's port, and deliver the link with `agent-device`:

<StimTabs
code={`# ~/.appduct/config.json: "advertisedIp": "127.0.0.1"
stim ports reverse <appduct daemon port>
appduct sessions link --open ios-sim   # prints or opens the link
stim agent-device open <app> "<link>"`}
/>

Copy this prompt into your agent:

```text
Read stim guide ports. My tool listens on port <port> on this machine. Make it
reachable from the app on this workspace's device at localhost:<port> with
stim ports reverse, and confirm from the app that it connects.
```

## Managed tunnel for remote devices

`stim start --remote` (or an `ios.remote` or `android.remote` backend) gives a remote device a
public URL for Metro. With `metro.tunnel` set to `auto`, `ngrok`, `cloudflared` or `tailscale`,
stimd starts and supervises the tunnel as one of its children, so it keeps running after `stim start`
returns and a restarted stimd takes it over. In `auto` stimd tries ngrok and then cloudflared. `stim stop` and
`stim worktree remove` end the tunnel through stimd, and `stim status --json` keeps reporting its provider and URL.
A tunnel an older Stim started is reused or stopped by its recorded process identity.

After an upgrade, a daemon from Stim 1.40 to 1.42 can still hold this Stim home,
because it runs until every workspace has been idle for `idle.dormantDays`. stimd
stops it by its process identity when it starts, and your dev servers and devices
keep running. If the holder cannot be verified as that daemon, or does not stop,
`stim start` and the other commands that need Metro or a managed tunnel report its
PID and the command that stops it.

## Metro for hosted iOS

`stim ios --remote <machine>` keeps Metro here and needs no `stim start --remote`.
Hosted Debug runs require a dev server stimd runs and a host stim-server that support
client-opened Metro links before reserving the simulator. `--no-metro-check`
refuses; restart a missing or older dev server with `stim stop; stim start`.
stimd keeps a few authenticated connections open to the host for each
session. The host's bridge listens only on loopback and pairs each connection
the simulator makes with one of them, which stimd forwards to this
Metro. The host never connects back to this machine, so a host shared into your
tailnet, or one your ACLs only let you reach on its stim-server port, works.
`metro.tunnel` and `metro.publicUrl` are ignored. Non-Debug runs
skip Metro. A recorded hosted session prevents the dev server's idle stop; stop or a stopped host
session closes its links. The [idle workspace stop](#idle-workspace-stop) still applies. Native device records are pulled by `stim logs` and
`stim logs --errors` from adaptive, bounded host queries. Followers share a
throttled collection without blocking app delivery, view or control. Stop limits each log drain
to 30 seconds with progress on stderr and a no-progress guard. The host
also collects a bounded final tail before deletion on stop, revocation or close;
stop copies it back afterwards. Native windows overlap by five seconds and
de-duplicate, but read persisted entries only, so info-level or entries persisted
later than the overlap may be unavailable. Copied records remain readable afterwards. An older host prints an update note
and shows logs already copied here. See [hosted iOS](./owned-devices.md#run-ios-on-another-mac).
