export default {
  summary: 'The dev server: `stim start`, stimd, and starting your own',
  body: () => `THE DEV SERVER

  stim start
  stim start --remote   # prepare Metro for a remote device

Reserves (or reuses) this workspace's Metro port, has this home's stimd start
the dev server as its own child, and waits until it both answers AND verifies as this
project's before exiting. You get your shell back with a bundler running: no
backgrounding idiom, no sleep, no poll loop, and no chance of building against
another worktree's bundler.

If Expo cannot be resolved in a linked worktree, run \`stim worktree warm\`
there before retrying. The refusal also names dependency installation.

  --json            one line of facts on stdout, everything else on stderr:
                      { port, supervisorPid, mode, logsDir, alreadyRunning }
  --wait <seconds>  how long to wait for server and remote tunnel readiness
                    (default 60 for each). Unlike ios/android/device lock
                    --wait, it does not wait for a device lease.
  --remote          expose Metro for a remote device

Plain \`stim start\` is local and does not create a tunnel. Remote intent
comes from \`start --remote\`, eas/proxy in \`ios.remote\`, or \`android.remote\`. The
\`metro.tunnel\` setting selects the provider after remote intent exists.

HOSTED IOS METRO
  ios --remote <machine> keeps Metro local and needs no start --remote.
  stimd watches hosted Metro requests in workspace state and keeps a
  few authenticated connections open to the host for each session. The host
  pairs one with each connection the device makes to its loopback-only bridge,
  and stimd forwards it to this Metro, so the host never connects back
  to this machine and a shared or ACL-restricted host works. For an Expo
  dev client the bridge listens on this machine's Metro port, which the dev server
  writes into the manifest. ios --remote starts Metro on a port free on both
  Macs; a running Metro or a pin on a port the host uses refuses the run before
  the build. metro.tunnel and metro.publicUrl are ignored. A restarted stimd
  reopens the recorded links; stop or a stopped hosted session closes them. A recorded
  hosted session prevents Metro idle stop; maintenance.idleStopHours still stops the workspace and its hosted session (guide cleanup). Release runs skip the bridge.
  Hosted Debug runs require a dev server stimd runs and a stim-server that support these
  links before reservation. --no-metro-check refuses; restart a missing or older dev server
  with stim stop; stim start.
  Native iOS and Android logs are pulled from the host by stim logs, including --errors;
  JavaScript logs still arrive through Metro. Stop pulls native logs before
  deleting the owned device and copies the final host tail afterwards. Read guide
  lifecycle hosted-ios or hosted-android for placement and cleanup.

TAILNET-ONLY METRO
  Install Tailscale and sign in on this machine and the remote device or
  agent-device daemon's host, then select the mode explicitly:

    stim settings set metro.tunnel tailscale --scope workspace
    stim start --remote

  The device must be on the same tailnet, so the eas backend refuses it. "auto"
  never selects tailscale.
  Stim runs a foreground \`tailscale serve --https=<metro port>
  http://127.0.0.1:<metro port>\` process, never Funnel. It prints
  https://<tailnet-name>:<metro port> and \`status\` reports the recorded
  provider and URL. Stim reads the URL from the child's pipes, without a log
  file, and skips the public bundle probe for this recorded tunnel: this
  machine may not reach its own tailnet name.

  \`stop\` and \`worktree remove\` stop only the recorded process after
  verifying its identity; ending that foreground session removes its route.
  A route Stim did not create is never touched. If the port already has a
  serve route, Tailscale refuses and Stim prints Tailscale's error message.
  \`tailscale serve status --json\` shows foreground sessions under the
  top-level Foreground key; plain \`tailscale serve status\` does not.

BUNDLE WARMUP
  After verifying Metro, \`stim ios\` and \`stim android\` prefetch the
  platform's development bundle while native work continues. The prefetch
  requests the URL of the app's most recent bundle request on that platform,
  read from this workspace's metro log, so it matches the app's entry point
  and options and does not ask Expo for its manifest. A recorded URL whose
  entry file no longer exists under the project root or its ancestors is
  skipped. Expo computes the
  runtime version fingerprint for every manifest request. Without a recorded
  request, Expo supplies the entry point and bundle options through its
  manifest, and bare React Native uses the standard index entry and
  development bundle options, including lazy loading.
  Warmup is enabled by default. Set optimizations.metroWarmup=false to disable
  it on the next ios/android command, using the machine or project settings.
  For custom entry points or bundle options, set metro.warmupUrl.ios and/or
  metro.warmupUrl.android to the app's complete bundle URL or /path?query.
  Stim keeps the path and query and uses the verified local Metro port.
  Overrides replace discovery and receive no additional query defaults.
  doctor validates configured URLs, including their platform; it does not
  infer or auto-fix runtime native entry points or dev-menu bundle options.
  See \`guide settings\` for configuration examples.
  Each request times out after 60 seconds and does not keep the command alive.
  Warmup failures do not fail the native build.
  Release builds and \`--no-metro-check\` skip warmup. Servers without Stim's
  prefetch-aware response observer also skip it; restart an older dev server
  with the current CLI to enable warmup.

  Prefetch completion is not launch proof. Development launch verification
  waits for the app's own bundle response. With a bundler started outside Stim,
  device logs may prove a request, but bundle completion may stay unverified.

HOSTED ANDROID
  android --remote <machine> keeps Metro here through the same client-opened
  links as hosted iOS. The host reverses the client Metro port into its loopback bridge
  on the exact owned emulator. Each run and reload restores that reverse;
  no adb command for the host serial runs here. metro.tunnel and metro.publicUrl
  are ignored. See guide lifecycle hosted-android.

REMOTE DEVICE BACKENDS
  Metro exposure and device selection are separate:

    stim start --remote          prepare remote Metro
    stim ios --remote proxy      use an agent-device daemon
    stim android --remote eas    create an EAS Simulator session

  The command or the matching ios.remote/android.remote setting selects the
  backend. Environment variables never select the backend.

  The proxy backend connects to an agent-device daemon on another machine. It
  requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. Stim creates no remote session for it.

  An iOS remote build compiles one simulator architecture, since xcodebuild
  cannot target the remote simulator itself: the proxy daemon's host
  architecture from its /health hostArch, and arm64 when the daemon does not
  report one, cannot be reached within 3 seconds, or runs on EAS, whose hosts
  are Apple silicon. The cache key ends in that architecture.

  The EAS backend needs eas-cli 21.6.0 or later and an account with EAS
  Simulator access. An EAS session is billable; Stim has EAS stop each session
  it creates after remote.easMaxDurationMinutes (default 30), and a later run
  replaces a session that expired. Stim prepares the app before
  it creates or reconnects the session, so a failed build starts no session
  and the install follows the connection directly. EAS does not inherit the
  proxy credentials. Always tear the session down: \`stop\`,
  \`worktree remove\`, and \`gc --delete\` can end sessions that Stim proves
  it owns.
  \`stim status\` lists each recorded session with its preview URL (see
  \`guide facts\`).

IDEMPOTENT
  A healthy dev server on the reserved port is a no-op: \`start\` prints the
  facts with alreadyRunning: true and starts nothing. A foreign process holding
  the reserved port moves the RESERVATION instead, so the project is never
  stranded on a port it can never use. A port pinned with metro.port or
  STIM_METRO_PORT never moves: \`start\` refuses with STIM_BAD_ARG and names
  the holder before anything starts or the pin is reserved. This project's
  own Metro already on the pin is attached to. Changing the pin while this
  workspace's dev server runs refuses until stim stop; a recorded dev server that cannot
  be verified also refuses, until you stop it with the tool that started it.
  You can also unset or restore the pin. stim web follows
  the same rules when its page uses Metro.
  ios and android with --no-metro-check use the pin, then the recorded port,
  then 8081, without probing, reserving or writing the registry. An invalid
  pin still refuses with STIM_BAD_ARG. Release builds still skip Metro.

WHO RUNS IT
  This home's stimd (\`guide settings\`, THE STIM DAEMON) runs each workspace's
  dev server as its own child, in its own process group, and \`start\` starts
  stimd when none runs, whatever daemon.mode says. stimd writes the dev
  server's output as NDJSON into the global workspace logs directory
  ($STIM_HOME/workspaces/<project>--<digest>/logs; see \`guide logs\`), and
  records it in that workspace's state.json before it answers; the recorded
  pid (supervisorPid, status's supervisor.pid) is the dev server's own. On
  macOS and Linux the dev server outlives a stimd restart and the next stimd
  takes it over through its metro.claim; on Windows it stops with stimd. Four
  modes. Stim never prompts and never runs a package.json script to choose;
  it takes the first that applies:

    1. metro.command is set: command-child.
    2. rock.config.* (mjs, js, cjs or ts) exists: repack-child when its text
       names @rock-js/plugin-repack, otherwise bare-inproc, because Rock then
       runs Metro.
    3. react-native.config.js (or .cjs, .mjs) registers
       @callstack/repack/commands: repack-child.
    4. expo is used (app.json expo key, an app.config naming expo, or a
       resolvable expo dependency): expo-child.
    5. Otherwise: bare-inproc.

  Stim reads those config files as text and never runs them. An app that
  installs expo only for Expo modules but bundles with Re.Pack gets
  repack-child. \`start\` names the file that decided, as in
  "starting on port 8082 (repack-child from rock.config.mjs)".

    bare-inproc  bare React Native: Stim's Metro host runs Metro from the
                 project's own node_modules, with Stim's reporter
                 attached. Bundler events, in-app console logs and redboxes
                 all arrive structured.
    expo-child   Expo: the project's own \`expo start --port <port>\` runs as
                 a child and its stdout is parsed into records. Levels are
                 INFERRED from each line, so those records carry raw: true.
    repack-child  Re.Pack: the project's own \`rock start\`, or
                 \`react-native start\` with Re.Pack's commands, runs as a
                 child with --port <port> --no-interactive --no-reverse-port
                 --json --log-requests (and --reset-cache for
                 \`start --reset-cache\`). Each bundle request becomes
                 bundle_response_started and _finished or _failed records,
                 which launch verification reads as bundle evidence; other
                 requests are dropped. Re.Pack's compile events become
                 bundle_build_started and _done progress records. Other
                 lines, including the compile errors Re.Pack prints as text,
                 arrive as repack_stdout and repack_stderr records. In
                 development Re.Pack serves a bundle that compiled with
                 errors, so a launch can report true while the app shows a
                 redbox; read \`stim logs --source metro\` for the errors.
                 Re.Pack 5 or later is required; Re.Pack 4 needs
                 metro.command. Re.Pack keeps its
                 own host, localhost by default, because it also writes that
                 host into the bundle's publicPath: a simulator and an
                 emulator or Android phone (through adb reverse) reach it, a
                 physical iPhone on the LAN does not, so \`ios --device\`
                 needs metro.command with the project's own --host. If the
                 reserved port is taken by the time Rock starts, Rock may wait
                 for an answer it cannot get or exit, and \`start\` reports
                 the dev server as not ready. Re.Pack's own adb reverse, which
                 would reach every connected device, is off: Stim passes
                 --no-reverse-port and points the child's ANDROID_HOME at
                 the null device, and manages the reverse for its port. A config that names
                 Re.Pack without rock or @callstack/repack installed refuses
                 with STIM_REPACK_BIN instead of falling back to Expo.
    command-child  metro.command (\`guide settings\`): that argv runs as a
                 child in its own process group, with {port} replaced by the
                 reserved port, and its output is parsed like expo-child's
                 under command_stdout and command_stderr events. Stopping the
                 dev server signals the whole group, so a wrapper such as
                 yarn takes its Metro with it. Stim adds no reporter, warmup
                 observer or shared transform store, so ios and android
                 launches stay UNVERIFIED: read \`stim logs --source metro\`
                 for the bundle lines.

  Every mode puts the Node the app pins (.nvmrc,
  .node-version, .tool-versions nodejs, or package.json volta.node), looking
  from the app directory up to its repository or worktree root, first on PATH
  when an nvm, fnm, Volta, asdf, mise or linked Homebrew
  node/node@NN install satisfies the pin and the node already on PATH does
  not; the metro log then records a project_node event naming it. When no
  install has the version the pin names, the newest install of the pinned
  major that is not older than the pin stands in, and a node on PATH of
  that major and not older than the pin is kept.

  In expo-child mode, remote intent plus metro.tunnel "expo" makes \`start\` pass
  \`--tunnel\` and EXPO_UNSTABLE_TUNNEL_V2=1 (the legacy ws-tunnel path is
  locked to port 8081, which every reserved port but the first collides with)
  and records the URL Expo reports under state.json's metroTunnel. This has to
  happen here: \`ios --remote <proxy|eas>\` / \`android --remote <proxy|eas>\`
  cannot add \`--tunnel\` to
  an already-running dev server. A later \`start --remote\` refuses with a
  stop-and-restart remedy when a healthy local Expo dev server has no recorded
  Expo tunnel. See \`guide settings\` for metro.tunnel.

  \`stim status\` reports the pid, the mode, and whether it is answering.
  \`stim stop\` is the inverse of \`start\`: it has stimd stop the dev server, reaps
  the device-log collectors, shuts the owned device down (never deletes it)
  and frees the port.

LINUX RUNNERS THAT REAP BACKGROUND PROCESSES

Some command runners kill every descendant when a call ends. The dev server is
a child of stimd, which starts as its own transient user service when a user
systemd manager answers (guide settings, THE STIM DAEMON), so such a runner
does not reach it. Without one, run the command under \`stim ci run --\`, or
end the job with \`stim stop\`.

  IDLE STOP: once the workspace has had no activity for idle.minutes
  (default 15; 0 never stops), the stim-daemon moves it into the idle stage
  in one pass under its native-run and metro-start locks, after deciding
  again: it stops the dev server, keeping its port reservation and launch
  records; shuts the owned simulators and emulators down, ending their log
  collectors; and deletes the workspace's regenerable build outputs (its
  derived-data and other workspace build directories, the in-tree
  android/app/build, android/build, android/.gradle, .build, the CMake
  directories android/.cxx and android/<module>/.cxx, a .dd directory
  laid out as Xcode DerivedData (a Build/ directory beside ModuleCache.noindex
  or Logs/), and an Exact app's Cargo target/ that git ignores, and the Metro store unless another running dev
  server shares it). ios/build stays: pod install writes generated sources
  there. Xcode output under any other name stays too; gc reports it. Activity is
  the newest of a Stim command in the workspace (start, ios, android, reload,
  revive, logs, worktree warm) or the end of its native run; a Metro bundle,
  manifest or HMR request; an agent-device action on its devices; an input a
  stim-server client sent to one of its devices; and, on macOS, a person's
  keyboard or mouse input within the last two minutes while Simulator,
  Device Hub or its emulator's window is frontmost. Device Hub does not say
  which simulator it shows, so it counts for every booted simulator the home
  owns, as Simulator does when its CurrentDeviceUDID cannot be read. Device
  logs, in-app console logs, dev server output and log file times never count, so an open app that only hot-reloads or logs
  is idle, and a live view that only streams frames does not keep it. It
  stays running while a bundle response is in flight, while a build in the
  workspace is in progress, while a stim ios, android, share or stop run holds the
  workspace's native-run lock, while the workspace holds an unexpired device
  lease (\`stim device lock\` or a --device run, physical devices included),
  while one of its devices is driven, a live agent-device session included,
  or its activity is unknown (\`guide facts status\`; on Windows, which has
  no ps, the host driver-process probe is skipped), while simctl or adb cannot
  list its devices, while its owned Chrome or a hosted device runs, while a
  web share of it exists, live or stopped for now (\`guide share\`; stim share stop or its
  expiry ends that), while maintenance.keep pins it, and while a \`stim start\`
  holds its metro-start lock. A dev server whose requests or HMR updates Stim
  cannot see (metro.command, Re.Pack, or an Expo SDK before 54) never stops
  for being idle. The
  pass records workspace_idle and supervisor_stopped lines in metro.ndjson,
  devServerStop and idleStage in state.json, so \`status\` shows the idle
  stage and
  "stopped (idle)" rather than a crash. With daemon.mode off,
  stimd applies the same clock to the dev server and the workspace's
  devices, without deleting build outputs (\`guide settings\`). The next
  \`stim start\`
  starts it again and clears the
  record, also when it reuses a dev server that another process started. A
  Debug \`ios\` or \`android\` run starts it the same way and reports
  devServer.reason "stopped (idle)". \`stim revive\` resumes exactly what the
  idle stop paused: it restarts the dev server, boots each owned simulator or
  emulator a recorded launch ran on, on this machine and through the
  same admission as \`ios\` and \`android\`, and relaunches that app from
  cold from the build cache entry that launch installed, without
  fingerprinting or building. A native-process iOS launch (an Exact app, no
  Metro) needs no idle stop: revive boots its owned simulator and launches the
  app installed there, with no install and no Metro. The run may use only that device: it refuses
  instead of creating or adopting another one. In-app state is gone. An app that is still running is left alone
  unless Metro restarted. Release, Android native-process and hosted
  launches are not relaunched. Run as agent-device's boot hook (guide logs), it restores only
  the launch on the device agent-device asked for, plus Metro. It refuses
  with STIM_NO_METRO when the last stop was not an idle stop or the
  workspace was stopped since, STIM_DEVICE_LOST when the owned device is
  gone, and STIM_NO_RECORDED_BUILD when the app is, or when the simulator
  no longer has a native-process app installed. stimd reads the
  setting on each tick; a value that is not a whole number of 0 or more is
  refused, as \`stim settings set\` refuses it.

  WHY IT STOPPED: when a dev server stops, stimd writes a supervisor_stopped
  line whose stop field and message give the cause, and records the same
  cause as devServerStop in state.json. Plain \`status\` prints it after "not running"
  while the workspace keeps its port (\`stim stop\` releases the port, so its
  own stops show only in the log).
    requested      a Stim command stopped it and says which: stim stop,
                   stim worktree remove, stim gc --delete, stim start
                   --reset-cache, or automatic maintenance with its idle
                   reason (guide cleanup, IDLE STOP)
    signal         a SIGTERM or SIGINT with no Stim stop request recorded,
                   so it likely came from outside Stim (level warn)
    server-exited  the dev server exited on its own (level error). Expo CLI
                   also exits 0 when it gets SIGTERM, so "exit code 0" with
                   no request usually means something outside Stim signalled
                   the Expo process
    idle           idle.minutes, above
  A dev server that dies while no stimd runs, or whose state file was not
  writable, records nothing: \`stop\` logs supervisor_vanished (level warn)
  for it, and until then \`status\` reports metro.lastStop.reason "vanished".

  WATCHMAN ROOTS: a Metro that uses watchman registers a watch root in the
  shared watchman daemon and never removes it. Bare React Native Metro uses
  watchman whenever it is installed; Expo SDK 56 and later use it only when
  metro.config.js sets resolver.useWatchman to true. When stimd stops a dev
  server it started, it removes with \`watchman watch-del\` a root that appeared
  after it started, contains the workspace and carried this Metro's
  subscription, once no other client subscribes to it or has a trigger on it.
  It logs watchman_root_removed, or watchman_root_kept with the reason, in
  metro.ndjson. It never starts the daemon and leaves every other root alone,
  including those jest registers.
  A dev server that dies, or one a restarted stimd took over, leaves its root: remove it with
  \`watchman watch-del <root>\`. Removing a root stops its recrawls; the
  daemon's memory footprint shrinks only when the daemon restarts, which drops
  the watches of every other client. \`stim gc --cache watchman\` reports the
  daemon's footprint, roots and clients, and with --delete shuts it down only
  when no client is connected (\`guide cleanup memory\`).

  ENVIRONMENT: the dev server, including a metro.config.js evaluated inside
  the expo child, gets the environment of the command that STARTED it, which
  the command forwards to stimd. A later \`start\` that finds a healthy dev
  server is a no-op and cannot change its env: to apply a new env var,
  \`stop\` first, then \`start\` with it set.

  The dev server's own output goes to the global workspace
  logs/metro.stdout.log and logs/metro.stderr.log, and stimd parses it into the
  NDJSON TIMELINE (metro.ndjson). A failed \`start\` quotes the metro.stderr.log
  tail and this attempt's error records from the timeline.

STARTING YOUR OWN BUNDLER STILL WORKS
  A dev server YOU started is detected and left alone: \`start\` reports it
  with supervisorPid: null and mode: null, exits 0, and starts nothing over it.
  Starting a second bundler on a working one is the actual failure. For
  \`start --remote\`, an external Expo server also needs metro.publicUrl because
  Stim cannot add Expo tunnel mode to a process it does not supervise.

  Start it from INSIDE the project directory, on the reserved port, or nothing
  can attribute it to you:

    Expo                      npx expo start --port <port>
    Bare React Native         npx react-native start --port <port>
    Rock with Re.Pack         npx rock start --port <port>
    Has its own start script  run it and append --port <port>; it may carry
                              flags that matter (e.g. --client-logs)
    Monorepo                  run from the APP directory, not the repo root

  The reserved port comes from \`stim status\` or from a previous
  \`start --json\`. Then \`stim ios\` accepts it: its Metro gate checks that
  the process on the port answers /status AND runs from inside this project,
  and yours does.

  The cost is logs. Stim captures only a dev server it hosted, so
  \`stim logs\` stays empty -- which is indistinguishable from a clean run --
  and finding output is back to redirecting it to a file yourself. Prefer
  \`start\`.

  \`stop\` leaves an externally started server running and keeps the port
  reserved while it answers from this project. Stop it with the tool that
  started it.`,
};
