import type { GuideTopic } from './types.ts';

const lifecycle: GuideTopic = {
  summary:
    'The full worktree -> start -> ios/android -> logs -> teardown flow, with sections for builds, devices and flags',
  preamble: () => `ENVIRONMENT LIFECYCLE

Two workflows share steps 2 through 6.

SINGLE CHECKOUT: work in place, on a branch, in one directory. There is no
step 1, and step 7 reclaims the environment without deleting the tree, which
stays because it is the source checkout. That directory is your workspace, and
no rule here about keeping the source checkout fit as a seed applies to it.

WORKTREE: the checkout you cloned is a seed. It stays clean and on the default
branch so every worktree warmed from it starts current. Here the source checkout
is infrastructure, not a workspace, and every rule below about its fitness as
a seed belongs to this workflow.

  # 1. Create a linked worktree with Git, unless a harness already did.
  #    Choose the branch, path, and base ref with Git.
  git worktree add -b app/412 ../app-412 HEAD
  cd ../app-412
  stim worktree warm

  # Warm copies missing ignored state from the source checkout; it does not
  # install dependencies.
  # In a monorepo, enter the app directory before starting the dev server.

  # Optional: bring the SOURCE CHECKOUT up to date first, then copy that.
  stim worktree warm --refresh
    lock        acquired
    checkout    main 3 commits behind origin/main -> fast-forwarded to 9f2c1a3
    deps        source /w/main: pnpm-lock.yaml changed -> pnpm install (41s)
    pods        source /w/main/apps/mobile: ios/Podfile.lock unchanged -> skipped

  # 2. The dev server, under a detached supervisor. Blocks until it is
  #    verifiably THIS project's, then hands your shell back.
  stim start
    port       8082 (reserved)
    supervisor pid 41233

  # If stale Metro transforms or file-map state require recovery:
  stim start --reset-cache
  # Restarts only this app's verified owned Metro, retaining its port/devices.
  # Uses a fresh persistent cache namespace, not deletion of shared cache files.
  # Other apps and worktrees keep their caches. Subsequent starts reuse the new
  # namespace; another reset changes it again. Native build caches are unchanged.
  # Expo requires SDK 54+ and Stim's config adapter. Custom file-map cache
  # managers must honor Metro's fileMapCacheDirectory for file-map invalidation.

  # 3. Owned device booted, native inputs fingerprinted, cached build
  #    installed (or built), app launched wired to port 8082, device-log
  #    collector attached.
  stim ios          # or: stim android
    device      stim-app-412 (iPhone 17 26.5) (BF2A..) booted (9s)
    fingerprint a3f9b1.. hit (2s)
    install     from cache (3s)
    launch      com.example.app (1s)

  # 4. Reproduce the affected behavior and inspect the baseline errors.
  #    For a clean check, require exit 0 AND no matching errors.
  #    Human mode prints "No matching log records" on stderr for zero matches.
  #    Exit 0 alone means the query succeeded, even when it printed errors.
  stim logs --errors

  # 5. Edit the JS. Fast Refresh applies it; no Stim command is involved.
  #    For UI work, wait for the expected UI and repeat the affected interaction
  #    on the reported device, using the existing automation session if any.
  stim logs --errors
  #    Retain proof: a screenshot, recording, or relevant runtime output.
  #    See: stim guide lifecycle verification

  # 6. Pausing: supervisor halted, collectors reaped, owned device SHUT DOWN
  #    (never deleted), port freed. Coming back costs a boot, not a create.
  stim stop

  # 7. Remove this linked worktree and its environment. This also works for
  #    unwarmed worktrees with no Stim registry entry. Git-created branches stay.
  stim worktree remove

Steps 2 and 3 are ordered, not interchangeable: \`ios\` and \`android\` never
start the bundler, and refuse with STIM_NO_METRO when nothing holds the
reserved port. That refusal costs a second; the alternative costs four minutes
and produces an app that cannot load a bundle.

Repeat step 3 whenever a NATIVE input changes. A JS-only edit needs nothing --
that is what Fast Refresh over the running dev server is for. \`stim reload\` is
not part of the normal workflow. It is the explicit recovery path when Fast
Refresh cannot clear the current screen, and on Android after a failed first
bundle load. It reloads JavaScript and never restarts the app. Use \`stim
reload ios\` or \`stim reload android\` to select a platform when both owned
apps are live. For a physical device that reached Metro, use \`agent-device
metro reload --metro-port <reported-port>\`. The detected iOS Local Network
first-load remedy uses agent-device UI automation because no Metro peer exists
yet. It never builds, installs, boots, or cold-launches. It acts only on a live
app on this workspace's owned local simulator or emulator, and refuses release
builds, stopped or unowned devices, a missing or foreign Metro, and an
ambiguous no-platform request. Every reload goes over this workspace's Metro
websocket, on both platforms. It never reopens a development-client URL,
because that restarts the app rather than reloading its JavaScript.

How the message is addressed depends on the dev server, and \`strategy\` in
the facts reports which you got. Where Metro can name its clients, Stim
addresses every peer matching the platform and reports \`metro-websocket\`. A
workspace Metro serves one app, so those peers are this app on however many
devices are attached to that port, and \`targets\` says how many peers the request
addressed.
The bare React Native dev server cannot name its clients at all, so Stim
broadcasts: \`metro-broadcast\` means every app connected to that Metro
was sent a reload request and Stim cannot confirm \`appId\` was among them. Verify the UI on
\`deviceId\`; if it did not change, reload from the app's own error screen or
dev menu.

When Metro reports no peer for the app, Stim broadcasts a reload anyway before
giving up, because matching is best-effort and an unmatched peer may still be
this app. So verify the UI first: it may already have recovered. If it did not,
retry: a client reconnects every 2 seconds, which is also this probe's timeout,
so a single miss can be a reconnect window rather than an app that never
connected. If it stays unreachable on iOS, an error in the first bundle leaves
the app without a packager connection at all, and no retry will make it a peer.
The command then routes the agent to the device's own controls in its existing
automation session: press the error screen's Reload button, or open the dev
menu and press Reload when no error screen is showing, and relaunch only when
neither is reachable. Stim does not take over that stateful session.

When Metro itself does not answer within the probe's 2 seconds, nothing is
known about the app. The command says to retry and check the dev server rather
than sending the agent to the device.

A successful reload confirms that the request was sent. It does not wait for
new JavaScript or observe the resulting UI. Verify the expected screen or
interaction on the reported device and inspect \`stim logs --errors\` before
claiming recovery; exit 0 alone does not prove it.

An iOS simulator launch command has a 60-second deadline. This is separate
from bundle delivery and readiness verification: it gives CoreSimulator time
to accept the launch, not the app extra time to report readiness. A timeout
still fails the launch; Stim does not automatically retry it.

For an unverified Android launch, follow the emitted device-specific remedy.
If the app is stuck before loading its first bundle, restart its process with
the printed force-stop and launcher commands. Foregrounding the same process
does not restart initialization. Confirm the bundle request and expected UI.

Debug Android launches on an owned emulator created in the same run get up to
60 seconds for bundle loading; the verify phase names that budget. Existing
emulators, remote targets, and physical devices keep the 20-second budget.
Bundle delivery still requires the usual stability or app readiness check;
an observed fatal error ends verification without waiting for the deadline.

ANDROID EMULATOR RESTARTS
  \`stim status\` resolves owned AVDs to their currently detected adb serial.
  Its Android JSON adds serial and state (detected, not-detected, missing,
  or unknown). Detection confirms device identity, not app health. Status
  reports a serial change without changing forwarding or restarting anything.
  Rerun \`stim android\` with the same build options in that workspace to restore Metro
  forwarding, then reopen agent-device on the serial that run reports.
  Other workspaces' simulators and automation sessions remain theirs.

DESTRUCTIVE COMMANDS -- ask the user first
  gc --delete             deletes orphaned stim-* devices, tens of GB
  gc --delete --cache all empties the shared build caches every project uses
  gc --delete --cache <name>
                          empties only the caches that carry <name>
  worktree remove --force discards uncommitted and untracked work

Permanent local deletion lives in exactly TWO commands: \`worktree remove\`
(the workspace you name) and \`gc --delete\` (the machine). For a local device,
\`stop\` shuts it down and never deletes it. For a recorded EAS session,
\`stop\` irreversibly ends the session. Externally started servers are left
alone, even when they use the reserved port. There is no \`--delete\` flag on
\`stop\`.

CAPACITY
  A booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a
  16 GB machine plan for 2-3 live environments. Nothing enforces this;
  \`stim status\` is how you check -- it reports every workspace on the
  machine, not just this one.

TWO REPORTS, TWO QUESTIONS
  "What is running" is \`stim status\`: live state, right now. "How much the
  cache saved" is \`stim stats\`: aggregate counters for this project and for
  the machine, with a hit rate and an estimate of the time saved (see
  \`guide facts stats\`).`,
  sections: {
    eas: {
      summary: 'download a matching EAS development build; explicit profile, costs, cache and miss remedies',
      body: () => `EAS DEVELOPMENT BUILDS

  stim ios --eas-profile ios-simulator
  stim android --eas-profile development
  stim ios --eas-profile development-device --device <udid>
  stim android --eas-profile development --device <serial>

An eas.json file does not select EAS automatically. The flag names the profile
and selects EAS Build as the artifact source. The profile must resolve to
"developmentClient": true and "distribution": "internal". For iOS, set
"ios.simulator": true for a simulator, or false (or omit it) for --device.
An explicit ios.buildConfiguration must be Debug;
android.gradleCommand must be a single :app:assemble<Variant>Debug task producing
an APK. Install eas-cli and authenticate with eas login
or EXPO_TOKEN. The Expo app must already be linked to the intended EAS project.

Stim delegates profile inheritance, environment resolution and fingerprinting
to EAS CLI. fingerprint:generate uploads fingerprint metadata to EAS. It does
not start a native build. EAS access is needed even when the artifact is
already cached, because the current profile and fingerprint must be resolved.

Stim matches the EAS project, profile, native fingerprint, platform and
simulator/internal distribution target against a completed build. It downloads
an iOS .app or Android .apk with EAS CLI, then uses its existing installation,
Metro connection, log capture and launch verification on the selected device.
The flag also works with --remote; remote EAS Simulator sessions have their
own costs, independent of this download path. Local --scheme, --configuration,
--variant and --no-build-cache selectors
cannot be combined with --eas-profile. Local configuration/variant defaults
are ignored for this development-build run.

Physical devices use Stim's usual selection and lease rules. An iOS app must
have a development-client URL scheme and a valid embedded provisioning profile
that includes the target UDID. Stim installs the signed app without re-signing
it. If the profile does not admit the device, the remedy points to
npx eas-cli device:create and npx eas-cli build --platform ios --profile <name>.
Registration, signing changes and cloud builds need session authorization.
Run the EAS build interactively when its provisioning profile needs refreshing,
then retry the same Stim command.

Start Metro with stim start as usual. Metro uses the local workspace's
environment; arrange the appropriate local variables before starting it.
EAS environment resolution for native fingerprinting does not configure Metro.

EAS CLI caches extracted artifacts by project and build ID in its own temporary
cache. Stim calls build:download and uses the returned artifact without making
another cache copy. Every run queries the latest matching build, so a rebuild
with a refreshed provisioning profile is selected even if its native fingerprint
is unchanged. Stim coordinates concurrent downloads by project and build ID.
cacheHit: "remote" identifies the EAS source, including when EAS CLI reuses its
disk cache. The fingerprint fact is the EAS native fingerprint. Stim's local
buildCache and remoteBuildCache settings do not control EAS CLI's cache.
EAS cache files are managed by EAS CLI and are outside Stim gc.

On STIM_EAS_BUILD_MISSING, Stim stops before acquiring a device and prints:

  npx eas-cli build --platform ios --profile ios-simulator

Run that command only when the session authorizes the potentially billable
cloud build. Once it completes, retry the same Stim command. No build-on-miss
flag exists, and Stim never starts a cloud build or falls back to local
compilation in this mode. Authentication, network, invalid output or download
failures produce STIM_EAS_UNAVAILABLE, with the failed EAS command to inspect.
If another run holds the artifact claim, wait for it to finish and retry.`,
    },

    readiness: {
      summary: 'implement optional pending/ready app logs, deadlines, errors, and platform isolation',
      body: () => `OPTIONAL APP READINESS

No package or SDK is needed. This applies to debug ios/android launches with
Metro verification enabled, not release builds or --no-metro-check.

1. Add this at app startup, before essential initialization:

     if (__DEV__) console.info('[stim:readiness] pending');

2. Use the app's real ready state: essential initialization succeeded, usable
   content rendered, and the splash screen hidden. From that success path:

     if (__DEV__) console.info('[stim:readiness] ready');

   In an Expo root component with an existing isReady state:

     useEffect(() => {
       if (!isReady) return;
       let active = true;
       SplashScreen.hideAsync().then(() => {
         if (active && __DEV__) console.info('[stim:readiness] ready');
       }).catch(console.error);
       return () => { active = false; };
     }, [isReady]);

   Import useEffect from react and SplashScreen as a namespace from
   expo-splash-screen. Keep the pending log outside the component at module
   scope, before startup work. Use the project's existing splash lifecycle;
   do not add a splash dependency to a bare app just for this integration.
   Static imports run before module-scope statements. If imported startup work
   must opt into the wait, emit pending from an earlier app entry module before
   loading that work. A failure before pending keeps the default check.
   Cover login, onboarding, and deep links. Do not report ready merely on
   root mount, on a timer, in a failure handler, or in finally.

3. Run the platform command from the app directory. Check for the readiness
   phase and inspect the UI on the reported device. Exercise a slow success,
   a missing ready message, and a startup error. Retain the relevant output.

Without an observed pending, Stim keeps its default 3-second stability window
after bundle delivery. Managed Metro servers report the native bundle response
finishing; build-complete output alone does not close an observed request.
Without response capture, Stim falls back to the build-complete marker.
When Android reports queued JavaScript loading, Stim waits for a device
JavaScript log before starting stability, bounded by the bundle timeout.
Pending must be observed before the stability window closes. It opts into
waiting for ready until 30 seconds after the same completion signal.
Repeated pending messages never extend the deadline. Ready can end the wait
early; an app error or process exit interrupts it. No ready means readiness
not confirmed, not a crash or successful readiness.

Only exact standalone info/debug messages captured from this app's device log
for this platform and current launch are accepted. Stale, other-platform,
error-level, and embedded example messages are ignored. Unlabelled shared
Metro output cannot identify a platform. If pending is not captured in time,
including when device logs are unavailable, the default check applies.

The app declares readiness; Stim does not inspect a rendered frame. This does
not change launched JSON semantics or the need to inspect the expected UI and
stim logs --errors. A reload request does not run this launch check.`,
    },
    verification: {
      summary: 'reproduce the affected behavior, verify the change on the reported device, and retain proof',
      body: () => `VERIFY THE CHANGE

For a UI change or bug fix, decide what observable result would prove the task
is complete. A successful build, a live process, or an empty log query does
not prove that result.

1. On the device reported by ios or android, reproduce the affected behavior
   before editing and capture the baseline with stim logs --errors. If the
   issue does not reproduce, record what you tried instead of claiming it did.
2. Make the change. JavaScript and TypeScript normally use Fast Refresh;
   native input changes need another ios or android run. Follow the printed
   recovery remedy if an error screen remains or the native process exited.
3. Use the full reported device ID with your UI automation tool. Continue in
   the existing session for that device when one exists. Wait for the expected
   content or control before inspecting the screen; launch evidence alone
   does not prove that the first screen has rendered. Bound the wait and report
   verification as incomplete if the expected state never appears.
4. Repeat the affected interaction and check its expected outcome, then run
   stim logs --errors. Read the records, not just the exit code. Earlier client
   errors can remain after Fast Refresh; compare their timestamps with the
   reproduction and check whether they recur. Do not relaunch just to clear
   the log window. An empty query does not prove log capture succeeded.
5. Retain a screenshot for a visible result or a short recording for an
   interaction. Report what you exercised, what you observed, any unresolved
   errors, and the proof location before stopping the app or removing the
   worktree. If device access or another prerequisite prevents verification,
   name the missing check.

For a change without a UI effect, use the relevant runtime output or test
result as proof instead of requiring an unrelated screenshot.`,
    },
    progress: {
      summary: 'phase lines, the label set, heartbeats and their ~ estimate, what warm, start, stop and remove print',
      body: () => `PROGRESS ON A LONG RUN
  Native build progress goes to stderr. In \`--json\` mode, stdout carries only
  the result payload. Plain \`start\` also prints progress on stdout. Every
  progress line has the same shape -- two spaces, a label padded to eleven
  columns, the FACT, and the time the step cost:

    <label>     <fact> (<duration>)

  The labels are a closed set, and nothing else is ever printed in that
  column:

    branch      build       cache       caches      carry       checkout
    deps        device
    devices     error       failed      findings    fingerprint gems
    install     installs    ip.txt      lan         launch      lease
    lock        log
    logs        meaning     metro       pods        port        prebuild
    project     readiness   ready       remedy      removed     resolved
    result
    services
    setting     settings    setup       state       stats       stop
    storage     swap        verify      version     workspace

  \`app\` and \`compilation cache\` join them in the stdout block a successful
  run ends with. When a native build runs, its compilation-cache result is
  printed once as a \`cache\` progress line as soon as the build returns,
  including a failed build. It survives a later install or launch failure.
  The stdout \`compilation cache\` line is only for an artifact-cache hit
  (compilation did not run). A line states a fact; the reason a fact matters
  lives in this guide, not in the run output. Both platforms use the
  same words, so \`build       ok (51.8s)\` and
  \`launch      com.example.app (2s)\` read the same on iOS and Android; the
  artifact name is in the \`--json\` payload.

  A step that costs real time is named and timed, including the step that
  creates or reconciles the owned device:

    device      stim-app-412 (BF2A..) created (2m14s)

  On iOS that step does not wait the boot out. It creates the simulator, asks
  it to boot, and hands the wait back, so the run fingerprints the native
  inputs and resolves the build cache while \`simctl bootstatus\` is still
  running; it joins the boot before it installs anything. The
  \`device ... booted\` and \`fingerprint ...\` lines each report their own
  elapsed time, and those two overlap -- adding every line up overstates the
  run.

  A step that is still running heartbeats every 30 seconds, on the 30-second
  grid, so the values read 30s, 1m00s, 1m30s and never repeat. A heartbeat
  reuses its phase's label and column and names what the phase is doing, never
  the build tool's own last line -- that transcript is in the build log
  (\`logs --source build\`):

    build       still compiling (1m00s of ~3m10s)
    build       still compiling (4m00s, usually ~3m10s)
    build       still compiling (1m00s)
    pods        still installing (1m30s of ~1m40s)
    build       waiting on /w/app-411 (pid 41233, 1m30s elapsed) -- stim guide lifecycle concurrency

  The \`~\` value is an estimate, never a countdown; the third line is a
  project with no record to estimate from yet. \`guide facts stats\` says where
  the number comes from.

  The lifecycle commands use the same column. \`worktree warm\` reports
  copied and kept entries on stderr, with empty stdout:

    carry       copied node_modules from /w/main
    carry       complete: 1 ignored entries copied, 0 kept, 0 failed

  \`--refresh\` always prints a \`lock\` line, then its own facts, one per
  step, before those. A plain warm prints the \`lock\` line only when its copy
  actually waited for another warm:

    lock        acquired (waited 12s for stim worktree warm --refresh pid 41233) -- stim guide lifecycle options
    checkout    janic/wip 2 commits behind origin/janic/wip -> fast-forwarded to 4b81e0c
                not the default branch (main); worktrees seeded from this copy
                carry janic/wip's dependencies
    deps        source /w/main: pnpm-lock.yaml unchanged -> skipped
    pods        source /w/main/apps/mobile: ios/Podfile.lock changed -> pod install (1m12s)

  A wait reports how long this caller has waited and names the holder:
  \`lock        waiting 40s for stim worktree warm --refresh (pid 41233) -- stim guide lifecycle options\`.

  \`start\` names the port, the supervisor mode and its pid on one line
  (\`metro       starting on port 8083 (expo-child, supervisor pid 13724)\`),
  and \`stop\` reports what it released:

    stop        supervisor pid 34856
    stop        collector ios pid 45268
    device      shut down stim-e2e-2
    port        released 8084

  \`worktree remove\` reports itself the same way: the branch decision, the
  owned device, any released device lease, and this workspace's own state
  directory, each on its own line. Nothing prints on stdout; even the removed
  path is on stderr:

    branch      kept app/412 (Stim did not create it)
    device      parked stim-parked (iPhone 17 26.5) 9c1f (9C1F..)
    lease       released the ios lease on 00008101-000A10913C89001E (it ran until 14:32:10)
    workspace   removed /w/.stim/workspaces/3f9c2a
    removed     /w/app-412

  Removal works with any linked worktree, whether warmed or not, and does not
  require a Stim registry entry. Git-created branches are kept. An existing
  Stim ownership record permits deleting a branch only when it has no unique
  commits; otherwise the command reports why it kept it. On the source checkout,
  \`worktree remove\` reclaims only the
  environment -- the same \`device\`, \`lease\` and \`workspace\` lines, ending
  with a sentence instead of a \`removed\` line, because the checkout itself
  is never touched: \`Reclaimed the environment; the working tree stays (it
  is the source checkout).\`

  A GAP BETWEEN HEARTBEATS IS NOT A HANG. Stim runs device tools
  synchronously, so a long \`simctl\`, \`adb\` or copy call holds the timer
  until it returns; the next heartbeat then lands on the grid, which is why an
  elapsed value can jump. Read the phase lines, not the wall clock, before
  killing a run.`,
    },
    pool: {
      summary: 'parked and adopted simulators: what park and adoption clear or keep, the model and runtime match',
      body: () => `  THE SIMULATOR POOL
  \`worktree remove\` PARKS this workspace's owned simulator instead of
  deleting it, and the next workspace that wants the same model and runtime
  ADOPTS it. A simulator that has booted before boots in about 9s; a freshly
  created one costs about 30s, and \`simctl erase\` puts most of that back, so
  a parked simulator keeps its app installed and is cleaned in pieces:

    at park       shut down, the app's data cleared on disk (Documents,
                  Library, tmp, SystemData: NSUserDefaults, AsyncStorage,
                  SQLite), renamed \`stim-parked (<model> <runtime>) <4 hex>\`
    at adoption   renamed for the adopting workspace, then, inside the boot
                  the run pays anyway, \`simctl privacy reset all\` and
                  \`simctl keychain reset\`; at install, every OTHER app the
                  previous workspace left is uninstalled

  A parked simulator KEEPS its system state: pasteboard, Safari data, photos,
  contacts, calendars, installed profiles, Simulator settings, app-group
  containers, and device-level defaults. Isolation covers the app's data, the
  privacy grants, the keychain and the installed apps -- not a clean system
  image. Set the bound to 0 when a project needs one.

  Adoption matches the device type AND the runtime EXACTLY: a ticket that asks
  for an iPad never gets an iPhone, and a request for iOS 18.5 never gets 26.5.
  No match creates a new simulator, as before. After a runtime upgrade the
  parked simulators on the old runtime are never adopted; they leave by
  eviction or \`gc --delete\`.

  The pool targets at most \`pool.iosParkedMax\` simulators (default 3, about
  2.5 GB each). Past that the oldest parked one is deleted:

    device      parked stim-parked (iPhone 17 26.5) 9c1f (9C1F..)
    device      deleted stim-parked (iPhone 17 26.5) 4b02 (pool over 3)

  A failed or unverifiable deletion keeps its ownership record so \`gc\` can
  retry it. The reported pool can temporarily exceed the bound rather than
  orphaning a simulator.

  and an adopting run says so where a plain boot would say \`booted\`:

    device      stim-app-412 (iPhone 17 26.5) (9C1F..) adopted (11s)

  That time includes the two resets, so it runs longer than a plain boot.
  \`stim status\` prints one line while the pool is not empty:

    pool: 2 parked iOS simulators (max 3)

  \`stim gc\` reports the pool, and \`stim gc --delete\` empties every entry
  it can re-verify:

    Parked simulators (2, 5.1 GB):
      ios stim-parked (iPhone 17 26.5) 9c1f (9C1F..) iPhone 17 26.5 parked 3d ago 2.6 GB
                  --delete attempts every parked simulator and keeps failures.

  If simulator listing or deletion fails, \`gc --delete\` reports the failure
  and keeps that entry. It never turns an unverified absence into a dropped
  ownership record.

  That deletion works even under a redirected \`STIM_HOME\`, where the sweep
  for unlisted \`stim-\` devices stays refused: a parked record in THIS config
  proves that simulator is Stim's and parked by this home. \`stop\` never
  parks -- it shuts the owned simulator down and keeps it assigned. Neither
  does \`gc --delete\`, which is deleting what it finds.

  ANDROID EMULATOR POOL
  Android uses the same bounded park/adopt lifecycle, with
  \`pool.androidParkedMax\` (default 3) or STIM_POOL_ANDROID_PARKED_MAX.
  A redirected STIM_HOME disables parking unless that environment override
  is set. Zero disables parking and adoption. \`stop\` keeps the assignment;
  \`worktree remove\` parks eligible AVDs, and \`gc --delete\` empties the pool.

  Adoption matches the system image, data partition size, and the creation
  settings from android.avdConfig / android.avdConfigFile. The AVD keeps its
  original stim-<label> name so its Quick Boot snapshot can survive reuse.
  Normal desktop boots allow Quick Boot; headless Linux disables snapshots.
  Incompatible AVDs stay parked until eviction or GC. AVDs created by older
  versions without a recorded creation configuration are deleted at removal.

  When a fresh AVD's preferred name belongs to another workspace or a parked
  entry, Stim adds a short suffix instead of taking over that device. Always
  use the actual device name and serial reported by the platform command.

  Android cleanup happens AFTER boot, before install or launch: \`adb shell
  pm clear\` clears the adopting app's data while retaining its APK, and
  other third-party apps are uninstalled. If ADB goes offline or closes the
  connection, Stim waits for boot readiness and retries cleanup for up to 30
  seconds, verifying the same owned AVD before each destructive command.
  Failed cleanup blocks launch and remains pending for a retry. The installed APK's SHA-256 must match the
  requested artifact before Stim skips installation; a package name or cache
  key alone is insufficient, including for release builds with swapped JS.
  If the retained APK has a conflicting signer or version, adoption uninstalls
  it and retries installation. Adoption stays pending until installation succeeds.

  Parked AVDs retain app data until adoption. System apps, shared storage,
  accounts and device settings also remain: this is not a factory reset.
  Set the Android bound to 0 when a project needs a fresh device. Status lists
  parked Android emulators; GC reports their system image, age and disk size.
`,
    },
    builds: {
      summary:
        'optional cache warm-up, build optimizations, fingerprints, .fingerprintignore, install unchanged, runtime state',
      body: () => `OPTIONAL CACHE WARM-UP FOR REPEATED NATIVE WORK
  When several native worktrees are coming, build the source checkout once to
  seed the shared caches before warming the linked worktrees. Skip this extra
  build for one-off or JavaScript-only work. For local simulator or emulator
  work, run these commands in the source checkout's app directory:

    stim doctor --platform ios        # or: --platform android
    stim start
    stim ios                          # or: stim android
    stim stop

  Follow the normal ownership and consent rules in guide agent.

IOS SCHEME SELECTION
  Pass \`stim ios --scheme "App Staging"\` to select an exact shared Xcode
  app scheme. Unknown names refuse with the available choices. This is the
  Xcode scheme, not the app's URL scheme. Combine it with --configuration
  when choosing both an app scheme and a build configuration.

  Without --scheme, automatic selection is unchanged:
  Stim keeps a scheme matching the workspace/project name, or the sole non-test
  scheme. When neither identifies one, it also checks the static top-level name
  in the app directory's app.json against Xcode's listed schemes. It does not
  execute app config or choose an arbitrary scheme from an ambiguous list.
  If selection fails, pass --scheme with an available name, or share the app
  scheme in Xcode first. See guide errors STIM_NO_SCHEME.

  Explicit schemes have separate artifact keys, shared-build locks, and Xcode
  build directories. Stim identifies the resulting application from Xcode's
  resolved build settings, even when the scheme and product names differ;
  ambiguous products refuse rather than installing another app. Local and
  configured Stim cache providers use the scheme-specific key. The older Expo
  buildCacheProvider tier is skipped for explicit schemes because a provider
  may key only on the fingerprint and return another scheme's app. Omitting
  --scheme retains the existing cache keys and provider behavior.

AN ARTIFACT THE DEVICE ALREADY HOLDS IS NOT INSTALLED AGAIN
  Both platforms store the artifact verbatim, so its hash is its identity.
  Before installing, Stim hashes the artifact it is about to install and the
  one the device already has -- \`pm path\` then \`sha256sum\` on Android, the
  \`simctl get_app_container\` bundle on iOS. Byte-identical means the install
  is skipped. The phase still reports the cost of proving that identity, but
  avoids the ~43s a 400MB APK can cost to copy and install over USB.

    install     unchanged (emulator-5584 already has this build) (0.4s)

  On iOS the install line names the identity proof separately from the Expo
  dev-client preference writes, so a slow simulator command is never charged
  to an install that did not run:

    install     unchanged (stim-app already has this build) (0.4s)
    install     dev client prepared (0.9s)

  The skip needs PROOF. A package that is not installed, a split install, an
  image without \`sha256sum\`, and any adb or simctl failure all read as
  "cannot determine", and the run installs exactly as it always did. A release
  run swaps this workspace's JS into a COPY of the artifact, which is a
  different artifact and is therefore always installed.

  \`--json\` carries installSkipped so a caller can tell a skipped run from an
  installed one.

RUNTIME STATE AND BUILD INPUTS
Runtime state is stored outside the project tree under
$STIM_HOME/workspaces/<project>--<digest>/ (default ~/.stim/workspaces/).
The aggregate run counters \`stats\` prints live beside it in
$STIM_HOME/stats.json, one bucket per project and platform plus a machine-wide
one; nothing per run is kept there.
No .gitignore entry is created or required.
Native preparation can change project files: expo prebuild generates native
sources, and pod install can update Podfile.lock. Review those changes before
committing. The shared caches need no project-file edits. The defaults below can be changed
with machine or project optimization settings; see \`guide settings\`:

  ios      xcodebuild carries COMPILATION_CACHE_ENABLE_CACHING, a shared
           COMPILATION_CACHE_CAS_PATH and a clang prefix mapping of this
           workspace's root, so compiled output crosses worktrees with no
           Podfile post_install block. Xcode 26+ only, and skipped entirely
           when the project configured ccache (the two defeat each other).
  android  gradlew carries --build-cache, so task outputs cross worktrees with
           no org.gradle.caching=true in gradle.properties. Debug builds also
           carry -PreactNativeArchitectures=<target ABI>, using the owned
           emulator system-image ABI or the physical device's primary ABI.
           Unknown targets and Release builds stay universal.
  ccache   the same gradlew run carries an absolute
           CMAKE_C_COMPILER_LAUNCHER / CMAKE_CXX_COMPILER_LAUNCHER plus
           CCACHE_DIR, CCACHE_BASEDIR, CCACHE_NOHASHDIR, CCACHE_SLOPPINESS
           and CCACHE_MAXSIZE whenever a ccache binary is on PATH, so the C++
           objects cross worktrees as well. Nothing is set when ccache is
           absent, or when the project passes a CMake compiler launcher of
           its own.
  start    the dev server gets a shared Metro FileStore APPENDED to whatever
           the project configured -- in-process on a bare project, and through
           Expo's config override on SDK 54+. Expo SDK 53 and older use their
           normal Metro cache. Turn it off machine-wide with
           { "optimizations": { "metroSharedCache": false } } in
           ~/.stim/config.json; see \`guide settings\`. A project that calls
           \`sharedCacheStores()\` from @stim-cli/metro in its own metro
           config also gets the \`cache.provider\` tier behind that store.

Every Stim Android build uses a CMake staging profile, including the default
ccache mode. The first run with this layout configures a separate build tree;
changing modes selects another profile. See \`guide settings\` for cleanup.

Each reports its cache setup. \`stim doctor\` checks missing or stale setup
when a build is blocked or slow. It reports what Stim cannot handle itself
(ccache absent from PATH or a .cxx that predates the
launcher, a fingerprint no fresh worktree reproduces, a provider on a key this
SDK ignores) and settings for builds outside Stim.

IOS DEBUG ARCHITECTURES
Doctor reads Xcode's effective Debug simulator settings for app targets and
generated Pods, including xcconfig inheritance and SDK-specific overrides.
It warns when ONLY_ACTIVE_ARCH=NO leaves multiple architectures after ARCHS,
VALID_ARCHS, and EXCLUDED_ARCHS are combined. A Podfile post_install helper can
cause this even when the app target already uses ONLY_ACTIVE_ARCH=YES.
Review that override for local Debug builds; preserve intentional Release and
distribution settings. Regenerate Pods through the project's normal workflow
after changing a helper, then rerun \`stim doctor --platform ios\`.
Doctor never evaluates Podfile Ruby, installs Pods, or changes architecture
settings, including under --fix. This inspection runs only in doctor, with
30 seconds per Xcode query and 60 seconds total. Missing generated projects,
failed metadata queries, and unresolved settings produce an unverified note
rather than an architecture warning or a verified clean result.

WHY ANDROID NEEDS CCACHE, AND WHAT IT COSTS
Every AGP CMake task is uncacheable by Gradle, so --build-cache serves not one
C++ compile. Without a launcher a fresh worktree recompiles every translation
unit, which on a React Native app with native modules is most of a first build.
The shared objects live at $STIM_HOME/ccache (default ~/.stim/ccache), which is
registered for \`gc\` and prunes itself at CCACHE_MAXSIZE.

CCACHE_BASEDIR rewrites paths under the workspace root relative to the compile
directory and CCACHE_NOHASHDIR keeps the working directory out of the hash;
together they are what lets an object built in one worktree match in another.
The trade-off is the same class as the iOS CAS one: an object reused from
worktree A carries A's directory as its DWARF comp_dir, so a debugger stepping
into reused C++ resolves sources against that path.

When Stim supplies ccache, its Gradle init script defaults Android app and
library CMake builds to CMAKE_DISABLE_PRECOMPILE_HEADERS=ON. PCH inputs can
retain a previous worktree's paths even with upstream timestamp fixes, causing
the header and its consuming objects to miss. Compiling ordinary headers
instead favors reuse across worktrees at the cost of a slower cold C++ build.
This does not edit dependency sources or change iOS builds. Without Stim's
ccache setup, auto PCH behavior is unchanged. Explicit optimizations.android.pch
on/off applies with any compiler cache selection. A module with an explicit
CMAKE_DISABLE_PRECOMPILE_HEADERS argument in its default config, build types,
or product flavors keeps that choice; CMake target-level PCH overrides also
take precedence. Direct Gradle builds do not receive Stim's init script.

EXPERIMENTAL ANDROID CAS
optimizations.android.compilerCache="cas" with android.casToolchain under the
same optimizations object selects a private Apple Clang toolchain manifest
on macOS. STIM_ANDROID_CAS_TOOLCHAIN also selects CAS in auto mode. It retains
PCH and replaces the ccache setup for that invocation.
Compiler results live under $STIM_HOME/android-cas/<toolchain-id>; APK cache
keys include that ID. This is a development prototype requiring a compatible
linker and NDK copy, not an automatically installed backend. Because the
manifest lives outside the repository it can rot: when the setting holds any
value that is not an absolute path, or the manifest it names is missing or
unreadable, the build warns once naming the setting and the file it came from,
then compiles through the cache the selection leaves -- ccache, or none when
compilerCache is none. It never refuses. See
https://stim.appandflow.com/docs/android-cas for setup, evidence, and limits.
Compiler/PCH modes have separate generated directories under each module's
.cxx/stim-<profile> (or custom staging root). Switching modes in Stim selects
the matching directory; direct Gradle builds keep their own configuration.
Generated CAS directories still depend on Stim's environment and adapter paths.

For older, unprofiled builds, the launcher persists in the project. AGP writes
it into each
.cxx/**/CMakeCache.txt on the first configure, so a plain \`./gradlew\` in that
checkout also compiles through ccache -- and a .cxx configured BEFORE the
variables existed can keep compiling without them until it is cleared once.
\`stim doctor\` reports stale configurations in this checkout's app and installed
native modules. Stop native builds, then run \`stim doctor --fix --platform android\`:
it removes only affected ignored, untracked legacy .cxx configurations and
reruns the diagnostics. Managed profiles and disabled compiler caches are
left alone. A cas selection Stim cannot use resolves to ccache, so that
checkout's legacy configurations become eligible for the same repair. A config
the repair cannot read repairs nothing. The next build recreates legacy output. It refuses directories
outside the checkout and configured custom launchers. Shared ccache entries and
source files are preserved. Its cache-lock check cannot detect --no-build-cache,
release-swap fallback, or direct Gradle builds; stop all native builds and keep
them stopped until repair finishes.
Run it before copying the checkout into worktrees.

THE BUILD CACHE HAS THREE LEVELS
  1. Stim's own, on this machine: a directory under ~/.stim shared by
     every worktree, keyed on the @expo/fingerprint hash of the native inputs.
     Free, instant, offline, and the only level a project without any
     provider has.
  2. The project's own cache provider, on ANY project including bare React
     Native: \`cache.provider\` in the settings, a module implementing the
     @stim-cli/cache contract (see \`guide settings\`). Consulted only when
     level one misses, and its hit is stored into level one before install.
     The same contract serves the Metro transform cache.
  3. On an EXPO project only, the provider the project ALREADY configured for
     Expo (\`expo.buildCacheProvider\` -- "eas", or a module of its own).
     Consulted only when levels one and two miss, bounded so a slow or expired
     remote cannot stall the loop, and a hit is copied into level one on the
     way past so the next workspace on this machine gets it for free. After a
     build, the result is stored locally AND handed to both providers, which
     run independently. An ABI-targeted Android Debug build skips this Expo
     tier because its run-options contract cannot distinguish ABIs; levels one
     and two remain ABI-keyed and active.

  Stim never configures a provider and never suggests changing one: a
  project without one is a perfectly ordinary local-only project (doctor does
  not ask for one either -- a provider only serves builds run OUTSIDE Stim).

  A provider that fails to load, times out, or errors produces ONE note per
  failure class and the run continues on the local cache. \`gc\` reports,
  trims, and clears local caches only: the provider contract has no delete
  operation, so no local command can remove data a team or CI system shares.

  A MISS explains itself when it can. When this workspace's previous build
  stored its fingerprint sources beside the cache entry, the fingerprint line
  gains " -- N sources changed: <up to three paths>", and the full list
  (capped at 20 names) lands in the build log as a fingerprint_diff record.

  THE KEY CAN MOVE MID-RUN, and the run says so in two facts rather than two
  explanations. \`expo prebuild\` and \`pod install\` rewrite fingerprinted
  files while they work, so the run fingerprints again afterwards:

    fingerprint dcbd8d.. -> 6564e2.. (after prebuild, pod install)
    cache       hit 6564e2.. (post-prebuild/pod install key)

  The first line means the artifact, the \`lastBuild\` record and any remote
  upload are stored under the SECOND hash -- the one the next run in this tree
  computes, and therefore the one it looks up. The second line only appears on
  a tree that was COLD: the first lookup ran on the pre-prebuild hash and
  could not find an entry another workspace had already stored under the
  post-prebuild one, so re-resolving under the moved key installs it instead
  of compiling beside it. No second line means nothing was found there and the
  run compiles.

  If the iOS fingerprint after prebuild or pod install is unavailable, Stim
  installs the build but skips local storage and remote uploads. fingerprint
  and cacheKey are null in the result and lastBuild; the old key is not reused.
  Android does the same if its post-Gradle fingerprint cannot be computed.
  These null fields mean unavailable cache information, not an install failure.

WHAT MAKES THE CACHE ACTUALLY HIT: .FINGERPRINTIGNORE
  Every entry is keyed on what the tree hashes, so two workspaces share an
  entry only when they hash alike. A file that changes without changing the
  BUILD is what breaks that, and it fails silently -- a cache that never hits
  looks exactly like a cache that is not there.

  Stim ignores two paths a fresh checkout never has and no native build reads:
  android/local.properties and android/.idea. A project does not repeat those.
  Everything else is the project's call, including a lockfile whose checksums
  embed machine paths -- ignoring a path any project might read turns a slow
  build into a wrong one.

  A linked native library (a \`link:\` or \`file:\` dependency, or a workspace
  symlink) brings its checkout's .git into a directory the fingerprint hashes
  whole; Git rewrites that metadata on every commit, checkout, or worktree, so
  workspaces rarely agree. \`stim doctor\` names the entries to ignore when the
  native build does not read Git state: the .git path as the fingerprint sees
  it and its /**/* form, which is what skips a .git directory's contents.
  Ignore those entries only, never the package.

  \`.fingerprintignore\` at the project root (same syntax as .gitignore) is the
  answer. Put in it only what genuinely cannot change the native build: a
  generated report, a local env file, a lockfile whose checksums embed absolute
  machine paths (\`ios/Podfile.lock\` is the usual one -- pod checksums can bake
  in a machine path, and \`pod install\` rewrites it on a plain re-install).
  Never ignore a real native input -- a Podfile, a gradle file, the app config
  -- to force a hit: that trades a slow build for a wrong one.

  \`stim doctor\` measures this directly rather than reading the file: it
  fingerprints HEAD in a temporary clean worktree, compares, and reports a
  mismatch naming the differing sources. Untracked, non-gitignored files under
  ios/ or android/ count too -- they are hashed like any other source, so a
  stray file there moves the key on your machine and nowhere else.`,
    },
    concurrency: {
      summary: "waiting on another workspace's build, --no-build-cache, concurrency.maxBuilds and maxDevices",
      body: () => `ONE COMPILE PER FINGERPRINT, ACROSS EVERY WORKSPACE
  The cache makes the SECOND workspace on a commit free -- but only once the
  first has finished. Three agents starting within the same minute all miss it,
  and without this all three compile the same app at once, fighting for the
  same cores. So when both cache levels miss, the run takes a LOCK on
  <fingerprint, platform> (a directory under ~/.stim/build-locks). Exactly
  one workspace compiles; the others print

    build       /w/app-412 is already building a3f9b1.. (pid 41233) -- tail ... -- stim guide lifecycle concurrency
    build       waiting on /w/app-412 (pid 41233, 4m elapsed) -- tail ... -- stim guide lifecycle concurrency
    build       waited 12m41s for /w/app-412's build -> installed from cache -- stim guide lifecycle concurrency

  and install the artifact the builder stored. They report cacheHit: "local"
  plus waitedForBuild: { pid, ms }.

  Native preparation can move the builder's cache key. A released lock with no
  artifact at the original key does not prove the build failed. The waiter
  rechecks after its own native preparation; a matching post-preparation cache
  hit retains waitedForBuild. Artifacts remain stored only under their final
  fingerprint, never under the old key.

  Nothing can deadlock on it. The lock records the holder's process IDENTITY,
  so a builder that crashes, is killed, or whose build simply fails frees it:
  the waiters see a released lock with no artifact, and one of them takes over
  and builds. A recycled pid reads as a gone builder, and a builder busy in a
  long synchronous tool call reads as live -- age is never a reason to take a
  lock. The one state that cannot be decided (a truncated claim, an identity
  token that does not decode) is STIM_CLAIM_REFUSED: Stim names the claim and
  the command that removes it rather than guessing. A process whose own identity
  cannot be captured takes no lock and no slot, and refuses with
  STIM_CLAIM_UNAVAILABLE rather than building unprotected. The
  other waiters keep waiting for that holder. All replacement builders share
  one ~90-minute deadline, including lock acquisition between waits; reaching
  it returns STIM_BUILD_WAIT_TIMEOUT naming the current holder and lock.

  --no-build-cache looks nothing up -- not the local cache, not either
  provider -- and takes no lock and never waits, because it asked for a compile
  of its own. It still STORES the result, over the entry it was told not to
  trust, and still uploads it. Use it when a cached artifact is suspect; the
  --json payload reports cacheSkipped: true so a caller can tell that run apart
  from a plain miss.

OPT-IN CONCURRENCY LIMITS (UNLIMITED BY DEFAULT)
  Stim imposes NO limits of its own: unset is exactly the behaviour above --
  every build compiles, every device boots. When a machine cannot host as many
  parallel builds or booted simulators as there are agents, two MACHINE-level
  caps rein it in. They live under a top-level \`concurrency\` key in
  ~/.stim/config.json (not per-project -- the resource being shared is the
  machine's), and STIM_MAX_BUILDS / STIM_MAX_DEVICES override the file.
  Absent, 0, or any non-positive value means NO enforcement.

    concurrency.maxBuilds   how many builds COMPILE at once. It is a semaphore
                            of N slots (~/.stim/build-slots). A run takes a
                            slot AFTER the single-flight lock -- a workspace
                            waiting to install another's identical artifact
                            never burns a slot -- so it caps distinct compiles,
                            not waiters. A full slate WAITS (this is batch work),
                            printing the same kind of progress line the build
                            lock does, and a dead builder frees its slot within
                            a poll (process identity, like the lock).

    concurrency.maxDevices  how many Stim-owned devices are BOOTED at once. Checked
                            at device time, before a sim is created or booted.
                            At the cap, a NEW device is REFUSED with
                            STIM_AT_CAPACITY (interactive-shaped: it does not
                            queue). A workspace whose own device is already
                            booted is never refused.
                            See \`guide errors STIM_AT_CAPACITY\`.

  \`stim doctor\` prints one note echoing the caps and the current live count,
  but ONLY when a cap is set. \`stim gc\` reports stale build slots the way it
  reports stale build locks, and \`gc --delete\` clears them. There is no
  \`stim config\` command: set these by editing ~/.stim/config.json or via
  the two env vars (see \`guide settings\`).`,
    },
    options: {
      summary:
        'every flag per command, Android variants and flavors, the per-run simulator model, runtime and system image',
      body: () => `THE OPTION SURFACE, IN FULL
  start           --json --wait <seconds> --remote --reset-cache
  ios             --slot <name> --json --no-metro-check --no-build-cache --scheme <name> --configuration <name> --device-type <name> --runtime <version> --device [udid] --wait <seconds> --no-wait --remote <proxy|eas>
  android         --slot <name> --json --no-metro-check --no-build-cache --variant <name> --system-image <id> --device [serial] --wait <seconds> --no-wait --remote <proxy|eas>
  reload          [ios|android] --json
  device          lock <ios|android> [id] --slot <name> --for <duration> --wait <seconds> --json;
                  unlock [ios|android] --slot <name> --json
  logs            --slot <name> --source --level --since --grep --tail --follow --errors --json
  stop            --slot <name> --json
  status          --json          (already machine-wide)
  stats           --json          (this project and machine-wide)
  doctor          --json --fix --platform <ios|android>
                                  (--platform keeps shared checks and filters native findings)
  gc              --delete --older-than <days> --cache <name|all>
  worktree warm    --refresh; remove [path] --force

  DEVICE SLOTS
  Use --slot <name> on ios or android to keep any number of simulators,
  emulators, or physical devices in the same workspace. Names are reusable
  identities, not models: two slots can request identical models. A slot has
  one target per platform. Omitting the flag selects default and preserves
  the workspace's existing assignment.

    stim ios --slot phone
    stim ios --slot tablet --device-type "iPad Pro 13-inch (M4)"
    stim ios --slot hardware --device <udid>
    stim android --slot second-phone
    stim logs --slot tablet --source device
    stim stop --slot tablet

  All slots share this workspace's Metro server and build cache. Native CLI
  runs serialize workspace mutations; a waiting run can wait up to 30 minutes.
  Named slots support local devices; remote sessions use the default slot.
  Names use 1-64 letters, digits, underscores or hyphens, starting with a letter
  or digit. Reserved object-property names are refused.

  stop --slot shuts down that slot's owned devices and releases its leases,
  retaining Metro and sibling slots. Plain stop handles the whole workspace.
  status reports named devices under slots and counts their memory. Device
  caps count every slot. Recycling uses the same model/runtime-matched pool
  for every slot, with one shared cap per platform and oldest-first eviction.

  Metro cannot reliably identify a particular simulator's bundle request.
  When slots coexist, a shared bundle event is not proof that a particular
  slot launched: Debug launch can report unverified. Check the reported device
  directly. Release verification still checks its process. reload ios/android
  addresses matching Metro peers across slots; it is not a single-slot reload.

  That is the whole surface today, and it is deliberately small. It can grow
  when a flag is genuinely the best answer -- but project-specific knowledge
  (release builds, variants, device targets) belongs in a script the repo owns,
  not in a flag here.

  \`stim worktree warm\` takes one flag, \`--refresh\`. Run it anywhere inside
  the current linked worktree to copy missing ignored entries from its source
  checkout, regardless of either branch's HEAD. Both roots must be registered
  worktrees of the same Git repository; the source checkout must be available.
  Running it in the source checkout refuses.

  \`--refresh\` WRITES TO THE SOURCE CHECKOUT before the copy, which is why it
  is opt-in: it fetches, fast-forwards whatever branch is checked out there to
  its \`@{upstream}\`, and installs what the new commits moved. It refuses a
  source checkout it cannot move -- uncommitted changes to tracked files or a
  rebase or merge in progress (STIM_MAIN_DIRTY), a detached HEAD
  (STIM_MAIN_DETACHED), or a branch that is both ahead and behind
  (STIM_MAIN_DIVERGED) -- and each refusal names the git line that clears it.
  Untracked files are not a reason to refuse. A branch with no upstream is
  left where it is. A fetch that fails is a fact, not a refusal: the run
  continues on the local state. It never switches branches, never merges, and
  never resets; fast-forwarding a feature branch is safe, so it only WARNS
  that the copy will carry that branch's dependencies. The default branch it
  compares against is \`worktree.defaultBranch\` in the repository-root
  .stim.json, else \`git symbolic-ref --short refs/remotes/origin/HEAD\`;
  when neither answers it says so and makes no warning.

  Dependencies install where the lockfile is, which in a monorepo is the
  repository root, when the lockfile moved or nothing is installed. Pods run
  for the app the command was invoked from, and only that app, when its
  ios/Podfile.lock moved or ios/Pods/Manifest.lock does not match it. Each
  completed or skipped deps and pods step names its source directory and
  reason. A failed install refuses with STIM_DEPS_FAILED and nothing is copied.

  An install that did not finish is remembered, and a PLAIN warm reads that
  before it copies. The refresh records the completed install of the lockfile it
  read under ~/.stim/warm-installs; a plain warm reads that record after it
  takes its claim, and refuses with STIM_DEPS_INCOMPLETE, copying nothing, when
  the unfinished install is of the lockfile as it stands NOW -- otherwise the
  copy carries a partial node_modules and exits 0, and only the refresh's own
  terminal ever said the install failed. A record of a different lockfile does
  not block a copy, and a repository with no record copies exactly as it did
  before the record existed. The remedy is \`--refresh\`, which reinstalls rather
  than skipping on the same record, so a refresh killed mid-install -- which
  writes no failure anywhere -- is recovered the same way a failed one is.

  One lock per repository serialises this, whether or not you pass the flag:
  \`--refresh\` holds it exclusively, and every copy holds it shared, so a copy
  can never read a node_modules a refresh is rewriting. Two plain warms of the
  same repository run together. The lock is keyed on the repository root, so
  two apps of one monorepo share it. It is the same ownership claim the build
  locks take: the holder's process IDENTITY decides, so a holder that dies frees
  it, a recycled pid cannot keep it, and a refresh whose install runs in a
  spawned process group holds it while that group lives. A wait prints the
  holder every 30s and gives up with STIM_LOCK_TIMEOUT; a claim Stim cannot
  resolve refuses with STIM_CLAIM_REFUSED and names the removal rather than
  waiting on it or removing it.
  A plain warm that cannot record a claim at all -- an unwritable STIM_HOME, a
  STIM_HOME on a read-only mount or under a dangling symlink, a STIM_HOME that
  is a file, or no \`unique-pid\` build for this platform
  (STIM_CLAIM_UNAVAILABLE) -- says so in one dim line and copies without it,
  exactly as it did before the lock existed, because a copy only reads.
  \`--refresh\` refuses instead, because it writes. Before that unsynchronised
  copy starts, warm still READS the claim set, which needs no claim of its own:
  if a refresh holds this repository, or a claim in it cannot be resolved, the
  copy refuses rather than reading a tree that is being rewritten. That read is
  not a lock, so a refresh that starts after it is not covered; it closes the
  window in which one is already installing. Closing the rest needs a claim,
  which is the one thing that state cannot record, so the residual is
  documented rather than fixed (appandflow/stim#696), as is the
  \`acquired (waited 0s ...)\` a contended-but-fast wait prints.

  Wait for warm to exit successfully (exit code 0) before running start,
  ios, android, or a dependency install in that worktree. If a shell tool
  yields a running session or job ID, poll or wait for completion; empty
  stdout or a returned job ID does not mean the copy has finished. Concurrent
  writes to the destination are unsafe: existing entries are checked before
  copying, not during it. Do not edit files, run another warm, or start any
  other writer in that worktree until warm finishes. Concurrent files can be
  overwritten or removed.

  Warm copies installed dependencies, Pods, native output, and other ignored
  paths eligible under the source checkout's Git ignore rules, including .env
  and local configuration. The source's nonempty
  .worktreeexclude replaces its resolved worktree.exclude setting. Nested
  registered worktrees, .DS_Store, .DerivedData, .idea, and
  android/build/generated/autolinking caches are excluded, including inside
  newly copied directories. Gradle regenerates autolinking
  for the destination checkout on its next build. Warm also skips paths
  overlapping a nested destination worktree or below a symlink ancestor.
  Tracked .idea settings come from Git and stay untouched by warm.

  Other generated state stays eligible: .gradle, .cxx, *.tsbuildinfo, build
  directories, and embedded JavaScript need project-specific decisions about
  regeneration. Native intermediates can record the source checkout's paths;
  warm does not relocate them. Excluding the whole .expo directory can drop
  generated TypeScript inputs.

  To choose exclusions, run this in the source checkout's repository root:

    git ls-files --others --ignored --exclude-standard --directory --no-empty-directory

  Patterns match those entries with the trailing / removed. They do not prune
  children of a whole ignored directory: if Git lists android/app/src/main/assets/,
  excluding its bundle.jsbundle child has no effect. Exclude the assets entry
  only when the project regenerates everything inside it.

  Warm copies directly into the destination, without intermediate staging.
  Keep the source checkout and the linked worktree on the same volume to
  retain copy-on-write cloning where supported. Cross-volume copies require
  full file data; doctor reports that cost. STIM_TMPDIR and machine tempDir do
  not affect warming.

  Existing entries, including dangling symlinks, stay untouched. An existing
  ignored directory such as node_modules is skipped WHOLE; missing children are not
  filled in. Warm does not copy tracked changes, switch branches, or build,
  and it installs dependencies only under \`--refresh\`, in the source checkout. stdout stays empty; stderr reports copied, kept,
  and failed entry counts. A copy failure exits 1 and reports incomplete;
  files copied before a failure remain. Inspect the named failed entry
  before retrying: a partially copied directory will be kept on the retry.
  A completed copy is not proof that dependencies match this branch. Follow
  any lockfile remedies before building, and install missing dependencies
  with the project's package manager when the source has none to copy.

  \`android --variant <name>\` selects the gradle variant to assemble and
  install on a project with product flavors -- \`--variant productionDebug\`
  runs \`assembleProductionDebug\`, finds the APK in apk/production/debug/ and
  keys the build cache on the variant. It overrides the android.variant
  setting (see \`guide settings\`), which is the app-level default; unset,
  the plain \`assembleDebug\` flow is unchanged. The --json payload's
  \`variant\` field reports what was built (null for the default).
  When neither is set and android/app/build.gradle declares more than one
  product flavor, \`android\` refuses BEFORE gradle runs and names the debug
  variants to choose from, because \`assembleDebug\` would build every flavor
  and leave nothing to pick from. That parse is best-effort: flavors built
  from a variable, a loop, or an applied script are not detected, and such a
  project builds as before.

  \`ios --device-type <name>\` and \`ios --runtime <version>\` choose the
  MODEL and the iOS version of the simulator this workspace owns --
  \`--device-type "iPad Pro 13-inch (M4)" --runtime 18.5\` is how a ticket that
  says "happens on iPad on iOS 18.5" gets reproduced without writing a
  \`.stim.json\`. \`android --system-image <id>\` is the Android half, taking
  the sdkmanager package id
  ("system-images;android-36;google_apis;arm64-v8a"). Each overrides its
  setting (ios.deviceType, ios.runtime, android.systemImage) for that one
  invocation, exactly as \`--configuration\` overrides ios.configuration.

  A name that is not INSTALLED on this machine refuses with STIM_BAD_ARG
  before anything is created, and the message lists the installed names, so a
  wrong guess is one command, not a created simulator. A blank value is the
  same refusal.

  What counts as installed for \`--device-type\` is what an installed RUNTIME
  can create, not what \`xcrun simctl list devicetypes\` prints: that table
  also names watchOS, tvOS and visionOS models, and older iPhones no current
  runtime supports, none of which \`simctl create\` would accept. So the
  refusal lists the models the installed runtimes offer -- narrowed to the one
  runtime when \`--runtime\` also resolved, which is what catches a pair like
  \`--device-type "iPhone 8" --runtime 26.5\` that each half would pass alone.
  \`--runtime\` takes a version (\`26.5\`) or a runtime's full name
  (\`iOS 26.5\`), exactly; no prefix or suffix matches.

  These flags describe a device that does not exist yet. When this workspace
  ALREADY owns a simulator and \`--device-type\` names a different model,
  Stim refuses rather than silently booting the wrong one: reap the current
  sim with \`stim worktree remove\` (or \`stim gc --delete\`), then run
  \`stim ios\` again to create the requested one. \`--runtime\` and
  \`--system-image\` apply at creation only, so an existing device keeps the
  version it was made with. The --json payload reports what was actually
  used: \`deviceType\` and \`runtime\` on iOS, \`systemImage\` on Android,
  read from the device itself, so a settings-driven run reports them too.`,
    },
    devices: {
      summary:
        'ios --device and android --device on a phone: what the run skips, signing, the LAN wiring, the collector',
      body: () => `  \`android --device [serial]\` installs and launches on a physical device
  connected to this machine instead of this workspace's owned emulator. With
  no serial it takes the first device it can lease (\`guide lifecycle lease\`).
  It cannot be combined with --remote.

  A \`--device\` run LEASES the device from just after the build until it
  exits, so a second workspace cannot install over it mid-run
  (\`guide lifecycle lease\`).

  The build, the fingerprint, the build cache and the Metro port gate are
  unchanged. What is skipped is everything that manages an owned device:
  no capacity check, no AVD creation, no boot wait, and no owned-device
  registry entry. The app is pointed at
  localhost:<port>, which the adb reverse serves, instead of the emulator's
  10.0.2.2. Stim never creates, boots, shuts down, or deletes hardware.

  \`ios --device [udid]\` selects a connected iPhone, the same way
  \`android --device\` selects a connected phone: with no UDID it takes the
  first device it can lease (\`guide lifecycle lease\`), and an iPhone
  that is unpaired or has Developer Mode off is refused with the fix. It
  cannot be combined with --remote, and it never creates, boots, or deletes
  hardware -- there is no capacity check, no simulator creation, no boot wait,
  and no owned-device registry entry. Like
  \`android --device\`, it leases the phone for the run
  (\`guide lifecycle lease\`).

  \`stop\` releases this workspace's leases and stops its log collectors.
  On a physical iPhone that also closes the app, because its collector owns
  the devicectl launch session. \`gc --delete\` removes expired lease files;
  neither command shuts down the phone or uninstalls the app.

  A device build is LOCAL-TIER ONLY. Its cache key is
  \`<fingerprint>-<configuration>-device\`, so a device app can never collide
  with the simulator one, and neither the build-cache provider nor the Expo
  remote cache is read or written on a \`--device\` run: every entry they hold
  is keyed for the simulator, so consulting them would either install a
  simulator slice on a phone or publish an iphoneos app under a key simulator
  builds resolve.

  THE BUILD is the \`iphoneos\` slice for the selected phone -- \`-sdk
  iphoneos\`, the project's own signing settings, no signing flags on the argv.
  It is installed with \`devicectl device install app\` and launched with
  \`devicectl device process launch\`. Every device install is SIGNED, Debug
  included, so the signing gate runs before it: the app's own
  embedded.mobileprovision must be unexpired and must name this phone, and when
  Stim modifies the bundle the identity that profile names must be in this
  machine's keychain (see \`guide errors STIM_NO_PROFILE\`). A gate refusal on
  a CACHED app falls back to a full build; on a freshly built one it exits on
  its own code, because building again would produce the same app.

  DEBUG REACHES METRO OVER THE LAN, because a phone shares no loopback with
  the host and USB carries no reverse forward. Stim picks a non-internal IPv4
  address (en0 first, RN's own order from react-native-xcode.sh), gates it as
  this workspace's Metro, and then wires the app to it: an expo-dev-client app
  through the deep link, passed to devicectl as \`--payload-url\` and followed
  by \`-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0\`,
  which is how a phone gets what a simulator gets from a defaults write, and a
  bare app by writing \`<addr>:<port>\` into the app bundle's ip.txt --
  RCTBundleURLProvider's own mechanism, which honours a colon-bearing value
  verbatim and never consults the compiled RCT_METRO_PORT. Stim never sets
  that define: it would put the reserved port into a compiled input and fork
  the device cache per workspace.
  ip.txt is a sealed resource, so Stim writes it on a COPY of the artifact and
  re-seals that copy with \`codesign\`. THE ORDER IS STORE, THEN COPY, THEN
  MUTATE: the cache entry stays the pristine, shareable artifact, and the
  per-run address lives only in the copy that is installed and then deleted.

  A RELEASE device run builds fresh every time for now. A cached Release app
  carries its BUILDER's JS, and the device JS swap (which has to re-seal what
  it injects) lands with phase 6 of appandflow/stim#178, so the cache hit is
  refused rather than installed with someone else's JavaScript.

  THE DEVICE LOG COLLECTOR IS THE LAUNCH. \`devicectl\` connects an app's
  streams only when it is the process that starts the app, so the collector
  runs \`devicectl device process launch --console --terminate-existing\`
  itself rather than attaching after the fact the way the simulator collector
  does. The run then reads the app's pid from the phone's own process list
  (\`devicectl device info processes\`), because \`--console\` blocks until
  the app exits and its \`--json-output\` is written only then. That device pid
  is also what proves a RELEASE launch: a device pid means nothing to the host,
  so nothing on the host is ever signalled with it. Otherwise the collector is
  the same process as every other collector -- one per platform per workspace,
  titled with its --root, killed and replaced on the next \`ios\` run whose pid
  still proves it is this workspace's, and reaped by \`stop\`. One difference in
  the ordering: a device run stops the PREVIOUS collector before it installs,
  not while starting its own, because an upgrade install terminates the running
  app -- which would end that collector's devicectl non-zero and record a
  failure for a normal reinstall. Unplugging the phone ends devicectl, which
  ends the collector: it removes its own registration and exits. A separately
  held \`device lock\` lease survives collector exit until released or expired;
  \`gc --delete\` can remove its expired lease file. Whether it closes with collector_stopped or
  collector_failed follows devicectl's exit code, which no one has watched a
  cable-pull produce yet. See \`guide logs\` for what the device stream can
  and cannot carry, and appandflow/stim#179.

  THE APP RUNS FOR AS LONG AS THE COLLECTOR DOES. Because the collector is the
  launch, the app is attached to it: \`stop\` (and any other end of that
  collector -- a crash, the host sleeping, the cable coming out) closes the app
  on the phone. It stays INSTALLED. Collector exit removes the collector's
  registration, not a separately held device lease; \`stop\` also releases
  this workspace's leases. See \`guide cleanup collector\`.

  THERE IS NO INSTALL SKIP ON A PHONE. The simulator path skips the install
  when the device already holds the same bundle byte for byte, which it proves
  by hashing the installed container; there is no cheap equivalent through
  devicectl, so a device run always installs. It is an upgrade install: the
  app's data, and the Local Network permission the phone granted it, survive.`,
    },
    lease: {
      summary: 'run-scoped leases, --wait and --no-wait, device lock and unlock, which phone an id-less --device picks',
      body: () => `THE DEVICE LEASE ON A \`--device\` RUN
  A physical device is shared, so a \`--device\` run takes a lease on it. The
  lease step sits AFTER the build (a build touches no device) and before the
  install, and the run releases what it took when the command exits: on
  success, on a failure, on an exception, and on a Ctrl-C or a SIGTERM, which
  it catches to give the device back before exiting 130/143. Only SIGKILL
  escapes that, and then the lease expires on its own. Before each device step
  -- install, launch, the log collector, verification -- the run raises the
  expiry to now plus the larger of 60 seconds and that step's own upper bound,
  because a child process is synchronous and no timer can tick during an
  install. A run killed with SIGKILL therefore leaves the device leased for at
  most the current step's bound, never less than 60 seconds.

  If nobody holds the device, the run takes a lease of its own and gives it
  back at exit. If another workspace holds it, the run WAITS: \`--wait
  <seconds>\` (default 60) polls every 2 seconds, prints a waiting line to
  stderr at once and then every 30 seconds with the holder, the device and the
  holder's expiry, and refuses with STIM_DEVICE_BUSY when it runs out. It
  keeps waiting past the holder's own expiry, because the holder can release
  early. \`--wait 0\` refuses at once. \`--no-wait\` changes only that case: the
  run proceeds with NO lease and prints one warning naming the holder and its
  expiry, plus what the install costs: the same app id means it TERMINATES the
  holder's running app, a different one means the launch only backgrounds it,
  and when Stim cannot read the holder's app id it says so rather than
  guessing. A free device is leased as usual under \`--no-wait\`. The two flags
  together are STIM_BAD_ARG, and so is either one without \`--device\`, because
  an owned simulator or emulator has no contention.

  A successful \`--device\` run reports \`lease: { kind, expiresAt }\` in its
  \`--json\`; a run that proceeded without one, or lost one after the install,
  reports \`lease: null\`. \`stim status\` lists every lease file on the
  machine, and \`stop\` releases the ones this workspace holds.

HOLDING A DEVICE ACROSS RUNS
  A run-scoped lease dies with the command, which is not enough for a
  device-tool session: the next workspace's \`ios --device\` would install over
  the app you are driving. \`stim device lock\` grants a DECLARED lease that
  outlives the run:

    stim device lock ios --for 10m     # or: android; add a UDID/serial to name one
    stim ios --device                  # builds, installs, launches; raises the lease
    ... device-tool work on the phone ...
    stim device unlock                 # give it back; or let it expire

  \`--for\` takes a whole number of seconds or minutes, 10s to 30m, and
  defaults to 5m; anything else is STIM_BAD_ARG. \`--wait <seconds>\`
  (default 60, \`0\` refuses at once) is the same wait a run does. Both
  commands need a project and refuse outside one with STIM_NO_PROJECT, and
  \`lock\` runs the same resolver \`--device\` does, so an unpaired phone or
  one with Developer Mode off is refused with that resolver's own remedy
  before any lease is written.

  Locking a device this workspace already holds SETS the expiry to now plus
  \`--for\`, which can shorten it. Locking a different device of the same
  platform releases the first one: a workspace holds at most one lease per
  platform. Nothing else moves an expiry -- not the app running afterwards, not
  device-tool work, not \`status\`. Only \`lock\` and a run's own steps do.

  \`stim device unlock\` releases every lease this workspace holds, or only
  the platform named. Releasing nothing is not an error: it says so on stderr,
  and \`--json\` prints an empty list. It releases by holder, so it still
  works when the workspace directory was recreated and the token is gone.

  With no id, \`lock\` and a \`--device\` run pick from the POOL of connected
  devices, so two phones on one machine no longer refuse.

THE POOL: WHICH DEVICE AN ID-LESS \`--device\` PICKS
  Candidates are the connected devices the resolver already accepts: on iOS,
  wired, paired, with Developer Mode on; on Android, every serial adb reports
  in the \`device\` state that is not an emulator, TCP serials included. Then,
  in order:

    1. the device this workspace already leases, when it is among them;
    2. otherwise the first one not leased -- or leased and EXPIRED -- in
       case-folded id order.

  Ids are sorted on, never names: adb has no name without one \`getprop\` per
  serial, and models repeat.

  A device this workspace leases that is NOT connected refuses with
  STIM_NO_DEVICE naming it, rather than quietly moving to another phone. Naming
  a different one with \`--device <id>\` refuses the same way, because a
  workspace holds at most one lease per platform: \`stim device unlock\` first.

  Candidates with none free is the wait: under \`--wait <seconds>\` the poll
  re-LISTS devices, so a phone plugged in mid-wait is picked up as well as one
  released mid-wait. When the wait runs out, STIM_DEVICE_BUSY names every
  holder and its expiry. No candidate at all is the existing STIM_NO_DEVICE,
  with the resolver's own message. \`--no-wait\` takes the first candidate
  anyway and proceeds with no lease, as it does for one named device.

  The chosen device is on the phase line and in \`--json\` (\`udid\` or
  \`serial\`, plus \`deviceName\`), so an agent can hand the same id to its
  device tool.`,
    },
    release: {
      summary: 'Release configurations and ...Release variants: Metro skipped, process-proven launch, the JS swap',
      body: () => `  A VARIANT WHOSE NAME ENDS IN "Release" IS A RELEASE BUILD (\`release\`,
  \`productionRelease\`), and that is the whole opt-in -- there is no second
  flag. It is the Android half of \`ios --configuration Release\` and behaves
  the same way: AGP's bundle task embeds the JS, so Metro is skipped ENTIRELY
  (no gate, no \`adb reverse\`, no debug_http_host, no dev-client deep link --
  a plain \`am start\` of the launcher activity), the payload says
  \`metroPort: null\`, and \`launched\` is proven by the app PROCESS being
  alive on the device rather than by a bundle fetch. Device logs are still
  collected, so \`logs --errors\` answers "does it repro in release/Hermes
  bytecode".

  On a release CACHE HIT the cached APK carries its BUILDER's baked-in JS, so
  it is never installed as-is. Stim copies it aside, regenerates this
  workspace's bundle with the project's own tools (\`expo export:embed\` /
  \`react-native bundle\`, then the project's own hermesc when
  \`hermesEnabled\` is not false in android/gradle.properties), re-packs it
  into the copy with plain zip surgery (stored, not deflated -- the runtime
  mmaps it), then zipaligns and re-signs with apksigner. The keystore defaults
  to android/app/debug.keystore with the standard password; android.keystore /
  android.keystorePassword override it (see \`guide settings\`). The cache
  entry itself is never modified.

  Before re-packing, THE ASSET GATE compares CONTENT HASHES of the assets
  React Native emits: what this workspace just emitted under --assets-dest
  against a manifest of what the cached build emitted, recorded as
  assets-manifest.json inside the cache entry at build time. Same producer on
  both sides, so the comparison is exact -- an added, a removed OR A REPLACED
  asset (a different image under an unchanged filename) all mean NO SWAP, and
  the run falls back to a full gradle build with a note naming an example. An
  Android drawable is not just a file in the zip -- it has a row in
  resources.arsc only AAPT can write -- so an APK cannot be made to carry an
  asset it was not built with, and Stim will not install one whose JS
  references an asset it lacks. The APK's own res/ table is never read: a
  release build shortens every resource path (AGP's
  optimizeReleaseResources), so those entries are \`res/-B.png\`, not the names
  anything emitted.

  AN ENTRY WITH NO MANIFEST NEVER SWAPS. One stored before asset tracking, or
  downloaded from an Expo build-cache provider, has nothing to compare
  against, so the run says so and builds fresh -- and that build REPLACES the
  entry, manifest included, so the next run on the same fingerprint swaps
  normally. The same replacement happens after any gate refusal or swap
  failure, which is what stops a bad entry from refusing every run forever.

  Local re-signing also
  means an APK signed by CI cannot be updated over: on
  INSTALL_FAILED_UPDATE_INCOMPATIBLE (or a version downgrade) a release run
  uninstalls the package once and retries, printing a note -- the app's data
  goes with it, which is why only release runs do this.

  Local installs only, onto an owned emulator or, with
  \`android --device\`, a connected physical device. Store signing and
  distribution stay out of scope.

  \`ios --configuration <name>\` selects the Xcode configuration --
  \`--configuration Release\` builds a SIMULATOR Release app with the JS
  bundle embedded. It overrides the ios.configuration setting (the app-level
  default); unset, the Debug flow is unchanged. A non-Debug configuration
  skips Metro ENTIRELY: no gate, no port wiring, no dev-client deep link (a
  plain \`simctl launch\`), and the payload says \`metroPort: null\` --
  \`launched\` is verified by the app PROCESS staying alive, not by a bundle
  fetch. The build cache keys on the configuration
  (\`<fingerprint>-release-sim\`), and because a cached Release .app carries
  its builder's baked-in JS, a cache hit regenerates THIS workspace's bundle
  (the project's own \`expo export:embed\` / \`react-native bundle\`, plus
  its own hermesc when Hermes is enabled) into a copy of the artifact,
  re-signs it and installs that; any swap failure falls back to a full build
  rather than ever installing stale JS. Device logs are still collected, so
  \`logs --errors\` answers "does it repro in release/Hermes bytecode".
  A run with no \`--device\` installs on the simulator only. \`ios --device\`
  builds the \`iphoneos\` slice for a cabled iPhone and keys its cache
  \`-device\` instead of \`-sim\`, but does not install it yet. Archives,
  \`.ipa\` export, store signing and distribution stay out of scope.`,
    },
    simslim: {
      summary: 'recommended SimSlim profiles and recovery from host memory pressure',
      body: () => `SIMSLIM FOR PARALLEL IOS WORK
  SimSlim is recommended as an optional way to reduce simulator background
  services and memory use, especially with several workspaces. Review which
  services your app and tests need; a slim profile can disable those features.
  It does not guarantee that a memory stall or crash will be fixed.

  Install SimSlim once on each Mac:

    brew install mobai-app/tap/simslim

  Review the categories and create a profile in an interactive terminal:

    simslim profiles
    mkdir -p .simslim
    simslim profile .simslim/dev.json

  Selected categories in the wizard stay enabled. The wizard writes the
  profile without applying it. Review and commit it, then select it in .stim.json:

    { "ios": { "simslimProfile": ".simslim/dev.json" } }

  SimSlim 0.8 requires iOS 18.5 or newer. On each local \`stim ios\`,
  Stim reconciles that profile on the owned simulator before the app build.
  The first change can update services and reboot the simulator. A matching
  profile is a fast no-op on later launches. The settings persist across normal
  shutdowns and reboots. Removing the setting restores stock services when
  Stim applied the profile. Stim never changes an unowned or remote simulator.
  Each SimSlim operation has a 12-minute outer deadline, including discovery.
  This cap also applies when SimSlim's own timeout is increased. On timeout,
  Ctrl-C, or SIGTERM, Stim attempts to stop only its verified process group, then waits up to
  10 seconds to confirm termination before returning or exiting.
  An unconfirmed process group keeps its claim and blocks another reconciliation;
  inspect the named processes before removing the exact claim in the error.
  The simulator's managed settings record is retained, so retrying reconciles an
  interrupted apply or restore. Stim does not assume partial changes rolled back.
  Doctor recommends this setup but never installs SimSlim or applies a profile.
  Profile schema and service tradeoffs: https://github.com/MobAI-App/simslim

HOST MEMORY PRESSURE AND STALLED SIMULATORS
  Booted and a working screenshot do not prove that simulator processes can
  start. Stim checks a bounded process spawn before install and bounds local
  simulator launch operations. Simulator discovery waits up to 30 seconds,
  boot (including the initial boot request) up to 10 minutes, and app installation
  up to 5 minutes. Process termination confirmation can take another 10 seconds;
  a final boot-state query can take 30 seconds. Opening the Simulator app after
  boot is best-effort and takes at most 5 seconds. A timeout is not proof of an
  app crash or OOM.
  Doctor and failure diagnostics report macOS memory pressure when available;
  a failed query remains unknown. Existing swap or low free RAM alone is not
  enough to diagnose pressure.

  If pressure is elevated, free host memory before retrying. Use \`stim stop\`
  only in workspaces you own and have finished using; ask before closing other
  agents' simulators or heavy apps. Rebooting a simulator under the same pressure
  can repeat the stall. Consider fewer concurrent builds/devices (guide lifecycle
  concurrency) and a reviewed SimSlim profile for future runs.`,
    },
  },
};

export default lifecycle;
