---
title: 'Command reference'
sidebar_position: 1
description: 'Every Stim command and option'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If Stim is not installed globally, replace `stim` with
`npx stim`.

:::

Run `stim <command> --help` for parser help. Run `stim guide` for the full
reference that ships with the installed version. Every refusal code has an
entry in the [troubleshooting reference](./troubleshooting.md).

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android
stim logs --errors
stim stop`}
/>

`ios` and `android` require a running dev server for a Debug build. Release
builds embed the JavaScript bundle and skip that requirement.

`reload` is a recovery command that reloads JavaScript in the live app and never
restarts it. Use it when an error screen remains after a fix, not after every
JavaScript edit. It also recovers an Android app whose first bundle failed; an
iOS app in that state never connects to Metro, so reload cannot reach it.

## Named device slots

`ios`, `android`, `device lock`, `device unlock`, `logs`, and `stop` accept
`--slot <name>`. Omitting it selects the default target for a device run;
plain `logs` and `stop` still cover the whole workspace. `status` lists every
slot. Slots can hold multiple simulators of the same model as well as physical
devices. See [multiple devices with slots](./owned-devices.md#multiple-devices-with-slots)
for commands, a copyable agent prompt, and shared-server limitations.

## `doctor`

```text
stim doctor [--platform <ios|android>] [--json] [--fix]
```

Inspects the current app and, in a repository with linked worktrees, the source
checkout's fitness as a seed. It reports missing or stale dependencies,
CocoaPods state, cache conflicts, device capacity, remote session problems, and
a linked native library whose Git metadata enters the fingerprint. On a
checkout without installed dependencies, it also reports fingerprint
differences against a fresh worktree. The checkout is left untouched unless
`--fix` is passed.

`--platform ios` or `--platform android` limits native findings to that
platform while keeping shared project checks. Each run in a React Native or
Expo app is recorded per platform in Stim's state for this project, which also
registers the project for `stim status`, and a run without `--platform` counts
for both, so `stim guide` can tell when doctor is due again. A run in a
directory that is not an app records nothing.

Doctor also prints the running CLI version and the `stim` installation resolved
from `PATH`, and flags a resolved installation that is older than another
available one.

`doctor` also flags when an agent harness sandboxes shell commands and Stim is
not allowed through it, which shows up as unrelated-looking failures against
the simulator service, the adb server, and Stim's own state directory.
For that finding, `--fix` writes the missing allowance into `.claude/settings.local.json` at the
repository root, the per-user file, merging it with whatever is already there
and preserving other settings. It cannot add a Codex allowance because that
sandbox has no per-path allowance to add. This repair runs only when the
report shows that finding, so an unsandboxed session leaves the file alone.
See `stim guide errors sandbox` for the failure signatures and the manual
settings.

Unless `--platform ios` is selected, `--fix` also removes stale ignored,
untracked Android `.cxx` configurations with obsolete compiler launchers,
including those in installed native modules. Stop native builds before this
repair: its cache-lock check cannot detect uncached, release-swap fallback, or
direct Gradle builds. The next build recreates these files; source, custom launcher settings,
and shared ccache entries are preserved. See `stim guide lifecycle options`.

## `ports`

```text
stim ports
stim ports get <label>
stim ports stop [label] [--dry-run]
stim ports release [label]
```

Reserves TCP ports 8900–8999 for web or API servers started by the
project. `get` prints only the number and reuses an existing allocation.
New allocations skip reserved and occupied ports; retry notices go to stderr.
`ports` lists named allocations and Metro, marked managed.

Labels start with a letter and contain up to 64 letters, digits, underscores,
or hyphens. `metro` is reserved for `stim start` and `stim stop`.

`stop` terminates listeners on the selected named ports, including processes
outside the workspace, and prints their PIDs and commands. It sends SIGTERM,
then SIGKILL after two seconds if needed. `--dry-run` previews without killing
or releasing. Failed stops retain the allocation. `release` removes the
reservation without signalling the server. Omit the label to select all named
ports. Neither command touches Metro; `stim stop` leaves named ports alone.

`worktree remove` stops and releases named ports. `gc` reports allocations for
missing workspaces, and `gc --delete` stops and releases them. Unmounted or
unresolved workspace paths remain registered.

See [server examples and limitations](./dev-server-and-logs.md#named-server-ports).

## `start`

```text
stim start [--wait <seconds>] [--remote] [--reset-cache] [--json]
```

Starts the project dev server on the workspace's reserved port. Stim supervises
the process and captures its output. A healthy existing server for the same
project is reused.

- `--wait <seconds>` changes the startup timeout. The default is 60 seconds.
  It waits for the dev server; `--wait` on `ios`, `android`, and `device lock`
  instead bounds the wait for a device another workspace holds.
- `--remote` prepares Metro for a remote device.
- `--reset-cache` restarts only this app's verified owned Metro, preserving its
  port and devices, with Metro's own reset (`resetCache` on a bare server,
  `expo start --clear` on Expo). Every store in the app's Metro config is
  cleared, including this app's shared transform store, so other worktrees of
  the same app rebuild their transforms too; the file map is rebuilt. Other
  apps and native build caches are unchanged. Externally started servers are
  left alone, and a failed startup can be retried with `stim start`.
- `--json` prints one stable result object on stdout.

## `ios`

```text
stim ios [--slot <name>] [--scheme <name>] [--configuration <name>] [--device-type <name>] [--runtime <version>]
         [--simulator-app <xcode|siniulator>] [--device [udid]] [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
         [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the iOS app. Stim then boots an owned simulator, installs the
app, opens it, and checks launch logs. Native builds run locally by default;
`--eas-profile` downloads an existing EAS development build.

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--scheme <name>` selects an exact shared Xcode scheme when the automatic
  app selection is not the one you need. Explicit schemes have separate build
  caches and DerivedData. This is a build scheme, not the app's URL scheme.
- `--device-type <name>` creates this workspace's owned simulator as that model,
  overriding `ios.deviceType` for one invocation. A model no installed runtime
  can create refuses with `STIM_BAD_ARG` and prints the ones they do offer.
- `--runtime <version>` creates it on that iOS runtime, overriding `ios.runtime`
  the same way. It takes a version (`26.5`) or a runtime's full name
  (`iOS 26.5`), exactly.
- `--simulator-app <xcode|siniulator>` overrides the machine `iosSimulatorApp`
  preference for this run. It also opens an already running owned simulator in
  that app without rebooting it. The preference is not saved. Local simulators
  only; cannot be combined with `--device` or a remote target.
- `--device [udid]` builds, installs, and launches on a connected iPhone instead
  of the owned simulator. With no UDID it takes the first connected device it
  can lease. It cannot be combined with `--remote`. Stim never creates, boots,
  or deletes hardware.
- `--wait <seconds>` bounds the wait for a physical-device lease (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including when another workspace holds the
  device. Installing the same app terminates that workspace's running app.
  Only with `--device`; cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote simulator.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. A miss stops and prints an EAS build command;
  cloud builds require authorization. Cannot be combined with `--scheme`,
  `--configuration`, or `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server gate.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--json` prints one stable result object on stdout.

A non-Debug configuration embeds its JavaScript bundle.

A locally compiled device build is local-tier only. Its cache key ends `-device`, so it cannot
collide with a simulator build, and no build-cache provider or Expo remote cache
is read or written on that path, because every entry they hold is keyed
for the simulator. `--eas-profile <name> --device` uses EAS CLI's artifact cache and
installs the signed app without re-signing it.

A `--device` run installs with `devicectl device install app` and launches with
`devicectl device process launch`. The iPhone can be cabled or paired over
Wi-Fi. With no UDID, a cabled iPhone that is paired and has Developer Mode on
is taken first, and a Wi-Fi one only when there is none. A Wi-Fi run prints one
line saying so, allows the install 15 minutes and the launch 120 seconds, and
fails with `STIM_DEVICE_WIRELESS_FAILED` when devicectl times out or loses the
phone; connect the cable and run again. Every device install is signed, Debug
included, so the app's own `embedded.mobileprovision` must be unexpired and must
name the phone, and the identity it names must be in this machine's keychain
whenever Stim modifies the bundle.

In Debug the phone reaches Metro over the LAN, because it shares no loopback
with the host and USB carries no reverse forward. Stim gates a non-internal IPv4
address as this workspace's Metro, then hands it to the app: an expo-dev-client
app through the deep link (`--payload-url`), a bare app by writing
`<addr>:<port>` into a copy of the bundle's `ip.txt` and re-sealing that copy.
The cache entry is never modified. Set `ios.lanHost` when this Mac has several
interfaces and the phone shares one that is not the first.

Two things a phone needs that a simulator does not, both one-time and both taps
on the phone: trusting the developer certificate under Settings > General > VPN &
Device Management, and allowing the Local Network prompt the first time the app
looks for Metro. Neither can be pre-granted from this Mac. The trust tap has no
API at all and is always the user's; the Local Network prompt can be accepted by
a device tool once it is showing, and Stim's `unverified` remedy prints those
commands when this launch's device log carries iOS's path reason for an
ungranted app. A prior Don't Allow logs the same reason, and the remedy covers
that too. Until it is granted, `launched` comes back `unverified`. Run
`stim guide errors unverified` for the signature and the full recovery.

A `--device` run in a Release configuration builds fresh every time: a cached
Release app carries its builder's JavaScript, and Stim does not swap JavaScript
into cached iOS physical-device builds.

## `android`

```text
stim android [--slot <name>] [--variant <name>] [--system-image <id>] [--device [serial]]
             [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
             [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the Android app. Stim then boots an owned emulator, installs
the app, opens it, and checks launch logs.

- `--variant <name>` selects a Gradle variant. The default is `debug`.
- `--system-image <id>` creates this workspace's owned AVD from that sdkmanager
  package id, overriding `android.systemImage` for one invocation; an id this
  SDK has not installed refuses with `STIM_BAD_ARG` and prints the installed
  ids.
- `--device [serial]` installs and launches on a connected physical device.
  With no serial it selects a connected device this workspace can lease. It
  cannot be combined with `--remote`.
- `--wait <seconds>` bounds the physical-device lease wait (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including another workspace's lease. Installing
  the same app terminates that workspace's running app. Only with `--device`;
  cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote emulator.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. A miss stops and prints an EAS build command;
  cloud builds require authorization. Cannot be combined with `--variant` or
  `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server gate.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--json` prints one stable result object on stdout.

A variant that ends in `Release` embeds its JavaScript bundle and skips Metro.

## `reload`

```text
stim reload [ios|android] [--json]
```

Requests a JavaScript reload in the live app on this workspace's owned local simulator
or emulator. It never builds, installs, boots, or cold-launches. Omit the
platform when exactly one owned app is live; name it when both iOS and Android
are live.

Every reload goes over the workspace Metro websocket, on both platforms. It never
reopens a development-client URL, because that restarts the app rather than
reloading its JavaScript.

How the message is addressed depends on the dev server, and `strategy` reports
which you got. Where Metro can name its clients, Stim addresses every peer
matching the platform and reports `metro-websocket`. A workspace Metro serves one
app, so those peers are that app on however many devices are attached to the
port; `targets` says how many peers the request addressed. Android peers carry the package
name and iOS peers carry only `role=ios`, which is enough to keep a reload on one
platform but not to single out one iOS app among several.

The bare React Native dev server cannot name its clients at all, because
`@react-native-community/cli-server-api` answers that request out of a `ws`
property removed in ws 3.0. There Stim broadcasts: `metro-broadcast` means every
app on that port was sent a reload request, and that Stim could not confirm the recorded app was
among them. Verify the UI, and fall back to the app's own error screen or dev
menu if nothing changed.

When Metro names its clients and none match the platform, Stim still broadcasts
before giving up, because matching is best-effort and an unmatched peer may be
the app. It reports the miss either way, so verify the UI before acting on the
remedy.

When Metro reports no peer for the app, retry once first: a client reconnects
every 2 seconds, which is also this probe's timeout, so a single miss can be a
reconnect window rather than an app that never connected. If it stays
unreachable on iOS, an error in the first bundle leaves the app without a
packager connection at all, and no retry will make it a peer. The command then
returns instructions to continue in the agent's existing automation session:
press the error screen's Reload button, or open the dev menu and press Reload
when no error screen is showing, and relaunch only when neither is reachable.
Stim does not take over that stateful session.

When Metro itself does not answer within the probe's 2 seconds, nothing is known
about the app, so the command says to retry and check the dev server rather than
sending the agent to the device.

The command refuses release builds, stopped or unowned devices, a missing or
foreign Metro server, and ambiguous selection. `--json` prints one object with
`platform`, `deviceId`, `deviceName`, `appId`, `metroPort`, and `strategy`.
Success, including exit 0 with `--json`, confirms that the request was sent.
The command does not observe completion. Verify the expected UI on the reported
device and inspect `stim logs --errors` before claiming recovery.

## `logs`

```text
stim logs [--slot <name>] [--source <metro|client|device|build|all...>]
          [--level <debug|info|warn|error|fatal>] [--since <duration>]
          [--grep <expression>] [--tail <count>] [--errors]
          [--follow] [--json]
```

Queries the workspace log timeline. No matching records is a successful empty
result.

- `--errors` selects errors and fatals from Metro, client, and build logs, plus
  confirmed native app-crash reports, since the last launch marker. A completed
  bundle attempt resets only older Metro errors. General device logs require
  an explicit `--source device` or `--source all`.
- `--source device` includes operating-system device logs.
- `--follow` streams new matching records.
- `--json` writes NDJSON. Zero matches writes zero bytes.

## `stop`

```text
stim stop [--slot <name>] [--json]
```

Without `--slot`, stops the supervisor and all log collectors, shuts down every
owned local device, ends an owned remote session, and frees the port. Owned
local devices stay assigned for reuse. A dev server left behind by a supervisor
that died is stopped when its recorded process identity still matches. An
external server on the reserved port is left running, the port stays reserved
while that server runs from this project, and a process whose ownership cannot
be verified is not signalled.

With `--slot <name>`, stops only that slot's owned devices and collectors and
releases its leases. Metro, the reserved port, and sibling slots keep running.

On a physical iPhone, stopping the log collector closes the running app.
`stop` also releases this workspace's device leases. It never uninstalls the
app or shuts down the phone; hardware has no owned-device registry entry.

## `device lock` and `device unlock`

```text
stim device lock <ios|android> [id] [--slot <name>] [--for <duration>] [--wait <seconds>] [--json]
stim device unlock [ios|android] [--slot <name>] [--json]
```

Leases a connected physical device to this workspace, so another workspace's
`--device` run waits instead of installing over it. `--for` takes a whole
number of seconds or minutes from `10s` to `30m` and defaults to `5m`;
`--wait` bounds how long to wait for a device another workspace holds
(default 60 seconds, `0` refuses at once). Locking a device this workspace
already holds sets a new expiry, which can shorten it.

With no id, `lock` picks from the connected devices the resolver accepts: the
one this workspace already leases when it is connected, otherwise the first
free one in id order. The same rule serves `ios --device` and
`android --device` with no id, so two devices on one machine no longer refuse.

`unlock` releases every lease this workspace holds, or only the platform
named. Adding `--slot <name>` restricts release to that slot; releasing nothing
is not an error. A `--device` run takes a lease of
its own for the length of the run, so `lock` is for holding a device across
runs, such as a device-tool session. `stim status` lists every lease on the
machine.

## `status`

```text
stim status [--json]
```

Shows every Stim environment on the machine. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.

## `stats`

```text
stim stats [--json]
```

Shows how many `ios` and `android` runs this project and this machine have
recorded, how many hit the build cache, the mean cold run and hit run, and an
estimate of the time the cache saved. Only aggregates are kept, in
`$STIM_HOME/stats.json`; nothing per run is stored, and every worktree of a
repository counts into the same project bucket. Outside a project only the
machine section prints. There is no reset flag: delete that file to start over.

`--json` prints one line:

```json
{
  "version": 1,
  "project": { "key": "/path/to/app", "ios": {}, "android": null },
  "machine": { "ios": {}, "android": null }
}
```

`project` is `null` outside a project, and a platform with no run yet is
`null`. A bucket carries `runs`, `failed`, `hits`, `misses`, `coldRuns`,
`coldRunMs`, `hitRuns`, `hitRunMs`, `timeSavedMs`, `firstRunAt` and
`lastRunAt`, plus `lastColdBuildMs` and `lastPodsMs` once the project has
compiled or installed pods; those two size the progress line a long build
prints (`build       still compiling (1m00s of ~3m10s)`). The saved figure is
an estimate: each cache hit is credited this project's mean cold run at that
moment, minus its own duration, floored at zero.

## `worktree warm`

```text
stim worktree warm [--refresh]
```

Copies missing ignored entries from the repository's source checkout into the
current linked worktree. It accepts a current subdirectory. The source checkout
must be available in the same Git repository; running warm in the source
checkout refuses.

`--refresh` updates the source checkout before the copy: it checks the upstream, fetches changes when needed,
fast-forwards whatever branch is checked out there, and installs dependencies or
Pods when the new commits moved a lockfile, when nothing is installed, or when
`ios/Pods` does not match `ios/Podfile.lock`. See
[worktree isolation](./worktrees.md#refresh-the-source-checkout-first).

The branch, tracked files, and existing destination entries stay untouched.
Existing directories, including `node_modules`, are skipped whole. Eligible
ignored `.env` and local configuration files are included. The source
checkout's nonempty `.worktreeexclude` replaces its resolved `worktree.exclude`
setting. See [worktree isolation](./worktrees.md) for exclusions.

Wait for warm to finish before any other process writes to the destination.
Concurrent writes are unsafe: files created after the initial existence check
can be overwritten or removed. This includes edits, installs, builds, Metro,
and another warm invocation.

stdout stays empty. stderr reports copied, kept, and failed entries. Failures
exit 1; inspect failed paths before retrying, since partially copied
entries remain and existing directories are skipped. Warm does not install
dependencies or build.

## `worktree remove`

```text
stim worktree remove [target] [--force]
```

Reclaims the target environment, build output, port, and owned device. It then
removes any linked worktree when safe, warmed or not, without requiring a
Stim registry entry. Git-created branches stay. An existing Stim ownership
record permits deleting a branch only when it has no unique commits. On the
source checkout it only reclaims the environment; a bare repository directory
is refused because it is not a worktree. `--force` permits removal
with uncommitted, untracked, or unpushed work or initialized submodules. A
worktree locked with `git worktree lock` is refused until you unlock it.

## `gc`

```text
stim gc [--delete] [--older-than <days>] [--cache <name|all>]
```

Reports stale workspace entries, orphaned owned devices and remote sessions,
stale locks, and shared cache sizes. It does not change anything without
`--delete`.

- `--older-than <days>` also selects old devices and unused cache entries.
- `--cache <name|all>` with `--delete` empties the caches whose name or directory
  carries `<name>` whole, or every cache with `all`. Devices and project entries
  are not inspected, so a scoped run empties caches and reaps nothing.

## `guide`

```text
stim guide [topic] [section]
```

Prints version-matched reference text. Topics are agent, facts, metro, ports,
logs, errors, lifecycle, cleanup, and settings. Those topics also cover caches,
remote devices, and release builds. The errors, lifecycle, facts, and cleanup
topics have sections: called bare they print a section index, and a named
section prints on its own. `stim guide errors` lists every refusal code and
`stim guide errors <CODE>` prints one.

The bare index and the agent topic open with a STATUS block when something is
due: doctor for a platform that never ran in this app, ran more than seven
days ago, or ran under another Stim version (outside a React Native or Expo app
there is no doctor line); and a newer Stim release, checked
against the npm registry at most once a day and skipped when
`STIM_NO_UPDATE_CHECK` is set. The block is omitted when nothing is due.

## Structured output and exit codes

Use plain output for an agent workflow. It streams progress and includes all
facts needed for the next step. Use `--json` when a script must parse the result.

Commands exit with code 0 on success. Build, launch, ownership, or input errors
exit with a nonzero code and print an error code, message, and remedy. An empty
`logs` result exits with code 0.
