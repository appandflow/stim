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
`.stim.json` overrides apply per repository. Run `stim guide settings` for the
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
when it prints errors; an empty result does not prove launch or log capture
succeeded.

Use `stim doctor --platform ios` or `stim doctor --platform android` when only
one native platform is in scope; shared project checks still run. Doctor also
prints the running CLI version and the `stim` installation resolved from PATH,
and flags a resolved installation that is older than another available one.

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

Use `stim ios --scheme "App Staging"` when a project has several shared Xcode
app schemes. Combine it with `--configuration Release` if needed. Without the
flag, Stim keeps its automatic scheme selection. Explicit schemes use separate
artifact caches and Xcode build directories; run `stim guide lifecycle builds`
for provider behavior. This selects an Xcode scheme, not a URL scheme.

Launch evidence does not prove that the UI is interactive. Apps can optionally
[declare readiness with two debug log messages](https://appandflow.github.io/stim/docs/dev-server-and-logs#optional-app-declared-readiness),
without a package or SDK. A captured pending message extends the default
three-second stability window after bundle delivery to a bounded wait for ready.
Managed Metro response capture distinguishes a finished build from a finished
response; servers without capture use the build-complete marker. Run
`stim guide lifecycle readiness` for implementation instructions; verify the
expected screen separately.

`stim reload [ios|android]` requests a JavaScript reload in the live app on this
workspace's owned local device. Use it after a failed first bundle load, when
an error screen remains after a fix, or when you explicitly need an app
restart. It is not part of the normal workflow and does not build, install,
boot, or launch an app. The platform is optional when only one app is live.
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
there. Warm copies missing ignored state from main, including eligible `.env`
and local configuration files. Existing entries are preserved; existing
ignored directories such as `node_modules` are skipped whole.

Wait for warm to finish before editing, installing dependencies, starting
Metro/builds, or running another warm in that worktree. Concurrent writes are
unsafe: entries created after the initial check can be overwritten or removed.

After the work is preserved, `stim worktree remove` removes any linked
worktree, warmed or not. Git-created branches stay. See the
[worktree guide](https://appandflow.github.io/stim/docs/worktrees) for exclusions
and cleanup rules.

## Reference

The [documentation website](https://appandflow.github.io/stim/) explains the
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
