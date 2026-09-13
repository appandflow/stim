# Stim

The `stim` npm package installs the `stim` command.

Stim gives coding agents fast, isolated React Native and Expo environments. Each
project or git worktree gets its own Metro port and owned device. Shared caches
keep native and JavaScript builds warm across worktrees.

## Install

If you previously installed `stim-cli` globally, follow the
[migration instructions](#migrating-from-stim-cli) first.

```bash
npm install --global stim
npx skills add appandflow/stim
```

Run without a global install when needed:

```bash
npx stim <command>
```

Node 20.19.4 or later on Node 20, or Node 22.12.0 or later, is required.

Machine defaults in `~/.stim/config.json` can enable or disable native artifact
caching, remote caches, Metro sharing, iOS compiler caching and prefix mapping,
and Android ccache/CAS, PCH, Gradle caching, and target ABI narrowing. Optional
`.stim.json` runtime overrides apply per app, beside its `package.json`; monorepo
apps do not inherit the repository-root file. Worktree-copy rules stay at the
repository root. Run `stim guide settings` for the
`optimizations` schema; existing defaults remain unchanged.

## Normal workflow

```bash
stim doctor
stim start
stim ios                  # or: stim android
stim logs --errors
stim stop
```

For `stim logs --errors`, a clean check requires exit code 0 and no matching
errors in the captured logs. Exit code 0 alone means the query succeeded, even
when it prints errors. A workspace that has never produced a log timeline
refuses with `STIM_NO_PROJECT`; in a monorepo, the error names the nearest
registered descendant app with logs when one exists.

Use `stim start --reset-cache` to recover from stale Metro transforms or file-map
state. It restarts only this app's verified owned Metro, keeping its port and
devices. A fresh persistent cache namespace bypasses old entries without deleting
shared stores or changing other apps or native build caches. Expo requires SDK
54+ and Stim's config adapter. See `stim guide lifecycle` for scope and limitations.

Use `stim doctor --platform ios` or `stim doctor --platform android` when only
one native platform is in scope; shared project checks still run. Doctor also
prints the running CLI version and the `stim` installation resolved from PATH,
and flags a resolved installation that is older than another available one.

For parallel iOS work, SimSlim is recommended as an optional way to reduce
simulator background services and memory use. Run `stim guide lifecycle simslim`
to review the service tradeoffs and configure a profile. Doctor recommends the
setup without installing or enabling it. When a simulator cannot start
processes, Stim bounds the wait and reports observed host memory pressure when
available; free memory before retrying. A timeout alone does not prove OOM.

For stale Android CMake launcher findings, stop native builds and run
`stim doctor --fix --platform android` in the affected checkout. It clears
affected ignored, untracked generated `.cxx` configurations in the app and
installed native modules, then reports remaining findings. The next build
recreates that output; source files, custom launcher settings, and shared
ccache entries are preserved. Its cache-lock check cannot detect uncached,
release-swap fallback, or direct Gradle builds; stop all native builds first.

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

To use an existing EAS development build, run `stim ios --eas-profile ios-simulator`
or `stim android --eas-profile development` with your project's profile name.
The profile must be an internal development build. Add `--device` for a connected
phone; iOS requires `ios.simulator: true` for a simulator and false for a phone.
Stim downloads a matching native build and connects it to the workspace's Metro.
EAS CLI manages the downloaded artifact cache. An iOS provisioning failure
points to EAS device registration and rebuild commands.
On a miss it stops and prints the EAS build command, which may incur charges;
it never triggers the build automatically. See `stim guide lifecycle eas` for
setup, environment handling, and cache behavior.

Use `stim ios --scheme "App Staging"` when a project has several shared Xcode
app schemes. Combine it with `--configuration Release` if needed. Without the
flag, Stim keeps its automatic scheme selection. Explicit schemes use separate
artifact caches and Xcode build directories; run `stim guide lifecycle builds`
for provider behavior. This selects an Xcode scheme, not a URL scheme.

Launch evidence does not prove that the UI is interactive. Apps can optionally
[declare readiness with two debug log messages](https://stim.appandflow.com/docs/dev-server-and-logs#optional-app-declared-readiness),
without a package or SDK. A captured pending message extends the default
three-second stability window after bundle delivery to a bounded wait for ready.
Managed Metro response capture distinguishes a finished build from a finished
response; servers without capture use the build-complete marker. Run
`stim guide lifecycle readiness` for implementation instructions; verify the
expected screen separately.

`stim reload [ios|android]` requests a JavaScript reload in the live app on this
workspace's owned local device. Use it when an error screen remains after a fix,
and on Android after a failed first bundle load. An iOS app whose first bundle
failed never connects to Metro, so reload cannot reach it. It reloads
JavaScript and never restarts the app. It is not part of the normal workflow
and does not build, install, boot, or launch an app. The platform is optional
when only one app is live.
Success confirms that the request was sent; Stim does not observe completion.
Verify the expected UI on the reported device and inspect `stim logs --errors`
before claiming recovery.

For an isolated branch, create the worktree with Git, then warm it:

```bash
git worktree add -b feature/settings ../feature-settings HEAD
cd ../feature-settings
stim worktree warm
```

If a harness already created the linked worktree, run only `stim worktree warm`
there. Warm copies missing ignored state from the source checkout, including
eligible `.env` and local configuration files. Existing entries are preserved;
existing ignored directories such as `node_modules` are skipped whole.

`stim worktree warm --refresh` brings the source checkout up to date first: it
checks the upstream, fetches changes when needed, fast-forwards whatever branch is checked out there, and installs what
the new commits moved before copying. It refuses a source checkout it cannot
move (uncommitted tracked changes, a rebase or merge in progress, a detached
HEAD, a diverged branch) and never switches branches. One lock per repository
keeps a copy from reading a `node_modules` a refresh is rewriting; plain warms
still run side by side. A plain warm also refuses (`STIM_DEPS_INCOMPLETE`) when the last
install of the lockfile on disk did not finish, instead of copying a partial
`node_modules`; `stim worktree warm --refresh` reinstalls it.

Wait for warm to finish before editing, installing dependencies, starting
Metro/builds, or running another warm in that worktree. Concurrent writes are
unsafe: entries created after the initial check can be overwritten or removed.

After the work is preserved, `stim worktree remove` removes any linked
worktree, warmed or not. Git-created branches stay. See the
[worktree guide](https://stim.appandflow.com/docs/worktrees) for exclusions
and cleanup rules.

## Reference

The [documentation website](https://stim.appandflow.com/) explains the
human workflow and all commands.

The installed CLI contains version-matched operational guidance:

```bash
stim guide agent
stim --help
stim <command> --help
stim guide
```

Runtime state defaults to `~/.stim`. Set `STIM_HOME` to move it. Stim manages
owned simulators and emulators, leases connected physical devices, and supports
configured remote devices.

## Migrating from stim-cli

Remove the old global package before installing `stim`, since both provide the
same command:

```bash
npm uninstall --global stim-cli
npm install --global stim
```

Update programmatic imports from `stim-cli/cache-manifest` to
`stim/cache-manifest`. The `@stim-cli/*` packages keep their names.

MIT License.

### Multiple devices in one workspace

Use a stable slot name for each simulator, emulator, or physical device. Slots
can use identical models and all share the workspace's Metro server and build
cache. Omit `--slot` to reuse your existing default device.

```sh
stim ios --slot phone
stim ios --slot tablet --device-type "iPad Pro 13-inch (M4)"
stim ios --slot hardware --device <udid>
stim logs --slot tablet --source device
stim stop --slot tablet
```

`stim status` shows every slot. Plain `stim stop` stops the whole workspace;
`--slot` preserves the shared server and other devices. `stim reload ios` or
`stim reload android` can reload multiple connected devices. Read
`stim guide lifecycle options` for launch verification and recycling behavior.
