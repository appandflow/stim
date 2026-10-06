---
title: 'Remote machines'
description: 'Set up a Mac for build offload or hosted iOS simulators'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

A **build machine** compiles your app on another Mac and returns the artifact.
The app still runs on this Mac's device unless you select a remote target. A
**hosting Mac** runs your app in a simulator there. One Mac can do both, with
separate approvals.

The server command comes from `@stim-cli/server`; its npx form is
`npx --yes --package @stim-cli/server@1.16.0 stim-server`.

## Choose where to build and run

`offload.machines` names candidate build machines; each needs worker approval.
Entries use tailnet names, optionally with an HTTPS route port, such as `janics-mac-mini:7444` (default 7443).
`offload.machine` defaults to `auto`. With that selection, `offload.mode`
controls placement:

- `auto` (default) builds here while this Mac has capacity. When it is busy,
  Stim considers accepting workers and their load.
- `force` prefers a build machine when one accepts the build.
- `off` builds here.

Automatic selection falls back to a local build when offloading fails.
`--build-machine <auto|local|name>` overrides `STIM_OFFLOAD_MACHINE`, which
also overrides `offload.machine`. `STIM_OFFLOAD_MODE` overrides `offload.mode`
for automatic selection. A named worker ignores that mode and local capacity;
it refuses with `STIM_OFFLOAD_REFUSED` instead of trying another worker or
building locally. For a configured, paired worker, a cache hit needs no
compilation and contacts no worker.
`--no-build-cache` skips artifact lookup and still stores the fresh build;
it can be used to test a named worker.

<StimTabs
code={`stim ios --build-machine janics-mac-mini --no-build-cache
stim ios --build-machine local`}
/>

`hosting.machines` names hosts; each needs device-host approval. For a hosted
iOS simulator, use the machine name as the remote target:

<StimTabs code={`stim ios --remote janics-mac-mini`} />

The host boots its owned simulator headless. Debug keeps Metro on this Mac
and connects it through a private tailnet bridge; no `stim start --remote` is
needed. `--device-type`, `--runtime` and `--slot` select the hosted simulator.
`--build-machine` independently selects a compatible worker for a Debug cache
miss. Hosting has no local fallback. Stop the slot with `stim stop` before
moving it between local and hosted devices or between hosts.

`--remote` also accepts two backend names: `eas` creates an EAS Simulator
session; `proxy` uses an existing agent-device daemon configured with
`AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, without
creating a session. Those targets prepare remote Metro exposure, as
`stim start --remote` does, and compile locally. They do not select a Mac in
`hosting.machines`. See [remote devices and Metro](./owned-devices.md#remote-devices).
`--remote auto` refuses until automatic hosting placement is available.
Android accepts the EAS/proxy backends but cannot run on a named hosting Mac
in this release. The [macOS prototype](./macos.md) also supports named hosts.

## Requirements

Install the client CLI globally or run it with npx:

<StimInstallTabs />

For Stim 1.16.0, build machines are Macs. They can compile iOS simulator Debug,
Android emulator debug and macOS SwiftPM Debug apps. Android builds on a
worker Mac need Java and the Android SDK. Device and Release/non-Debug builds,
EAS/proxy runs, Android CAS compiler-cache builds, and iOS/Android runs with
artifact caching disabled in settings do not offload.

Both Macs need Tailscale running on the same tailnet and Node 22.12.0 or
later. Sign in to a GUI login session on the worker Mac to run setup and
answer its permission prompts. A reused server must be at least 1.16.0.
Setup refuses an older Desktop-run server with an update remedy and never
downgrades a newer server.

For iOS builds, Xcode and the simulator SDK must match, and the worker needs
an iPhone simulator on the target runtime. CPU architecture and the Stim build
must match the build target. CocoaPods versions must match unless the
project's `Gemfile.lock` pins it; then both Macs use Bundler and the pinned
version. For macOS, Xcode and the macOS SDK must match. For Android, JDK major
versions must match, and the worker needs the project's NDK, build-tools and
compile SDK. See [machine settings](./settings.md#machine-settings) for the
full toolchain and placement rules.

## Use the Desktop wizard

Open **Stim > Settings > Build Machines > Add...** on your main Mac. The
wizard has six steps:

1. **Pick a Mac.** Select an online macOS peer from your tailnet. Start
   Tailscale on either Mac if it is missing or stopped.
2. **What it does.** Choose **Builds**, **Hosted simulators**, or both.
   The preview shows what setup will do. Desktop starts preparing its sample
   project at this step.
3. **Set it up.** Copy the generated command and run it in Terminal while
   signed in at the worker Mac. Answer y/N for each new capability grant
   there; No is the default. Desktop mirrors setup progress live and checks
   the selected approvals. Already approved capabilities are omitted from
   the command. Once all are approved, continue to Tools. There is no SSH
   option.
4. **Tools.** Compare the worker's tools with this Mac. Copy the fixes and
   run them on the indicated Mac. **Install This Mac's Build** addresses a
   Stim build mismatch. **Check Android** adds Android checks.
5. **Test build.** Build and launch the sample through the selected worker,
   then force a local build. Review live output, phase timings and the speed
   comparison, or choose **Skip test**.
6. **Done.** Review the added settings and undo commands. Choose **Auto**,
   **Always** or **Never**, which set `offload.mode` to `auto`, `force` or
   `off`. Existing effective modes are retained by default. If the wizard
   temporarily disabled offloading, a passed test selects Auto; a failed or
   skipped test keeps Never unless you choose otherwise.

Desktop adds entries when it finds the setup journal and sends approval
requests with that command's ticket. When adding the first build machine
with the default mode, it temporarily sets `offload.mode` to `off` during
setup. An expired ticket needs **New command**.

Agents never run `stim-server setup`, edit `offload.*` or `hosting.*` for you,
or approve requests; use Desktop or perform the setup yourself.

## CLI equivalent

For a new machine with both capabilities selected, Desktop generates this
command, with the client node id, ticket and expiry filled in:

<StimTabs
code={`npx --yes --package @stim-cli/server@1.16.0 stim-server setup \\
  --client <node-id> \\
  --ticket <43-base64url-characters> \\
  --expires <ISO-time> \\
  --build \\
  --device-host`}
/>

Run the actual copied command on the worker. Desktop tickets last 30 minutes;
setup accepts a future expiry at most two hours away. `--yes` above belongs
to npx. It does not skip setup's per-grant y/N questions. Setup's own `--yes`
flag approves without those questions and is required for new approvals
without a terminal. A person on the worker makes that decision.

Setup installs its exact server release, Stim Host, and a per-user
LaunchAgent, then creates or reuses a tailnet-only HTTPS route. By default,
the server uses port 7787, the service label is `dev.stim.server`, and the
route uses 7443 or the next free HTTPS port. It reuses a Desktop-run server
on that port only when it uses the same Stim home and already has a private
route; it installs no LaunchAgent for that server.

Optional `--port`, `--label`, repeatable `--env KEY=VALUE` and
`--path-prepend <absolute-dir>` customize the service. A new service inherits
only `STIM_HOME` and `SHELL`; pass tool paths and variables explicitly.
Export `STIM_HOME` before setup if needed; `--env` cannot set it.
`--json` prints one final payload and sends progress to stderr.

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | All selected capabilities, needed permissions and tools are ready.         |
| 1    | A refusal or failed step; completed steps remain in place.                 |
| 2    | No grant before expiry, or an expired command.                             |
| 3    | At least one grant, but another capability, permission or tool is missing. |

See [Set up a worker Mac](https://github.com/appandflow/stim/blob/main/packages/server/README.md#set-up-a-worker-mac)
for the full server reference.

### Manual setup

Without the wizard, install or run the server on the worker Mac:

<Tabs groupId="stim-invocation" defaultValue="global">
<TabItem value="global" label="Global">

```bash
npm install --global @stim-cli/server@1.16.0
stim-server service install --serve
```

</TabItem>
<TabItem value="npx" label="npx">

```bash
npx --yes --package @stim-cli/server@1.16.0 stim-server service install --serve
```

</TabItem>
</Tabs>

On your main Mac, add the machine and request access from an app directory.
These examples set each list to one entry; keep any machines you already use.
Use the route's actual port if it differs from 7443. Configure only the
capabilities you need:

<StimTabs
code={`stim settings set offload.machines '["janics-mac-mini"]'
stim settings set hosting.machines '["janics-mac-mini"]'
stim doctor --fix`}
/>

On the worker, inspect `stim-server devices` and approve the printed build
request with `stim-server devices grant <build-id> --build`, and the separate
hosting request with `stim-server devices grant <host-id> --device-host`.
Use the server package's npx prefix above if it is not installed globally.
Requests lapse after 15 minutes. Run `stim doctor` on the main Mac to check
approval and compatibility before running the app.

## Permissions

| Approval      | What it enables                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| `build`       | Compiling the requesting Mac's project as the worker user.                                   |
| `device-host` | Running the client's native app in its own hosted device or app session.                     |
| `read`        | Reading workspaces, logs and device screens, including workspace text diffs where supported. |
| `control`     | Device input and workspace Reload/Stop actions for a paired viewer.                          |

Build and device-host grants are separate from each other and from viewer
read/control grants. Pairing a phone does not grant build or hosting access.

For hosting, setup asks for normal macOS screen recording and device control
permissions on the worker. Missing screen recording prevents viewing; missing
device control prevents controlling the simulator. A terminal lets you skip a
permission with `s`; skipped permissions remain unavailable. Setup opens the
matching Privacy & Security panes when needed. For a reused Desktop server,
allow that app. Setup does not change macOS permission settings itself.

## Tools

Setup checks installed tools and prints fixes; it does not install Xcode,
runtimes, CocoaPods, Java or the Android SDK. Desktop's Tools step compares
them against the client. Missing or mismatched iOS tools block the next step;
Android checks and a busy worker do not. Hosting alone does not need CocoaPods
or Android tools.

**Install This Mac's Build** can update an approved worker over the tailnet.
An exact npm release needs no extra setting. Installing this checkout's own
build requires `server.acceptClientBuilds=true` on the worker; it defaults to
false. A failed server health check restores the previous version.

## Test build

Desktop creates a pinned Expo blank SDK 58 sample under
`~/Library/Application Support/Stim Desktop/Onboarding/sample-sdk58`.
Preparation downloads the template and installs its dependencies, so it needs
network access. Desktop uses the sample for setup requests when no workspace
is listed. It tests iOS builds, including when **Check Android** is selected;
a hosting-only setup can skip the build test.

The first run uses `stim ios --build-machine <name> --no-build-cache --json`.
It must report the selected `offloadedTo` and a launch state of `true` or
`bundling`. Desktop reads the `offload_done` log's offer, sync, worker and fetch
timings. The second run uses `--build-machine local --no-build-cache` to prove
this Mac can still build and launch. This tests local build readiness; it does
not deliberately disconnect the worker to trigger automatic fallback.

The sample stops when the test ends or the sheet closes. **Run again** reuses
the folder. **Delete sample app** in Build Machines stops and removes it after
confirmation.

## Undo

**Cancel** removes only entries the wizard added, restores the mode only if
it changed it, and runs doctor to forget removed pairings. Worker grants
remain until revoked there. After finishing, use **Settings > Build Machines >
Remove** on the main Mac. Remove the corresponding `hosting.machines` entry
as well if you enabled hosting, then run `stim doctor --fix` to forget it.

On the worker, run the summary's `stim-server devices revoke <id>` for each
grant you want to remove. Optional `stim-server service uninstall --label
<label>` removes the managed service and only the route that install created.
A reused Desktop server and its route remain managed by Desktop. Stim Host,
other pairings and macOS permission grants remain; remove permissions in
System Settings if desired.

## Security model

Connections use Tailscale and private Serve routes, never Funnel. The client
pins each worker's tailnet node and sends its credential only to that node.
Setup binds each approval to one node, one ticket and one expiry, and approves
at most one request per selected capability. Its live journal is readable only
by the named tailnet node until expiry.

Build approval permits the client's project code, including config plugins,
CocoaPods hooks, Xcode script phases and Gradle plugins, to run as the server
user. It is not a sandbox for untrusted projects. Approved build or device-host
clients can also request managed server updates. Only accept requests from
Macs you trust. The server trusts forwarded peer addresses only on loopback;
a process already running as the worker user can forge that header.

## Troubleshooting

- [STIM_OFFLOAD_REFUSED](./troubleshooting.md#STIM_OFFLOAD_REFUSED): a named
  worker cannot take or finish the build. Check approval, tool compatibility,
  capacity and the pinned node. Rerun with `--build-machine auto` or `local`
  only when you want to change placement.
- [STIM_HOSTING_REFUSED](./troubleshooting.md#STIM_HOSTING_REFUSED): the host
  is unreachable, has no compatible simulator or cannot confirm the session.
  Retry the same host, or reconcile with `stim stop` when it is reachable.
- [STIM_BAD_ARG](./troubleshooting.md#STIM_BAD_ARG): check the named host,
  simulator selectors and incompatible flags. Automatic hosting and named
  Android hosting are unavailable.
- For setup failures, follow the named step's fix and exit code. Update a
  reused server older than 1.16.0, generate a new command after expiry, and
  check Tailscale and the private route when the live mirror cannot connect.

## Ask your agent

These responses are illustrative. Placement comes from `stim status --json`
(`buildMachine`, `builtOn`, `offloadedTo`, `offloadFallback`) and
`stim stats --json`. Today's per-machine `savedMs` is an estimate against
previous local cold builds; without a local baseline, Stim cannot estimate
savings. Stats retains at most 100 placements from the last seven days.

<StimTabs
code={`stim status --json
stim stats --json`}
/>

<PromptGrid>
  <PromptBox
    title="Check the last build"
    response={`The last iOS build compiled on janics-mac-mini.
Selected: auto. Placement: this Mac was busy; the worker accepted the build.
No local fallback was recorded.`}
  >
    {`Check whether my last iOS build ran on my build machine, and why or why not.`}
  </PromptBox>
  <PromptBox
    title="Review today's savings"
    response={`janics-mac-mini: 3 offloaded builds today; estimated savings 6m against previous local cold builds.
This is an estimate from the retained build history.`}
  >
    {`Show how much time my build machine saved today.`}
  </PromptBox>
  <PromptBox
    title="Run on a hosting Mac"
    response={`Ran stim ios --remote janics-mac-mini.
Trailhead launched on the hosted iOS simulator on janics-mac-mini.
com.appandflow.trailhead · ready · errors clean`}
  >
    {`Run the app on a hosted iOS simulator on janics-mac-mini.`}
  </PromptBox>
</PromptGrid>
