import type { GuideTopic } from './types.ts';

const PROVISION_CONTEXT = `\`stim device provision ios [udid]\` is the one Stim command that changes an Apple
Developer account: it registers the phone with the project's team and creates
or refreshes the iOS App Development profile (and, when the keychain holds
none, an Apple Development certificate) by running xcodebuild with
-allowProvisioningUpdates -allowProvisioningDeviceRegistration. No build, and
no \`ios --device\` run, ever does this. Agents run it only when the user
explicitly asks for this step.`;

const errors: GuideTopic = {
  summary: 'Every refusal Stim can print: an index of codes, and one section for each',
  sectionHint: '<CODE>',
  preamble: () => `WHAT STIM REFUSES, AND WHY

Every refusal listed here carries a stable CODE, whichever command prints it.
Branch on the code, never on the message.`,
  sections: {
    STIM_HOSTING_REFUSED: {
      summary: 'a hosting Mac refused or could not confirm its native session; no fallback after reservation',
      body: () => `STIM_HOSTING_REFUSED
  The message names the hosting Mac and its reason: unreachable, a Stim home
  it cannot read (retry once the disk that holds it answers), a changed
  server key, a stim-server too old to speak protocol 2 (stim doctor names
  the update command), no installed simulator or emulator choice, no capacity, elevated or unknown
  memory pressure, or an unresolved reservation or delivery. Stim boots nothing
  locally and never tries another machine after choosing a named host or creating a
  hosted session. Auto skips declined offers before building, then uses the
  local queue if none admits. A reserve refusal after an accepted offer fails
  with this code and asks to retry; it does not re-place the built architecture.
  remote-only never runs here and never joins the local queue: it refuses
  with this code when no host could ever take the run, and waits for a host that
  is only full or loaded (see STIM_AT_CAPACITY).
  An unreachable host's message and remedy are the diagnosis stim doctor gives
  (Tailscale off, Mac offline with last seen, serve route, stim-server), without
  tailscale ping. Check stim-server and Tailscale there,
  then run stim doctor. Correct --device-type / --runtime for iOS or
  --system-image / --device-profile for Android when the offer names
  an unavailable choice. A host that would install a missing Android image
  but cannot (android.installImages never there, unaccepted licenses, no
  cmdline-tools, low disk) declines with the command to run on that host. A session that exists stays recorded even if delivery
  fails: retry stim ios|android --remote <machine>, or run stim stop to reconcile it.
  An Expo dev client whose running or pinned Metro port is in use on the host
  refuses before the build: run stim stop, then stim ios --remote <machine>
  without stim start, so Stim starts Metro on a port free on both Macs, or pin
  one free on both Macs with metro.port or STIM_METRO_PORT.
  An unreachable stop keeps the placement; rerun stim stop when the host answers.
  To see why a host was slow or refused: stim logs --source placement (hosts checked and
  reason codes), stim logs --source build (remote_connect_failed, remote_request_failed),
  and the host's stim service log, searched for the run id (stim guide logs).
  A failed build handoff uses upload instead. A host on an older Stim is refused
  with peer-too-old, naming stim remote update <mac>, or the
  npm i -g stim@<version> && stim service install to run on it.
  A name outside remote.machines is STIM_BAD_ARG. Missing or pending hosting
  approval keeps the stim remote add and stim setup remedies.`,
    },
    STIM_EAS_BUILD_MISSING: {
      summary: 'no completed EAS development build matches; build only with session authorization',
      separator: '--- EAS BUILD CODES (`ios --eas-profile` / `android --eas-profile`) ---',
      body: () => `STIM_EAS_BUILD_MISSING
  No compatible build matches the selected EAS project, profile, platform and
  native fingerprint. No device was acquired and no local or cloud build was
  started. The remedy prints the exact npx eas-cli build command. Check session
  authorization for its potential cost before running it, then retry Stim.
  See stim guide lifecycle eas.`,
    },
    STIM_EAS_UNAVAILABLE: {
      summary: 'EAS lookup/download failed, or another run holds the artifact claim',
      body: () => `STIM_EAS_UNAVAILABLE
  EAS CLI is unavailable or older than 18.9.0, a profile/fingerprint/list/download
  operation failed, the response could not be validated, or another run holds
  the artifact claim.
  Follow the printed remedy: inspect the named EAS command or retry once the
  holder finishes. This is not proof that a build is missing. No native build
  is started. See stim guide lifecycle eas.`,
    },
    STIM_WORKSPACE_STATE: {
      summary: '$STIM_HOME/workspaces could not be prepared, or the digest directory belongs to another project',
      aliases: ['STIM_WORKSPACE_COLLISION'],
      separator: '--- BUILD-PATH CODES (`stim ios` / `stim android`) ---',
      body: () => `STIM_WORKSPACE_STATE / STIM_WORKSPACE_COLLISION
  Stim could not prepare this project's global workspace directory under
  $STIM_HOME/workspaces. Check that STIM_HOME is writable and has free
  space. An EPERM on a directory the user CAN write is a sandbox, not a
  permission bit -- see \`stim guide errors sandbox\`. COLLISION means the
  readable-name-plus-digest directory already has a workspace.json for a
  different canonical project path; do not overwrite it until you identify
  which workspace owns it.`,
    },
    STIM_NO_METRO: {
      summary: "the recorded launch's port is not this workspace's live dev server (reload), or nothing to revive",
      body: () => `STIM_NO_METRO
  Reload requires the recorded launch's port to be this workspace's live
  Metro. It refuses a missing, changed, unresponsive, or foreign port. Run
  \`stim start\`, or run \`ios\` or \`android\` again.

  \`revive\` resumes only an idle stop. It refuses when this workspace's Metro
  is not running and was never started, was last stopped for another reason
  (a signal, a crash), or the workspace was stopped after the idle stop
  (\`stim stop\` or automatic maintenance released its port): there is
  nothing paused to resume, and revive never starts a Metro the workspace did
  not have. Nothing was started. Run \`stim start\`, then \`stim ios\` or
  \`stim android\`.

  \`ios\` and \`android\` do not emit this code. A Debug run with no healthy
  dev server on the reserved port starts one, as \`stim start\` would, and
  refuses only when that start fails, with the start's code
  (STIM_METRO_TIMEOUT, STIM_SUPERVISOR_EXITED, ...). A port held by SOMETHING
  ELSE, usually a bundler started from the wrong directory or another repo's
  Metro, gets a fresh reservation.`,
    },
    STIM_NO_FINGERPRINT: {
      summary: 'Stim could not determine a native fingerprint',
      body: () => `STIM_NO_FINGERPRINT
  Stim could not determine the native inputs for a build-cache key. Follow the
  printed evaluator or project-input remedy. A build can run locally without a
  reusable cache key when its inputs cannot be determined safely.`,
    },
    STIM_PREBUILD_FAILED: {
      summary: 'expo prebuild could not generate or regenerate the native directory',
      body: () => `STIM_PREBUILD_FAILED
  \`expo prebuild\` could not generate the missing native directory, or
  update a stale one in place. The extracted output is above the code; the
  transcript is in the global workspace logs/build-<platform>.ndjson file.
  Stim updates an existing gitignored directory in place, so what an
  earlier config wrote stays there; when the output points at leftovers of a
  removed config plugin or an Expo SDK upgrade, delete the directory
  (\`rm -rf ios\` or \`rm -rf android\`) and run again so Stim generates it
  fresh. The same code refuses a native directory that the fingerprint leaves
  out of the cache key while git tracks its files, or when git cannot answer:
  Stim cannot show those files came from the current app config, and will
  not run \`expo prebuild\` over tracked files. Stop excluding the
  directory from the fingerprint (.fingerprintignore), or gitignore and
  untrack it so Stim regenerates it. When git itself is failing, fix the
  checkout first. In the source checkout, \`stim doctor --fix\` in a terminal runs
  the same prebuild, and the pod install after it on iOS, without compiling, and
  records the fingerprint \`worktree warm\` needs to carry the directory.`,
    },
    STIM_DEPS_FAILED: {
      summary: 'pod install or gradle sync failed; the bundler ladder and BUNDLE_FROZEN',
      body: () => `STIM_DEPS_FAILED
  \`pod install\` (iOS) or the gradle dependency sync (Android) failed. On iOS
  this runs only when Podfile.lock and Pods/Manifest.lock disagree, or Pods is
  absent -- which is exactly what a carried worktree produces.
  WHICH POD COMMAND: Stim takes the nearest Gemfile from the directory pod
  install runs in (ios/) up to the project root, as Bundler finds it. When its
  Gemfile.lock resolves cocoapods, pods go through bundler -- \`bundle check --dry-run\`,
  then \`bundle install\` only when that reports missing gems, then \`bundle exec
  pod install\` -- so the CocoaPods the lockfile pins is the one that writes
  Podfile.lock. Everything else gets plain \`pod install\`: no Gemfile, a Gemfile
  with no Gemfile.lock (\`bundle install\` would CREATE that tracked file in
  your checkout, which Stim will not do), and a Gemfile.lock that
  pins something other than pods, such as a fastlane-only bundle. When
  \`bundle\` is not on PATH the run prints one dim \`pods\` note and uses plain
  \`pod install\`. The \`pods\` phase line always names the command that ran, and
  the gem steps heartbeat under the \`gems\` label.
  Bundler runs with BUNDLE_FROZEN, so a Gemfile that no longer matches its
  Gemfile.lock FAILS the build rather than quietly falling back to unpinned
  pods -- silently using a different CocoaPods than the lockfile pins is the
  bug this path exists to kill. Run \`bundle install\` yourself and keep the
  result. Gems themselves are installed wherever BUNDLE_PATH points -- the
  project's own \`.bundle/config\` (vendor/bundle in the React Native template),
  or the environment. When that lands inside the project, Stim says so in a dim
  note naming which of the two set it; Gemfile.lock is never edited either way.
  \`worktree warm --refresh\` reports the same code for the install it runs in
  the SOURCE CHECKOUT -- the lockfile's own command (\`pnpm install\`,
  \`yarn install\`, \`bun install\`, \`npm ci\`), the \`npm run postinstall\`
  it runs when npm's config there sets ignore-scripts, or that same pod ladder. The
  message names the command, quotes its last lines, and nothing is copied: fix
  the source checkout, then warm again.
  A "could not find compatible versions for pod" failure means a gitignored
  Podfile.lock pins a version of the named pods that the Podfile no longer allows.
  In the source checkout, \`stim doctor --fix\` in a terminal runs \`pod install
  --clean-install\` and, on that conflict, \`pod update <names>\` of only the named
  pods, then retries once; it refuses when git tracks ios/, so a tracked
  Podfile.lock is never edited. Elsewhere run \`pod update <names>\` in ios/ yourself.
  start, ios and android also refuse with this code when \`gc --delete\`
  lightened the worktree and the \`stim worktree warm\` they ran to restore
  its node_modules and ios/Pods failed. The warm's own lines say why; fix
  that, then run \`stim worktree warm\` or retry the command.`,
    },
    STIM_BUILD_FAILED: {
      summary: 'xcodebuild or gradle failed; the Android missing-SDK and APK refusals',
      body: () => `STIM_BUILD_FAILED
  xcodebuild or gradle failed. The EXTRACTED diagnostics are printed (capped),
  not the transcript. Read the log path on the next line for the rest: it names
  a copy of the failed transcript (<log>.failed) that the next build in the
  workspace does not overwrite. When xcodebuild names failed script phases,
  the first diagnostics are the phase names and the last error lines the
  script printed, ahead of the compiler diagnostics.
  Three Android refusals share this code without gradle itself failing:
  - NO ANDROID SDK, before gradle starts: local React Native emulator runs
    refuse before Metro or device setup. Nothing exists at the SDK path
    Stim resolves (ANDROID_HOME, else ANDROID_SDK_ROOT, else the default
    location), and there is no android/local.properties. Set ANDROID_HOME to the SDK or write sdk.dir
    into android/local.properties; \`stim doctor --platform android\` reports
    the same condition. When the SDK is found and neither variable is set,
    Stim passes its path to gradle as ANDROID_HOME.
  - MORE THAN ONE debug APK under android/app/build/outputs/apk and nothing
    configured to pick one (a project with product flavors, several flavors
    already built). Stim will not guess which flavor to install: the
    refusal lists the candidates -- pass \`--variant <name>\` or set the
    android.variant setting (e.g. "productionDebug") to the one you want.
    Flavors declared plainly in android/app/build.gradle are caught before
    the build instead (STIM_BAD_ARG); this one remains for the declarations
    that parse cannot read.
  - NO APK for the configured variant: the android.variant / --variant value
    does not name a real variant (\`./gradlew :app:tasks\` in android/ lists
    the assemble tasks).
  AN APK OLDER THAN THE BUILD IS NOT A REFUSAL. \`assembleDebug\` packages every
  flavor, so a later \`--variant previewDebug\` finds a current APK that gradle
  reports UP-TO-DATE and repackages nothing. Stim installs it. Gradle owns task
  freshness and the fingerprint owns cache freshness; Stim does not second-guess
  either from the file's mtime.
  A damaged compilation-cache object stays STIM_BUILD_FAILED when Stim did
  not give the build its shared cache; STIM_COMPILATION_CACHE_CORRUPT lists
  the messages and the gc remedy.`,
    },
    STIM_COMPILATION_CACHE_CORRUPT: {
      summary: 'an iOS build failed on a damaged shared compilation cache; Stim emptied it, rerun the command',
      body: () => `STIM_COMPILATION_CACHE_CORRUPT  (ios)
  The build used the shared compilation cache ($STIM_HOME/compilation-cache)
  and the compiler reported a damaged object in it. A cache write that a full
  disk or a killed build cut short leaves such an object, and every later build
  that reaches it fails the same way. Stim matches only the compiler's own
  corruption errors in the transcript:
    LLVM ERROR: OnDiskCAS: corrupt internal reference
    error: CAS operation failed: ...
    error: CAS-based dependency scan failed: not a IncludeTreeRoot node kind
  Xcode reports them per source file, so the failing targets are whichever
  reach the object first -- often pods you did not touch -- and they change
  between runs.
  Stim empties the whole cache at once, the way
  \`gc --delete --cache "compilation cache"\` does, and fails the build. It
  does not retry. RUN THE SAME COMMAND AGAIN: that build starts with an empty
  cache, so it is a cold one. The emptying is recorded in the maintenance log.
  Every iOS build that compiles with the cache holds a shared claim on it,
  <cache>.claims beside the cache directory, while xcodebuild runs. Stim
  empties the cache only under that set's exclusive claim, here, in gc and in
  maintenance. When another build holds it or its claim is unresolved, Stim
  leaves the cache alone, because that build may be using it, and the message
  says so. Once nothing else is building, run
  \`gc --delete --cache "compilation cache"\`, then run the command again.
  A build on a build worker gets the same handling on the worker, which
  empties its own cache for that client. With --remote-build <machine> the
  build fails with this code and the worker's message; otherwise it falls
  back to building here, and the fallback line names this code. Xcode builds
  run outside Stim take no claim, so a cache they share is not guarded.`,
    },
    STIM_PATH_TOO_LONG: {
      summary: 'Windows only: the project root leaves no room for the NDK object paths ninja must open',
      body: () => `STIM_PATH_TOO_LONG  (android, Windows only)
  The NDK's ninja is not long-path aware, so every CMake object path has to
  stay under Windows' MAX_PATH. React Native's codegen objects are named
  after their mangled absolute source path, so each carries the project root
  twice unless CMake shortens it, and CMake only shortens a name that then
  fits the object path limit Stim's Gradle shim sets. The message names the
  longest known object for the ABI being built and the longest root it
  leaves room for. A project with react-native-gesture-handler 3, whose
  shared shadow nodes have the longest known object path, fits a root of at
  most 24 characters for an x86_64 Debug build and 21 for arm64-v8a; other
  projects fit 51 and 48. \`stim android\` on
  an emulator, local or --remote <backend>, refuses before it starts Metro
  or prepares the emulator, even when a cached build would have installed.
  That early refusal is skipped for a physical or hosted device, an EAS
  profile and when build machines are paired; a build that still runs here
  is refused before Gradle runs, so a cache hit there still installs.
  The build would otherwise
  fail deep inside ninja ("mkdir ... No such file or directory" or
  "Filename longer than 260 characters"). Move or clone the project under a
  short real path such as C:\\src\\<name> and run Stim there. A subst drive
  does not help: Node's realpath and Expo autolinking resolve it back to the
  long path, and Gradle then sees two roots.
  A custom Gradle buildStagingDirectory can be shorter than the default; this
  preflight does not inspect that configured path and may refuse it too.
  \`doctor --platform android\` reports the same root as a finding for the
  emulator's ABI.`,
    },
    fallbacks: {
      summary: 'release cache-hit notes that are not codes: swap failure, asset gate, uninstall, device fallbacks',
      body: () => `FALLBACK NOTES THAT ARE NOT CODES (release cache hits)
  On a release cache hit Stim regenerates this workspace's JS bundle into a
  COPY of the cached artifact before installing it -- \`ios --configuration
  Release\` into a copy of the .app, \`android --variant ...Release\` into a
  copy of the APK. An iOS app that sets React Native's RCTUseAssetCatalog
  Info.plist key also gets its RNAssets.bundle image catalog recompiled with
  actool from the new bundle. When any step of that swap fails (reading the
  app's Info.plist, the bundle command, hermesc, actool, the expo-updates
  manifest refresh, the re-sign, zipalign, apksigner), the run does NOT
  install the
  cached artifact -- its baked-in JS is the builder's, not yours -- and does
  NOT fail: it prints a \`swap        failed at <step>: ... --
  building fresh instead\` note on stderr and falls back to a full build. If
  the run then fails, the code is the build's own (STIM_BUILD_FAILED etc.);
  the swap note above it says why the cache hit was not used. A swap that
  merely finds no hermesc notes it and embeds the plain JS bundle instead --
  that is a note, not a fallback.

  ANDROID'S ASSET GATE is the second, and it is not a failure at all. Before
  re-packing, Stim compares this workspace's freshly emitted asset tree
  against the assets the cached APK carries. Any added, removed or changed
  asset prints

    swap        this workspace's asset set differs from the cached APK's
                (1 added, 0 changed, 0 removed; e.g. added
                res/drawable-mdpi/new_logo.png) -- building fresh instead

  and the run does a full gradle build. There is nothing to fix: a drawable
  has a row in resources.arsc that only AAPT can write, so an APK cannot be
  made to carry an asset it was not built with, and installing one whose JS
  references a missing asset would 404 at runtime. Add an image, pay for one
  full build; the APK it produces becomes the new cache entry.

  THE UNINSTALL NOTE is the third, and it COSTS THE APP'S DATA. A re-packed
  APK is signed with this machine's debug keystore, so the moment it meets a
  copy signed by CI the install is refused with
  INSTALL_FAILED_UPDATE_INCOMPATIBLE (or INSTALL_FAILED_VERSION_DOWNGRADE) and
  nothing but removing the package resolves it. A RELEASE run therefore
  uninstalls the package once, retries the install once, and prints

    install     com.example.app was already installed with a different signer,
                so it was uninstalled (its data went with it) before this APK
                could be installed

  Debug runs never do this. A debug run meets the conflict on a physical
  device that already carries a store build, and there the colliding package is
  the user's real app: losing its data to a silent uninstall would be a worse
  bug than the one it fixes. A debug run fails with STIM_INSTALL_FAILED and
  hands you the uninstall to run yourself.

  ON A PHONE the same uninstall costs one thing more: iOS drops the Settings >
  General > VPN & Device Management trust entry when the last app from that
  developer goes, and it clears the app's Local Network permission with it. The
  note says so, because the reinstall succeeds and then the LAUNCH is refused
  until someone taps Trust again. The retry is one uninstall and one install --
  it is not a way around a tap that has no API.

  THE DEVICE FALLBACKS are the fourth, and both print a \`cache\` note and
  build fresh rather than failing:

    cache       a cached Release device app carries its builder's JS, and the
                device JS swap lands with phase 6 of appandflow/stim#178 --
                building fresh instead, which bakes in this workspace's JS

  and a signing-gate refusal on a CACHED artifact -- an expired or foreign
  profile, a phone the profile does not name, an identity this keychain does not
  hold -- which prints the gate's own reason with \`-- building fresh instead\`.
  The same refusal on a FRESHLY BUILT app is a code (STIM_NO_PROFILE,
  STIM_PROFILE_MISMATCH, STIM_NO_SIGNING_IDENTITY), not a note: building again
  would produce the same app and refuse again.`,
    },
    STIM_BUILD_WAIT_TIMEOUT: {
      summary: "waited ~90 minutes for another workspace's build of the same fingerprint",
      body: () => `STIM_BUILD_WAIT_TIMEOUT
  This run was waiting for ANOTHER workspace's build of the same fingerprint
  (see \`guide lifecycle concurrency\`), and no artifact arrived within ~90
  minutes.
  Replacement builders share that deadline, including time spent acquiring
  the lock between waits. A live builder may be wedged, or successive builders
  may have failed. The message names the current pid and lock directory:
  check the pid, and if it is not really building, remove that directory and
  run the command again.`,
    },
    STIM_CLAIM_REFUSED: {
      summary: 'an ownership claim blocks the operation; inspect its holder before removing an unresolved claim',
      body: () => `STIM_CLAIM_REFUSED
  A build lock records the holder's process IDENTITY, not just its pid, so a
  recycled pid reads as a gone builder rather than a live one, and a builder
  busy in a long \`simctl\` or gradle call reads as live rather than as stale.
  This code is the one state that cannot be decided: the claim file is truncated
  or not JSON, its identity token does not decode, or the holder spawned the
  process doing the work and was killed before recording which one.
  Stim will not remove a claim it cannot prove is dead, and it will not wait on
  one either -- a silent wait on a lock nobody holds is what this replaces. The
  message names the claim and the exact, shell-quoted removal that clears it --
  just that claim's file, not the lock directory around it; run that, then
  run the command again. Nothing was built, installed or removed.
  \`worktree warm\` reports it for the repository-wide warm claim under
  ~/.stim/warm-locks on both paths, including a \`--refresh\` that spawned its
  install and was killed before recording which process: nothing was refreshed
  and nothing was copied. A STIM_HOME or warm-locks ancestor that is a file
  also refuses. The message names that blocking path and prints a shell-quoted
  move-aside command. Inspect it first: the file may contain unrelated data.
  An existing backup prompts before overwriting; preserve both files.
  Android creation, recovery and teardown use per-AVD claims under
  ~/.stim/avd-locks. Creation records the avdmanager process group, so a claim
  left by a killed creator becomes recoverable after that group exits. Retry
  after a live creator or cleanup finishes. An interruption before the child
  is recorded, or during synchronous teardown, can leave no verifiable
  identity: inspect the named claim and confirm that neither Stim nor its
  avdmanager or adb child is still using the AVD before removing only that
  claim. Keep the AVD and its incomplete workspace record. Once the claim is
  safe to clear, retry \`stim android\` to reconcile incomplete setup through
  owned-device teardown. GC and project removal refuse while the claim is
  live or unresolved.
  Parked-device adoption and deletion use claims under $STIM_HOME/pool-locks.
  If a holder dies during a synchronous native callback, its child cannot be
  identified and the device stays protected, including from older CLIs through
  an opaque inline marker. Verify that the old Stim process
  and its native children have finished before removing the named claim.
  Legacy inline \`deletionClaim\` fields in config.json have no process
  identity and require separate manual inspection; \`stim guide lifecycle pool\`
  describes their field-only recovery.`,
    },
    STIM_MACOS_OWNER_UNVERIFIED: {
      summary: 'the macOS app owner cannot be verified; no signal is sent',
      body: () => `STIM_MACOS_OWNER_UNVERIFIED
  The recorded macOS process identity is unavailable or its workspace record
  is malformed. Stim sends no signal to an owner it cannot verify. Inspect the
  named process and workspace record before repairing it; do not replace a PID
  or token with another running app. Retry stim stop once identity inspection
  works. See stim guide macos.`,
    },
    STIM_OFFLOAD_REFUSED: {
      summary: 'the selected remote machine or automatic build pool cannot build this app',
      body: () => `STIM_OFFLOAD_REFUSED

Automatic placement also refuses when local is excluded in remote.buildPoolDisabled
and no enabled remote can finish this build, or when the build requires a local
compiler. Enable local or choose an explicit --remote-build placement. Existing
builds are not interrupted and a cache hit needs no compiler.

remote-only never builds here: it refuses when no remote machine in remote.machines
can take the build, naming each machine and why it was skipped, and for a build that
cannot leave this machine. Rerun with --remote-build remote to allow a local build
when no remote machine can take it.

A named --remote-build selection is strict. The message names the machine
and why it cannot take or finish the build: not configured or paired, approval
pending or denied, unreachable, changed pinned server key, a stim-server
too old to speak protocol 2, incompatible
toolchain/runtime/CPU, low disk, busy, sync/build failure, artifact failure,
or a checkout that changed while it built. Unsupported build kinds also refuse.
No local xcodebuild, Gradle or SwiftPM compile or alternate machine follows a
refusal. For stim android, a known toolchain refusal on the named machine stops
before prebuild; busy, low disk and unreachable are checked again afterward.
For stim ios, a toolchain difference on the named machine, such as Xcode,
the simulator runtime or the CPU, refuses before this machine runs prebuild or pod
install, even when prebuild would have produced an app the local cache already holds, or the
machine already holds the exact artifact. A
missing or different global CocoaPods never refuses a named machine; a pod install
that fails on it reports "pod install failed" with the command to run there.
Unlisted or unpaired names refuse at setup before consulting the cache, without
a build record or failed-run stats. A listed paired name with a cache hit needs
no build and does not contact the selected machine.

A fingerprint-mismatch reason means the worker fingerprints the synced
checkout differently. It names the sources that differ and the files pod
install or prebuild rewrote there. Stim already sends the gitignored files the
fingerprint reads, such as .env.local. Make the named input agree on both Macs,
for example by committing the lockfile pod install rewrote there; pairing does
not change it.

Run stim remote add <machine> to ask for build access if not approved. Check
stim remote list. A person on the worker approves this machine
by running the stim setup command stim remote add printed, with its ticket
and expiry (guide settings). Agents never run setup or approve requests.
Rerun with --remote-build auto or remote for placement with local fallback, or
--remote-build local to keep the build here.
`,
    },
    STIM_WORKTREE_SERVICE: {
      summary: 'worktree remove refuses a folder a stim service runs from',
      body: () => `STIM_WORKTREE_SERVICE
  A service that \`stim service install\` wrote runs a program from
  inside this worktree: on macOS a LaunchAgent with a StimService marker in
  ~/Library/LaunchAgents/<label>.plist, on Linux a systemd user unit with an
  [X-Stim] Managed=true section in ~/.config/systemd/user/<label>.service
  (default label dev.stim.server). Removing the folder would delete the
  running server's code. The refusal also covers a service that is installed
  but stopped, because launchd or systemd starts it again, and a marked file
  Stim could not read. \`--force\` does not
  override it, and gc leaves the worktree in place.
  Reinstall the service from another build (stim service install --label
  <label> from a checkout that stays), or remove it with stim service
  uninstall --label <label>, then run stim worktree remove again. Nothing was
  reclaimed or removed. Other processes with their working directory in the
  folder are not detected.`,
    },
    STIM_CLAIM_UNAVAILABLE: {
      summary: 'a process identity or warm claim store is unavailable, so the protected operation refuses',
      body: () => `STIM_CLAIM_UNAVAILABLE
  Every ownership claim records the holder's process identity, captured through
  the \`unique-pid\` native module. This code is that capture failing: no
  prebuilt binary for this platform and architecture, or the OS refusing to
  report this process's start identity.
  Stim refuses rather than building without a claim. A run with no claim is
  invisible to every other run, so the single-flight lock and
  concurrency.maxBuilds would both be off at once, and two builds could compile
  the same fingerprint while each believed it was alone. Reinstall Stim so the
  module for this platform is present, then run the command again. Nothing was
  built, installed or removed.
  Both plain \`worktree warm\` and \`worktree warm --refresh\` refuse before
  copying for the same reason. A copy without a claim would be invisible to a
  refresh starting after it, allowing the source dependencies to change while
  they are read.
  A report command such as \`gc\` reports it when it cannot confirm that a child
  it started has stopped, typically on a machine under heavy load. The child is
  left untouched. The remedy tells you what to check and which command to run
  again, and when the run held ownership claims it lists the exact \`rm\`
  command for each retained claim.
  When a Metro, tunnel, maintenance child or server worker cannot be verified
  stopped, Stim also retains the home, shared daemon and engine claims and
  refuses new work in that home.
  On Windows, the leader's exit alone does not prove its descendants stopped;
  verify the process tree before removing the listed claims.
  An attached daemon killed unexpectedly can also leave home, shared daemon
  and engine claims requiring the same check, including during startup or forced shutdown.
  Warm also reports this code for EACCES, EPERM, EROFS and ENOENT while taking a claim.
  The message names the claim path and original filesystem error. Restore write
  access to the existing claim store, checking parent permissions, symlink
  targets, mount access and sandbox rules, then retry. Do not switch STIM_HOME to evade a claim:
  concurrent runs must coordinate through the same store.`,
    },
    STIM_INSTALL_FAILED: {
      summary: 'simctl, adb, or devicectl refused the artifact; the one signer-conflict retry',
      body: () => `STIM_INSTALL_FAILED
  The artifact built or came from cache, but \`simctl install\` / \`adb install\` /
  \`devicectl device install app\` refused it. A signature or architecture
  mismatch, or a full device.
  On a PHONE (\`ios --device\`) the message carries devicectl's own text and the
  remedy names the cause it recognises: the phone is locked, the host is not
  trusted, Developer Mode is off, storage is full, or the app already on the
  phone was signed by a different team. Only that last one is retried -- one
  \`devicectl device uninstall app\`, one reinstall, and a warning that the
  app's data went with it -- along with the phone's developer trust and its
  Local Network permission, which iOS clears on an uninstall, so the launch
  after it may need the trust tap again. This is gated on \`--device\` rather
  than on the configuration, because every device run is signed, Debug
  included.
  On Android a signature or downgrade conflict names the package that is really
  installed -- the built APK's applicationId, which on a flavored project is
  the flavor's id and not the gradle namespace -- and gives you the
  \`adb -s <serial> uninstall <applicationId>\` that clears it. Re-running after
  that is a cache hit: one install, no build.
  On a REMOTE device (\`--remote\`) agent-device refused the upload or install.
  With \`--remote eas\` the EAS Simulator session stays up and billed; the
  remedy names it. Rerun to reuse it, or run \`stim stop\` to end it.`,
    },
    STIM_LAUNCH_FAILED: {
      summary: 'installed but would not start; the developer-trust tap on a phone',
      body: () => `STIM_LAUNCH_FAILED
  Installed, but the app would not start. On Android this usually means no
  launchable activity resolved.
  On a local iOS simulator, a timed-out launch can mean the simulator cannot
  spawn processes, even while it reports Booted. Check the reported memory
  pressure and free host memory before retrying; a timeout alone is not an OOM
  diagnosis. See \`stim guide lifecycle simslim\` for recovery and the optional
  SimSlim recommendation.
  On a PHONE it means the app never appeared in the device's own process list
  after \`devicectl device process launch\`, and the devicectl lines that
  explain it are quoted under the message. The refusal a first launch usually
  hits is the DEVELOPER TRUST one -- SpringBoard reports
  FBSOpenApplicationErrorDomain 3 with the reason Security -- and its remedy is
  the only one a human has to perform on the phone: Settings > General >
  VPN & Device Management, tap the developer profile under DEVELOPER APP, tap
  Trust, then run the command again. It is a per-developer-certificate tap, not
  a per-build one -- but an uninstall clears it, including the one Stim's own
  signer-conflict retry performs.
  On a local iOS simulator, a cache-hit app that dyld kills at launch because
  one part of the app cannot bind a symbol from another part of the same app
  (for example React.framework against hermesvm.framework) is a damaged build,
  not a launch problem. Stim removes that cache entry, and the remedy names
  it. Run the command again to build the app fresh. A cache provider's copy is
  not removed; add \`--no-build-cache\` to skip it. If the fresh app crashes
  the same way, the project's own native code is the cause.
  With \`--remote eas\` the remedy names the EAS Simulator session that is
  still running, as for STIM_INSTALL_FAILED.`,
    },
    STIM_NO_SCHEME: {
      summary: 'Xcode schemes unavailable or no unambiguous app scheme in ios/',
      body: () => `STIM_NO_SCHEME
  Stim could not list or select an app scheme in ios/. Share the intended app
  scheme so xcodebuild can see it. Select an available exact name with
  \`stim ios --scheme <name>\`, or set it once with the ios.scheme setting. An
  unknown explicit name prints available choices.
  Without an explicit selector, a workspace
  name match wins; otherwise Stim accepts a sole non-test scheme, or a listed
  scheme matching app.json. Unmatched ambiguous schemes are refused.`,
    },
    STIM_NO_PROFILE: {
      summary: 'no or undecodable embedded.mobileprovision; build once from Xcode',
      separator: '--- iOS SIGNING CODES (`ios --device`, and only there) ---',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_NO_PROFILE
  The built or cached .app has no embedded.mobileprovision, or
  \`openssl smime\` could not decode the one it has. The first means the build
  produced an unsigned app -- almost always a simulator-sliced artifact.
  Set a team for the target's configuration in Xcode > Signing &
  Capabilities, then run \`stim device provision ios [udid]\` (see
  STIM_PROVISION_UNCONFIRMED) or BUILD ONCE FROM XCODE to install the profile.
  No build does that step: registering a device or minting a profile changes
  your Apple Developer account, so builds never pass
  -allowProvisioningUpdates.`,
    },
    STIM_PROFILE_MISMATCH: {
      summary: 'the profile is expired, has no ProvisionedDevices, or does not name this UDID',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_PROFILE_MISMATCH
  The profile inside the app cannot admit this phone. Three shapes, and the
  message names which one and the profile type it found:
    - it expired, or carries no ExpirationDate at all;
    - it is an App Store or enterprise profile, which carries no
      ProvisionedDevices list -- so Stim cannot PROVE the phone is admitted and
      refuses rather than guessing. Local device runs need a development
      profile;
    - it is a development or ad hoc profile whose device list does not name
      this UDID. Run \`stim device provision ios <udid>\`, which registers
      the UDID and refreshes the Development profile after asking, or
      register it at developer.apple.com, regenerate the profile, and build
      once from Xcode.
  With --eas-profile, follow the EAS device:create and build commands in the
  refusal instead. Registration, signing changes and cloud builds need session
  authorization. See stim guide lifecycle eas.`,
    },
    STIM_NO_SIGNING_IDENTITY: {
      summary: 'no single keychain identity resolves; ios.signingIdentitySha1 for two certificates',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_NO_SIGNING_IDENTITY
  No single keychain identity could be resolved to re-seal with. Either
  \`security find-identity -v -p codesigning\` lists nothing, or the identity
  the artifact's own profile names is absent, or two certificates share that
  common name and Stim -- being non-interactive -- will not pick one.
  Open Xcode > Settings > Accounts and download your certificates, or unlock
  the login keychain with \`security unlock-keychain\`. For the two-certificate
  case, set ios.signingIdentitySha1 to the SHA-1 hash beside the one you want.`,
    },
    STIM_CODESIGN_FAILED: {
      summary: 'codesign failed on the modified copy; the cache entry is untouched and the run builds fresh',
      context: `A simulator build needs no signature, which is why none of these can fire on
the normal path. A device build carries one, and Stim re-seals any bundle it
modifies with the identity the bundle already names -- so it checks, before
spending a build or a bundle, that the check can succeed.`,
      body: () => `STIM_CODESIGN_FAILED
  \`codesign --force --sign\` or \`codesign --verify --strict\` exited non-zero
  on the modified copy. The verbatim codesign stderr is quoted, because it is
  the answer: a locked login keychain reports errSecInternalComponent, an
  ambiguous identity reports that it matched more than one. Unlock the keychain
  and confirm exactly one identity matches the name. The cache entry itself is
  never modified -- the failure is on a temporary copy, and the run builds
  fresh.`,
    },
    STIM_PROVISION_UNCONFIRMED: {
      summary: 'device provision ios listed its account changes and nobody confirmed them; nothing changed',
      separator: '--- iOS PROVISIONING CODES (`stim device provision ios`, and only there) ---',
      context: PROVISION_CONTEXT,
      body: () => `STIM_PROVISION_UNCONFIRMED
  The command printed what it would change -- the team, the phone, each bundle
  id whose Development profile it would create or refresh, and whether it uses
  the Xcode account or an App Store Connect API key -- and nobody confirmed:
  the terminal prompt was answered with anything but y, or there was no
  terminal (or --json) and no --yes. Nothing changed. \`--json\` adds the plan.
  Confirm in a terminal, or pass --yes once the account owner agreed. Agents
  never add --yes on their own.`,
    },
    STIM_PROVISION_FAILED: {
      summary: 'device provision ios could not provision: no account or key, team not accessible, or project signing',
      context: PROVISION_CONTEXT,
      body: () => `STIM_PROVISION_FAILED
  Before xcodebuild runs: the app has no Xcode project, xcodebuild cannot
  report the scheme's build settings, a signed target names no development
  team or uses manual signing (xcodebuild creates profiles only for automatic
  signing), the temporary DerivedData cannot be created, or a native app uses
  Swift packages that Stim has not resolved yet (no workspace-state.json in
  its package directory): run \`stim ios\` or \`stim ios --device <udid>\` once
  to resolve them, then provision. Packages resolved for an older
  Package.resolved fail inside xcodebuild, whose error is quoted. The remedy
  names the Xcode or app-config change. From xcodebuild: "No Accounts" means Xcode has no Apple
  ID signed in and no App Store Connect key is set -- sign in under Xcode >
  Settings > Accounts, or set ios.appStoreConnectKeyPath,
  ios.appStoreConnectKeyId and ios.appStoreConnectIssuerId (stim guide
  settings); "No Account for Team" means that account or key cannot reach the
  project's team; a 401 means Apple rejected the key. Any other xcodebuild
  error is quoted, with the key path replaced. An interrupt or the 15-minute
  timeout also ends here. Once xcodebuild has run, the refusal still lists
  any profile it installed and any new keychain identity (\`--json\`:
  \`changes\`), because Apple may already have registered the phone; running
  the command again is safe. A phone that is not paired or has Developer Mode
  off refuses earlier, with STIM_NO_DEVICE.`,
    },
    STIM_NO_LAN_ADDRESS: {
      summary: 'the Mac has no non-internal IPv4 interface; a tunnel cannot help a phone',
      separator: '--- iOS DEVICE DEBUG REACHABILITY CODES (`ios --device` in Debug) ---',
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.`,
      body: () => `STIM_NO_LAN_ADDRESS
  This Mac reports no non-internal IPv4 interface, so there is no address to
  give the phone: it is offline, or on nothing but utun/awdl/bridge. Join a
  Wi-Fi or Ethernet network, or connect this Mac by cable, and run again.
  Deliberately NOT "set metro.publicUrl": neither channel to a phone carries a
  URL. The dev-client deep link composes http://<host>:<port> itself, and
  ip.txt is read by RCTBundleURLProvider, which prefixes the scheme. A tunnel
  cannot be expressed to a phone, so --device ignores metro.publicUrl,
  metro.tunnel and metro.ngrokUrl and says so when one is set.`,
    },
    STIM_LAN_METRO_UNREACHABLE: {
      summary: "the LAN origin did not answer as this workspace's Metro; ios.lanHost on a multi-NIC Mac",
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost. Both codes
fire BEFORE the build, because a refusal that costs a build is a bad refusal.`,
      body: () => `STIM_LAN_METRO_UNREACHABLE
  The chosen LAN origin did not answer as THIS workspace's Metro: no answer, a
  5xx, or a dev server that is not this one -- the message says which.
  \`stim start\` prints the port it reserved. On a Mac with several interfaces
  the first en* is not necessarily the one the phone shares: set ios.lanHost to
  the address it can reach (see \`guide settings\`).
  What this gate CANNOT prove is that the phone can reach the origin: macOS
  routes a host connection to its own address over loopback, so the gate passes
  through a firewall that will block the phone. That evidence only ever arrives
  from the phone's own bundle request, which is what \`launched\` reports.`,
    },
    unverified: {
      summary: 'launched: "unverified" with the Local Network path reason, and the routed recovery',
      context: `A phone does not share the host's loopback and USB carries no reverse forward,
so a Debug run on one is wired to a LAN origin instead of localhost.`,
      body: () => `LAUNCH UNVERIFIED, LOCAL NETWORK NOT GRANTED (not a code -- a routed remedy)
  An app that has not been granted Local Network reaches nothing on the LAN,
  and CFNetwork reports each attempt as NSURLErrorDomain -1009 "The Internet
  connection appears to be offline." with the path reason

    _NSURLErrorNWPathKey=unsatisfied (Local network prohibited)

  THAT REASON IS THE WHOLE MATCH. The rest of the block -- POSIX error 50
  (ENETDOWN), \`failed to connect 1:50\`, \`error code: -1009 [1:50]\` -- is
  generic and says nothing about the permission: Wi-Fi turned off gives the
  identical errno with the reason \`unsatisfied (No network route)\`, and a
  cellular-only route gives \`unsatisfied (Denied over cellular interface)\`.
  Matching those would print this remedy at a phone that simply is not on the
  network, and would drop the same-SSID check that is the actual fix, so they
  are not matched.
  THE PROMPT AND A PRIOR DENIAL READ THE SAME. iOS emits this reason while the
  prompt is unanswered and after a Don't Allow, which persists across upgrade
  installs. The remedy covers both: if the first \`alert get\` finds no alert,
  it was denied earlier and the only fix is the switch under Settings > Privacy
  & Security > Local Network, which has no API.
  The reason is read out of THIS launch's device records -- since the launch,
  and from the app's pid when it is known. It is NOT origin-scoped: the record
  that carries the reason carries no URL (the failing URL lands in a
  continuation line with no process prefix, which the pid filter drops), so
  scoping to this workspace's Metro origin would never fire. That is sound
  anyway, because the permission gates every LAN connection the app makes, so
  even a third-party SDK's prohibited connection proves the app cannot reach
  this workspace's Metro either. Matching only picks the remedy: no record's
  level changes, so the device source stays out of \`logs --errors\`
  (\`guide logs\`: severity is never guessed on a phone).
  When it matches, \`launched: "unverified"\` leads with that evidence and with
  the recovery, in this order:

    agent-device alert get --platform ios --udid <udid>
    agent-device alert accept --platform ios --udid <udid>
    agent-device snapshot -i --platform ios --udid <udid>
    agent-device press 'label="Reload"' --platform ios --udid <udid>

  \`alert get\` reads the alert without opening anything, so it works while the
  app sits behind it. THE GRANT ALONE IS NOT ENOUGH: the dev client does not
  retry, and stays on "Failed to load app ... The Internet connection appears
  to be offline." with a Reload button, which is why the last two lines are
  there. The text form of the press target is \`label="Reload"\` (or
  \`text="Reload"\`); a bare \`press "Reload"\` is rejected. Stim's own launch
  ends in \`-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0\`,
  so the Expo dev menu is not over the app, fresh install or not. An app started
  ANOTHER way does not carry those arguments and \`snapshot -i\` can show the
  menu instead: \`agent-device press 'label="Close"'\` dismisses it, then press
  Reload. See \`guide facts devmenu\`.

  A BARE APP (no expo-dev-client) gets the same first two commands and a
  different third. The prompt fires the same way, because it is fired by any
  LAN connection to the Metro host, and the path reason is CFNetwork's either
  way -- the classifier reads that reason alone and knows nothing about dev
  clients. What differs is the screen: a bare app is expected to show React
  Native's RedBox, "Could not connect to development server". Read the screen
  with \`agent-device snapshot -i\` and press Reload by the ref or label it
  reports; neither that text nor the button's accessibility label has been read
  off hardware.

  \`agent-device metro reload\` does NOT recover either screen. It only reaches
  an app already connected to Metro's websocket, and an app stopped by this
  permission never connected.

  Without agent-device,
  \`xcrun devicectl device process launch --device <udid> --terminate-existing
  [--payload-url '<devClientUrl>'] <bundleId>
  [-- -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0]\`
  also recovers, and it costs the device log:
  it replaces the process the collector follows, so
  \`stim logs --source device\` stops for the rest of that run. For a dev
  client, pressing Reload is cheaper and keeps the collector alive. For a bare
  app the relaunch is the cleanest recovery, because it re-reads ip.txt. By
  hand it is two taps either way: Allow, then Reload.

  WHAT HAS ACTUALLY RUN: the dev-client path above was performed on a phone --
  the alert, the accept, the unchanged error screen, the Reload press, and the
  bundle that followed. The bare path has NOT been exercised on hardware; there
  is no provisioned bare project to run it on. Its signature and its remedy are
  reasoned from the same CFNetwork evidence and from React Native's own
  RedBox, not observed.

  THE OTHER ONE-TIME TAP HAS NO API. The developer-trust tap (Settings >
  General > VPN & Device Management) is refused to automation by the same gate
  that refuses the app, agent-device's own runner included, so its remedy is
  "ask the user" and nothing else. An uninstall clears both.`,
    },
    STIM_NO_DEVICE: {
      summary: 'no usable phone, or the owned simulator or emulator could not be created or booted',
      separator: '--- DEVICE AND CAPACITY CODES ---',
      body: () => `STIM_NO_DEVICE
  With \`--device\`, no physical device answered the selection: none connected,
  a named serial/UDID that is not connected, several connected with none named
  (the refusal lists them), or one that is connected but unusable -- an
  unauthorized Android device, or an iPhone that is unpaired or has Developer
  Mode off, over a cable or over Wi-Fi alike. Hardware is never created or
  booted, so there is nothing to retry into existence: fix the cable, the
  trust prompt, or Developer Mode.
  On Android it also means no system image matched and Stim could not install
  one: android.installImages is never, the SDK has no cmdline-tools/latest,
  the SDK licenses are not accepted (Stim never accepts them; run the
  \`sdkmanager --licenses\` line the remedy prints), the SDK volume has under
  8 GB free, or sdkmanager failed. The remedy names the exact sdkmanager
  command. Nothing was downloaded or created.
  Otherwise the owned simulator/emulator could not be created or could not
  reach a booted state. \`stim doctor\` checks the toolchain; \`stim status\` says what
  Stim thinks it owns. Re-running the command creates a fresh owned device
  when the recorded one is gone.
  With concurrency.maxDevices set, it also means Stim could not count the
  booted devices before a boot: a simctl or adb listing failed or timed out,
  usually under heavy load, or other runs held the device-admission lock for
  5 minutes. Retry once the load falls.
  From \`stim agent-device\`, the workspace has no device in the selected slot
  and platform, its owned emulator is not running, its hosted session's host
  offers no agent control, or agent-device is missing or older than 0.21.30.
  The remedy names the run command or the install command. A UDID, serial,
  device or remote config that is not the workspace's, \`boot\` and
  \`shutdown\` refuse with STIM_BAD_ARG instead.
  If Android creation says an AVD already exists on disk but is not listed,
  run \`npx stim gc\` to inspect orphaned owned AVDs, then \`npx stim gc --delete\`
  to reclaim those safe to delete before retrying. Keep anything GC cannot
  verify; do not delete AVD directories by hand. A registered unrecorded owned
  AVD is recovered, reusing its existing emulator when its identity is verified.
  If recovery cannot verify registration or process state, inspect \`npx stim status\`
  and \`adb devices\`, then retry after any other run finishes. Keep the AVD and
  its process locks while its state is unverified.
  On iOS a slow first boot is waited out for up to ten minutes while the
  simulator reports Booting or Booted but bootstatus has not completed, and
  then until SpringBoard has finished starting, which \`simctl launch\` needs.
  Booted alone does not end that wait. The failure names the udid and the wait.
  When \`simctl boot\` itself exits 22 (EINVAL), Stim lists the simulator: it
  continues the boot wait when the simulator is Booting or Booted, and boots
  once more after two seconds when it is Shutdown. A second refusal keeps the
  exit code in the failure and recommends memory relief only when the highest
  observed pressure was warning or critical.
  After boot, a process-spawn probe must finish within 30 seconds before
  installation. A probe that times out while the simulator still reports Booted
  is retried for about three minutes, since a loaded host can leave a booted
  simulator unresponsive for a while; a timeout on a simulator that no longer
  reports Booted, and any other probe failure, refuse at once. If it
  fails, the refusal includes observed host memory pressure
  when available. Free memory before retrying under pressure; see
  \`stim guide lifecycle simslim\`. Booted alone does not prove readiness.
  The same probe lists the simulator's launchd jobs and requires a running
  SpringBoard. A simulator that reports Booted while SpringBoard has died
  (\`simctl launch\` then says "The system shell probably crashed") is shut
  down through teardown and booted once more; if SpringBoard is still not
  running, the refusal names the udid and the remedy: \`stim stop\`, then
  \`stim ios\` again. Repeated SpringBoard crashes leave reports in
  ~/Library/Logs/DiagnosticReports, and macOS deletes them after about two
  days; before the restart Stim copies the simulator's recent ones into the
  workspace logs directory and records the boot steps by udid
  (\`stim logs --source device\`, \`stim guide logs\`, IOS BOOT RECORDS).
  On Android the emulator's own stdio is captured to
  the global workspace logs/emulator.log (truncated per boot), and when it printed a
  \`FATAL |\` / \`ERROR |\` / \`PANIC:\` line THAT is the message and the remedy
  you get -- the disk-space refusal ("Not enough space to create userdata
  partition") is the case this exists for. The generic toolchain remedy above
  is only what you see when neither the log nor the failure itself identifies
  the cause. An ENOSPC failure points at disk space instead: owned Android AVDs
  normally live under ~/.android/avd, and a booted AVD can use several GB. A
  boot whose emulator process exited is also reported at once rather than after
  the full cold-boot timeout.
  Before a local Android emulator boot, a memory phase line reports observed
  warning or critical macOS host memory pressure. If the initial boot wait
  times out under that pressure and the process this run started is still
  alive, Stim retries the WAIT once for up to 240 seconds more on the same
  serial; it never starts a second emulator. New-device preparation normally
  waits 120 seconds first; the later boot check waits 240 seconds. There is
  no extra wait for normal or unavailable pressure, a process that exited,
  or a process whose liveness this run cannot check. adb probes are bounded;
  final diagnostic queries share a separate budget of up to five seconds.
  A timeout remedy reports observed pressure and the running owned-device
  count when available. Device count alone does not establish memory pressure
  or trigger the extra wait. Stop an unneeded device with \`stim stop\` only
  in a workspace you own, then retry \`stim android\`; ask before closing
  other apps or devices. Specific emulator log errors retain their remedies.

"this project's sim is X, but --device-type asked for Y"
  The project already owns a simulator of a different model, and Stim will
  not silently boot a different one. Reap it (\`worktree remove\`, or
  \`gc --delete\`) and run \`stim ios\` again to create the requested model,
  which loses the old sim's app state, or pass \`--slot <name>\` to create it
  beside the current one. The \`remedy\` field in \`--json\` names the same
  choices.

"this project's sim runs iOS X, but --runtime asked for Y"
  The same refusal for an explicit \`--runtime\` that names another installed
  iOS version than the project's sim runs, with the same remedy. The
  ios.runtime setting alone never refuses; it applies at creation.

"this project's emulator uses device profile X, but Y was requested"
  The Android counterpart, from \`--device-profile\` or android.deviceProfile.
  Reap the AVD the same way, or pass \`--slot <name>\` to create the requested
  profile beside it.`,
    },
    STIM_DEVICE_BUSY: {
      summary: 'another workspace holds the lease on that phone and the wait ran out',
      body: () => `STIM_DEVICE_BUSY
  Only on a \`--device\` run. Another workspace holds the lease on that phone,
  and the wait ran out: the message names the holder root, the device, and the
  expiry as a clock time and a remaining duration, and \`--json\` adds
  \`lease: { platform, id, deviceName, holder, expiresAt }\`. In order, the
  remedies are: wait longer with \`--wait <seconds>\`, pick another device by
  id, or \`--no-wait\`, which installs with NO lease -- and when both
  workspaces build the same app id, that install terminates the app the holder
  is running. Two other cases refuse with this code and no wait at all: a lease
  file that does not parse (\`lease\` fields null, the file named -- nothing may
  take that device until it is dealt with), and this workspace's OWN lease with
  no token left in its \`state.json\` (its workspace directory was recreated).
  The remedy for that last one is \`stim device unlock\`, which releases by
  holder rather than by token.`,
    },
    STIM_DEVICE_TOOL_TARGET: {
      summary: 'a device tool found no owned, running simulator or emulator in that slot to act on',
      body: () => `STIM_DEVICE_TOOL_TARGET
  \`stim device location|permission|push|network\` act only on this workspace's
  own local simulator or emulator in the slot. The message says which check
  failed: the slot's device is hosted on another Mac, the workspace runs an
  EAS Simulator session, the slot has no owned device (a physical device
  reached with \`--device\` is never one), the recorded simulator is gone or not
  owned by this Stim home, or it is not booted or running. Permission and push
  also refuse when no app is recorded for the device. Run the platform command
  the remedy names (\`stim ios\` or \`stim android\`, with \`--slot\` for a named
  slot) and retry. A non-Mac client cannot run a local iOS simulator; run the
  iOS tool on a Mac with a local Stim-owned simulator. No tool runs before this refusal.`,
    },
    STIM_DEVICE_TOOL_UNSUPPORTED: {
      summary: 'that device tool has no equivalent on that platform',
      body: () => `STIM_DEVICE_TOOL_UNSUPPORTED
  The platform lacks the action: Android cannot clear a simulated location
  (\`adb emu geo fix\` only sets one), iOS has no network switch, and Android
  has no simulated push. The remedy names the nearest thing.`,
    },
    STIM_DEVICE_TOOL_FAILED: {
      summary: 'simctl or adb failed, or the device did not report the change afterwards',
      body: () => `STIM_DEVICE_TOOL_FAILED
  The tool call exited non-zero or timed out, with its output in the message, or
  the read-back after an Android permission or network change did not show the
  requested state. For a permission, the app must declare the permission in its
  manifest; when it declares none of the service's permissions the call refuses
  with this code. Check the device with \`stim status\` and retry.`,
    },
    STIM_DEVICE_WIRELESS_FAILED: {
      summary: 'an iPhone paired over Wi-Fi timed out or dropped during install or launch; use the cable',
      body: () => `STIM_DEVICE_WIRELESS_FAILED
  Only on an \`ios --device\` run whose iPhone devicectl reaches over Wi-Fi
  (transportType localNetwork). The \`devicectl device install app\` ran past
  its 15-minute Wi-Fi bound, the phone did not appear in its own process list
  within the 120-second Wi-Fi launch bound, or devicectl reported that the
  connection dropped in its own ERROR output (an app's log lines never count).
  The message names the transport and quotes devicectl. Connect the phone
  with a cable, keep it unlocked, and run the command again: a cabled phone
  installs over the cable. A cause devicectl names -- a locked phone, an
  untrusted host, Developer Mode off, full storage, the developer-trust tap --
  keeps STIM_INSTALL_FAILED or STIM_LAUNCH_FAILED and its own remedy, even
  when the step also timed out and even during a signer-conflict reinstall.`,
    },
    STIM_DEVICE_LOST: {
      summary: 'the lease was gone or re-held at the pre-install check, or revive found the owned device gone; rerun',
      body: () => `STIM_DEVICE_LOST
  From \`revive\`: the simulator or emulator a recorded launch ran on is no
  longer this workspace's owned device. It was deleted, parked, or taken over
  by another workspace, or the slot now records a different one. Revive never
  creates or adopts a device and never boots one the workspace does not own.
  It checks every launch before it starts anything; a device that changes
  after that check is refused by the run that boots it, and Metro, which
  revive restarted by then, keeps running. Run the printed \`stim ios\` or
  \`stim android\` command; it boots or creates this workspace's owned
  device. Revive run by agent-device's boot hook also refuses, starting
  nothing, when the device agent-device asked for
  (AGENT_DEVICE_BOOT_HOOK_DEVICE_ID) is neither one a recorded launch ran on
  nor one this workspace owns: drive one of the devices \`stim status\`
  lists.

  On a \`--device\` run: the run held a lease, and the raise before the
  install found it gone or held under another token -- another workspace took
  the device in that window. The message names the new holder and its expiry.
  Run the command again; it waits for that lease under \`--wait <seconds>\`.
  AFTER the install has started this is not a failure: the app is already on
  the phone, so the run prints one warning, continues, and reports
  \`lease: null\` in \`--json\`.`,
    },
    STIM_AT_CAPACITY: {
      summary: 'a build or boot waited past its queue ceiling, or --no-wait reached a cap or the queue',
      body: () => `STIM_AT_CAPACITY
  Every native build and every boot of an owned device takes a slot: builds
  under concurrency.maxBuilds (derived max(1, floor(CPU cores / 6)) when 0),
  boots under concurrency.maxDevices (derived max(2, floor((RAM - 4 GB) / 1.5
  GB)) when 0) and the per-platform caps, at most 2 boots at once, and no boot
  while memory pressure is critical. A run past a cap waits in arrival order
  per resource and prints its queue position every 10 seconds, and keeps
  waiting while every holder ahead of it is alive. This code means it waited 90
  minutes, a holder could not be verified (an unresolved slot claim, or a
  device listing that fails) for max(10 minutes, position x 5 minutes) without
  the run's position improving, a device wait outlived \`--wait <seconds>\`, or
  \`--no-wait\` / \`--wait 0\` found a cap full or another run queued. The message names what it waited
  for, who holds it and the queue. iOS waits for a device beside its build, so
  a rerun can reuse the artifact; a run that creates its simulator builds for
  any simulator while it waits and installs once the simulator exists. While a run waits to boot at a full device
  cap, the stim-daemon shuts down the longest-idle device of another workspace
  idle 2 minutes, one per tick (\`guide lifecycle concurrency\`). A boot that
  needs a new simulator or emulator creates it inside its slot.
  --remote remote-only (and macos.remote remote-only) has no local queue: when every
  approved host is full, loaded or short of memory it polls the hosts every 5 seconds
  for 600 seconds or --wait and then refuses with this code;
  --no-wait and --wait 0 refuse at once. Builds under remote-only refuse with
  STIM_OFFLOAD_REFUSED instead.
  Stop an environment (\`stim stop\`), retry once a build finishes, pass a
  longer \`--wait <seconds>\`, or raise the limit the message names
  (concurrency.maxBuilds, concurrency.maxDevices, or the platform's
  concurrency.maxIosDevices / maxAndroidDevices). On a stim-server worker the
  hosted offer and reserve name the full limit too, including
  concurrency.maxMacosApps. With --remote auto, remote.machines and the opt-in
  remote.easFallback (billed EAS Simulator) are tried before this wait;
  \`stim logs --source placement\` says why neither took the run. Status JSON
  exposes build.waitingFor with the position and resource, and daemon.waiting
  lists every waiting run. Stats records capacityWaits for device waits and
  capacityRefusals for this code. See \`guide lifecycle concurrency\`.`,
    },
    STIM_LOW_DISK: {
      summary: 'free disk stayed below disk.hardFloorGb after the pressure ladder ran',
      body: () => `STIM_LOW_DISK
  \`start\`, \`ios\` and \`android\` check free disk on the volumes holding
  the app and $STIM_HOME before they build or boot anything. Under
  disk.hardFloorGb (5 GB by default) they first have the pressure
  ladder run (\`guide lifecycle budget\`): idle workspaces, parked devices,
  shared caches, dormant devices, node_modules and Pods of idle worktrees,
  Gradle and TMPDIR leftovers. This code means a volume was still under the
  hard floor afterwards, so the run stopped instead of filling the disk.
  Nothing was built or booted.

  The message names the free space and the largest uses it could measure:
  Stim state, the shared build cache, simulators, Xcode DerivedData and
  Android emulators. \`stim status\` shows the pressure level and
  $STIM_HOME/daemon/daemon.ndjson what the ladder did. To free more:

    stim gc                            # what the ladder and gc would reclaim
    stim gc --delete                   # run the ladder at high, prune dead entries
    stim gc --delete --cache all       # the ladder at critical, empty the caches
    stim gc --delete --worktrees       # remove clean, idle worktrees

  Ask before deleting anything outside Stim, such as Xcode DerivedData or
  simulators Stim did not create. Lowering disk.hardFloorGb (0 never
  refuses) only removes the protection.`,
    },
    STIM_NO_REMOTE_SESSION: {
      summary: 'the backend could not use agent-device, or metro.tunnel names an unusable provider',
      separator: '--- REMOTE-DEVICE CODES (`ios --remote <proxy|eas>` / `android --remote <proxy|eas>`) ---',
      body: () => `STIM_NO_REMOTE_SESSION
  The selected backend could not use agent-device, or metro.tunnel names a
  provider or mode this workspace cannot use (e.g. "expo" on a bare RN
  project). The remedy line says which. Nothing was created yet.`,
    },
    STIM_REMOTE_PROXY_CONFIG: {
      summary: '--remote proxy needs AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN',
      body: () => `STIM_REMOTE_PROXY_CONFIG
  \`--remote proxy\` requires AGENT_DEVICE_DAEMON_BASE_URL and
  AGENT_DEVICE_DAEMON_AUTH_TOKEN. These variables provide credentials after
  proxy is selected. They never select the backend.`,
    },
    STIM_REMOTE_EAS_UNAVAILABLE: {
      summary: '--remote eas needs eas-cli 21.6.0 or later and an Expo app linked to an EAS project',
      body: () => `STIM_REMOTE_EAS_UNAVAILABLE
  \`--remote eas\` requires eas-cli 21.6.0 or later, the first release with
  the \`eas simulator:*\` commands Stim runs. Stim reads \`eas --version\` and
  refuses before any build or session work when eas-cli is missing, older, or
  reports no version. Upgrade it (\`npm install --global eas-cli@latest\`, or
  the project's eas-cli dependency). Proxy environment variables do not change
  this selection and are not passed to EAS.
  It is also the code when EAS reports that the Expo app has no EAS project
  (no extra.eas.projectId), so no session was created. Link the app with
  \`eas init --id <project-id> --non-interactive\` or create a project with
  \`eas init --account <account-name> --non-interactive\`, then rerun. Rerunning
  \`stim ios\` or \`stim android\` without the link fails the same way.`,
    },
    STIM_REMOTE_PLATFORM_MISMATCH: {
      summary: 'the recorded remote session belongs to the other platform; stop, then rerun',
      body: () => `STIM_REMOTE_PLATFORM_MISMATCH
  This workspace already has a recorded remote session, and it belongs to the
  OTHER platform ("Session <id> belongs to android, not ios"). A workspace
  holds one remote session, and Stim will not end the recorded one to make
  room -- it may be mid-run for whoever started it. Run \`stim stop\` for this
  workspace, then re-run with the platform you want. Nothing was created here.`,
    },
    STIM_REMOTE_DEVICE_MISMATCH: {
      summary: 'the recorded EAS session runs another model than --device-type asks for; stop, then rerun',
      body: () => `STIM_REMOTE_DEVICE_MISMATCH
  \`stim ios --remote eas --device-type <name>\` found this workspace's
  recorded EAS Simulator session still running another model, or the model
  EAS chose when no --device-type was given. EAS cannot change a running
  session's model, and Stim will not end the recorded session to make room --
  it may be mid-run for whoever started it. Run \`stim stop\` for this
  workspace, then rerun with the model you want. A recorded session that has
  already ended is replaced on the requested model instead, and without
  --device-type a live one is reused as it is. Nothing was created here.`,
    },
    STIM_REMOTE_SESSION_STATE: {
      summary: 'the EAS session was created but its state could not be recorded, so Stim stopped it',
      body: () => `STIM_REMOTE_SESSION_STATE
  The EAS session was created and is healthy, but recording it in this
  workspace's state failed (an unwritable STIM_HOME, a full disk). A session
  nothing references is a session nothing will ever stop, so Stim stopped the
  one it had just created and removed its ownership claim before reporting:
  this code means nothing is running and nothing is still billing. Repair the
  state storage the message names, then run the remote command again.`,
    },
    STIM_REMOTE_SESSION_CLEANUP: {
      summary: 'Stim could not prove an EAS session ended; eas simulator:stop --id',
      body: () => `STIM_REMOTE_SESSION_CLEANUP
  Stim tried to end an EAS session and could not PROVE it ended: \`eas
  simulator:stop\` failed, or its output did not confirm the stop, or the
  session stopped but its claim in the machine ledger could not be removed.
  This is a refusal rather than a note because a session that did not stop
  BILLS until its duration cap. The remedy names the exact command --
  \`eas simulator:stop --id <id>\` -- and for a ledger that outlived its
  session, the ledger path to repair. The same code covers a recorded session
  that could not be verified before replacement: inspect it, then \`stim stop\`.`,
    },
    STIM_REMOTE_METRO_WRONG: {
      summary: "the tunnel reaches a Metro that is not this workspace's",
      body: () => `STIM_REMOTE_METRO_WRONG
  The gate that proves a tunnel still reaches THIS workspace's Metro failed --
  before a session or a build, whether the tunnel is Expo's own, one Stim
  started (metro.tunnel: cloudflared/ngrok/auto), or a named metro.publicUrl.
  A recorded tailscale tunnel skips this public probe (\`guide metro\`).
  The usual cause: the tunnel was built for a port this workspace no longer
  holds (a stale one survived a \`stop\`/\`start\` that reserved a different
  port), and it now serves ANOTHER workspace's dev server -- healthy, and
  wrong. Re-run \`stim start\` (it prints the port it reserved) and, for a
  manual tunnel, rebuild it against that port.`,
    },
    STIM_REMOTE_METRO_UNREACHABLE: {
      summary: 'a remote start could not create its managed tunnel or tell the device where Metro is',
      body: () => `STIM_REMOTE_METRO_UNREACHABLE
  A remote start could not create its selected managed tunnel, or the device
  could not be told where Metro is. Follows the same remedy as
  STIM_NO_REMOTE_SESSION's tunnel guidance -- set metro.tunnel, or use
  metro.publicUrl for an existing endpoint.`,
    },
    STIM_RELOAD_AMBIGUOUS: {
      summary: 'more than one owned app or the owned Chrome is live; name the platform',
      separator: '--- RELOAD CODES (`stim reload [ios|android|web]`) ---',
      body: () => `STIM_RELOAD_AMBIGUOUS
  More than one of the owned iOS app, Android app and Chrome page is live.
  Name ios, android or web; Stim never guesses.`,
    },
    STIM_RELOAD_RELEASE: {
      summary: 'the live app has embedded JS; run a Debug build first',
      body: () => `STIM_RELOAD_RELEASE
  The live app was launched with embedded JavaScript. Run the platform command
  with a Debug configuration or variant first.`,
    },
    STIM_SERVER_NOT_RUNNING: {
      summary:
        'stim share found no stim-server and stimd could not start its net thread, or share list|stop found none',
      body: () => `STIM_SERVER_NOT_RUNNING
  Web shares live inside this Stim home's stim-server, the net thread of its
  stimd. stim share ios|android asks stimd, started when none runs, to start
  the net thread when none answers. This code means that failed; the message
  says why, such as an older stim-server holding the port. A stimd of
  another Stim build answers STIM_DAEMON_UNAVAILABLE instead. Fix what it names,
  or read $STIM_HOME/daemon/daemon.ndjson, then run stim share again. From
  share list or share stop it only means that no net thread runs, so nothing
  is shared.`,
    },
    STIM_SHARE_REFUSED: {
      summary: 'stim-server, or stim on Windows, would not start, stop or list a web share; the message names why',
      body: () => `STIM_SHARE_REFUSED
  The share was refused, by stim-server or by stim itself on Windows. The
  message names the reason: the device is
  not booted or not owned by this workspace (run stim ios or stim android
  first), Tailscale is not running, Funnel is not enabled for this node (a
  tailnet admin enables it; Stim never changes tailnet settings), every Funnel
  port already serves something (free one, see tailscale serve status), a
  route claim left by a crash cannot be resolved (follow the claim remedy in
  the message), the running stim-server predates web shares (update it), the
  link a --reuse asks for is live now ("That link is live now": it never
  stopped, or its device is away and it is stopped for now), or the machine runs Windows, which has no local
  stim-server socket (every
  stim share action refuses at once, starting nothing; run it from the macOS
  or Linux host that runs the device). See stim guide share.`,
    },
    STIM_RELOAD_STOPPED: {
      summary: 'the recorded app is gone, its device is not live and owned, or the process could not be proven',
      aliases: ['STIM_RELOAD_UNOWNED', 'STIM_RELOAD_PROBE_FAILED'],
      body: () => `STIM_RELOAD_STOPPED / STIM_RELOAD_UNOWNED / STIM_RELOAD_PROBE_FAILED
  The recorded app is gone, its exact device is not live and owned by this
  workspace, or Metro has no peer for the app and simctl/adb could not prove the
  process exists (a probe that times out alone does not stop the reload). For web,
  STOPPED means no owned Chrome is running (run stim web) and PROBE_FAILED
  that its identity could not be verified. A bare reload picks the Chrome page
  only when no native launch is recorded. Stim records launches only on owned
  local simulators and emulators. With none recorded, reload asks this
  workspace's Metro for its connected apps, which reaches an app on a physical
  device (--device) or an EAS Simulator session; STOPPED then means no app is
  connected to that Metro, so launch it or, for an Android phone, restore its
  adb reverse. No launch or device lifecycle action is taken; follow the
  printed remedy. When the recorded device is shut down, as after an idle
  stop, the remedy is \`stim revive\`.`,
    },
    STIM_RELOAD_FAILED: {
      summary: 'the reload failed; the remedy differs by shape -- read it before acting',
      body: () => `STIM_RELOAD_FAILED
  The Metro websocket reload did not reach a peer Stim could identify. Two
  shapes reach this code and the remedy differs. Read it rather than assuming.

  METRO DID NOT ANSWER. The probe timed out after 2 seconds, or the socket
  errored. Nothing is known about the app, so the remedy is to run the same
  reload again, and to check the dev server with stim doctor if it keeps
  timing out. Do not touch the device for this one.

  METRO REPORTS NO PEER FOR THE APP. Stim broadcasts a reload anyway before
  giving up, because matching is best-effort and an unmatched peer may still be
  this app, so VERIFY THE UI FIRST -- the app may already have recovered. If it
  did not, retry: a client reconnects to Metro every 2 seconds, which is also
  this probe's timeout, so a single miss can be a reconnect window rather than
  an app that never connected. If it stays unreachable on iOS, an error in the
  first bundle leaves the app without a packager connection at all and no retry
  will make it a peer. The remedy then routes the agent to the device's own
  controls in its existing automation session: press the error screen's Reload
  button, or open the dev menu and press Reload when no error screen is
  showing. The printed agent-device open command is the last resort; it
  relaunches that app on that device with this workspace's Metro port and loses
  in-memory state. Keep the existing --session flag and verify afterward.

  ADB COULD NOT LIST OR RESTORE THE REVERSE. Before an Android reload Stim
  checks the emulator's adb reverse for the Metro port. When adb cannot list
  or re-apply it, nothing was reloaded; the remedy names the adb reverse
  command to run before reloading again.

  MORE THAN ONE MATCHING PEER IS NOT A FAILURE. A workspace Metro serves one
  app, so several matching peers are that app on several devices. Stim reloads
  every one of them and reports the count in the facts as targets.`,
    },
    STIM_WEB_NO_CHROME: {
      summary: 'stim web found no installed Chrome or Chromium',
      separator: '--- WEB CODES (`stim web`) ---',
      body: () => `STIM_WEB_NO_CHROME
  stim web drives the installed Google Chrome (or Chromium) with a profile
  Stim creates. It looks in /Applications and ~/Applications on macOS, in
  Program Files on Windows, and for google-chrome or chromium on PATH. Stim
  never installs a browser. Install Chrome, then run stim doctor.`,
    },
    STIM_WEB_NO_URL: {
      summary: 'not an Expo app and web.url is unset, so Stim does not know which page to open',
      body: () => `STIM_WEB_NO_URL
  Only Expo serves web from Metro, so for any other app Stim needs web.url.
  stim web never starts a web server, for any framework. Start yours on a
  named port and point web.url at it:
    pnpm exec vite --port "$(stim ports get web)" --strictPort
    stim settings set web.url 'http://localhost:{port:web}/' --scope workspace
  See stim guide web.`,
    },
    STIM_WEB_DEPS_MISSING: {
      summary: 'an Expo app without react-native-web cannot render on the web',
      body: () => `STIM_WEB_DEPS_MISSING
  The Expo app does not resolve react-native-web, so Metro cannot build a web
  bundle. Install the web dependencies, start Metro, then run stim web again:
    npx expo install react-dom react-native-web @expo/metro-runtime
    stim start`,
    },
    STIM_WEB_BROWSER_HELD: {
      summary: 'the previous owned Chrome could not be stopped or verified; it was left running',
      body: () => `STIM_WEB_BROWSER_HELD
  stim web replaces the workspace's owned Chrome when its options change, and
  the previous one could not be stopped: Chrome did not exit, or its process
  identity could not be verified. Stim never signals
  a process it cannot verify. Check stim status for browser-unverified, then
  follow stim guide errors teardown.`,
    },
    STIM_WEB_LAUNCH_FAILED: {
      summary: 'the owned Chrome did not start or did not open DevTools on its reserved port',
      body: () => `STIM_WEB_LAUNCH_FAILED
  Chrome did not answer on its reserved DevTools port, or stimd could not
  attach to its page. web.ndjson carries the failure as web_browser_failed,
  and browser.log, which the remedy names, holds Chrome's own output.
  A port another process bound first also lands here: run stim web again to
  reserve a fresh one.`,
    },
    STIM_WORKTREE_REMOVAL_IN_PROGRESS: {
      summary: 'a managed remote start found worktree remove holding the lock; wait, then rerun',
      separator: '--- DEV-SERVER CODES (`stim start`) ---',
      body: () => `STIM_WORKTREE_REMOVAL_IN_PROGRESS
  A managed remote start found that \`stim worktree remove\` owns the
  worktree lock. The start did not register the project or create a tunnel.
  Wait for removal to finish, then run \`stim start --remote\` again.`,
    },
    STIM_REMOTE_START_REQUIRED: {
      summary: 'a running server cannot gain a remote tunnel; stop, then start --remote, or metro.publicUrl',
      body: () => `STIM_REMOTE_START_REQUIRED
  A healthy bare or Expo server was started without its required remote
  tunnel. A running server cannot gain that option. For a Stim supervisor,
  run \`stim stop\`, then \`stim start --remote\`. For an external server,
  configure metro.publicUrl or let Stim supervise the server.`,
    },
    STIM_BARE_DEPS: {
      summary: "the supervisor cannot host Metro from the project's node_modules",
      aliases: ['STIM_BARE_LOAD', 'STIM_BARE_API'],
      body: () => `STIM_BARE_DEPS / STIM_BARE_LOAD / STIM_BARE_API  (bare RN)
  The supervisor hosts Metro out of the PROJECT's node_modules, so metro,
  @react-native/dev-middleware and @react-native-community/cli-server-api must
  be installed there and must match the project's React Native. DEPS = not
  resolvable (install them), LOAD = installed but threw while loading,
  API = loaded but is not the API Stim expects (mismatched versions).`,
    },
    STIM_EXPO_BIN: {
      summary: 'node_modules/.bin/expo is missing; install dependencies',
      body: () => `STIM_EXPO_BIN  (Expo)
  node_modules/.bin/expo does not exist. Install the project's dependencies.`,
    },
    STIM_METRO_TIMEOUT: {
      summary: 'the supervisor is alive but Metro or the tunnel was not ready within the wait; --wait 180',
      body: () => `STIM_METRO_TIMEOUT
  "The dev server did not answer on port <n> within <s>s."
  The supervisor is alive, but Metro or its requested Expo tunnel is not ready.
  A Debug \`ios\` or \`android\` run that starts the dev server reports the
  same refusal after the default 60s; re-running it waits for the same
  supervisor again, and \`stim start --wait 180\` waits longer. \`start\` has already
  printed the last lines of the global workspace logs/supervisor.log above this -- read
  them. A cold Metro on a large graph can genuinely need more than the default
  60s: re-run with \`--wait 180\`. Otherwise \`stim stop\`, then \`start\`.`,
    },
    STIM_PORT_INSPECTION_FAILED: {
      summary: 'no free Metro port could be confirmed: netstat, lsof and loopback connects all failed',
      body: () => `STIM_PORT_INSPECTION_FAILED
  Stim reads the native TCP listener table (netstat on macOS and Windows,
  /proc/net on Linux) to find a free Metro port. When that table is denied,
  empty or unreadable, it checks each candidate with an lsof listener scan and
  connects to 127.0.0.1 and ::1. This refusal means none of them could answer,
  usually because a sandbox denies them. Allow Stim to run netstat or lsof, or
  to connect to loopback, then retry. A metro.port pin skips the scan for
  Metro. \`stim ports get\` prints the same message.`,
    },
    STIM_SUPERVISOR_EXITED: {
      summary: 'the dev server failed outright; the quoted supervisor.log tail is the real error',
      body: () => `STIM_SUPERVISOR_EXITED
  "The supervisor exited (<code|signal>) before the dev server came up"
  The dev server failed outright, and the quoted evidence is the real error:
  the supervisor.log tail if it wrote one, plus this attempt's error records
  from the timeline (an expo child's config error -- a PluginError, a bad app
  config -- lands THERE, not in supervisor.log). \`stim logs --errors\` has
  the full records. Fix that and run \`start\` again.

  A bind error on the reserved port ("listen EADDRINUSE ... :<port>") means
  another process, usually another Stim home, took the port after Stim chose
  it. \`start\` releases that reservation, reserves another free port and
  starts again, up to 3 attempts, and says so. A pinned metro.port and
  \`--remote\` starts are not retried. When all attempts fail, run \`start\`
  again.

  "Cannot reuse or replace the recorded supervisor: ..."
  A live record has no verifiable OS process identity, or the workspace and
  registry records disagree. Nothing new was started; the old process is
  left running. If inspection is denied, retry with permission to inspect
  Stim's processes. For a legacy record, stop the server with the tool that
  started it before retrying. Never reconstruct ownership from a process
  name, port, or wall-clock timestamp.`,
    },
    STIM_NO_RECORDED_BUILD: {
      summary: 'a recordedBuild run or revive found no app to install',
      body: () => `STIM_NO_RECORDED_BUILD
  From \`revive\`: revive reinstalls only the build cache entry a recorded
  launch installed, never the build output path, which a later build can
  overwrite. That entry is gone (\`gc\` or automatic maintenance evicted it),
  or the launch names none: its app was never cached, or the launch was
  recorded by a Stim version before revive. Run as agent-device's boot hook
  for a device this workspace owns, it also refuses with this code when the
  last launch on that device is one revive does not relaunch (a Release or
  native-process launch, or one whose record does not name that device), or
  when no launch is recorded on that device. Revive never fingerprints or builds, so nothing was started. Run the
  printed \`stim ios\` or \`stim android\` command; it restores the app
  from the cache or builds it.

  The API run option \`recordedBuild: true\` (used by \`stim ci run\`) installs the
  app the last build with the same iOS scheme and configuration, or Android
  variant, recorded in this workspace's state. None is recorded, or its app was
  removed. Nothing was started. Build first with the same selectors and the same
  Stim home (\`stim ci build\`, or the API build), then run again. \`stim guide ci\`
  has the flow. \`stim ios\` and \`stim android\` never use it.`,
    },
    STIM_ENV_TOO_LARGE: {
      summary: 'the invocation environment exceeds the forwarding limit',
      body: () => `STIM_ENV_TOO_LARGE
  The environment forwarded to stimd exceeds 512 KB. The refusal names the
  five largest variables. Reduce or unset them, then rerun the command.`,
    },
    STIM_BAD_ARG: {
      summary: 'an argument, setting, directory, flavor, or device name refused before anything starts',
      aliases: ['STIM_NO_PROJECT'],
      body: () => `STIM_BAD_ARG / STIM_NO_PROJECT
  The command refused before doing anything: an unusable --wait value, a known
  setting with the wrong type ("Invalid <key> setting <value>. Expected <shape>."
  -- \`guide settings\` names the type each key takes), an invalid
  Metro tunnel setting, \`stim macos\` with macos.product or macos.infoPlist
  unset (set both explicitly in .stim.json; see \`stim guide macos\`),
  \`stim macos --remote eas|proxy|auto\` (name a hosting Mac instead),
  an invalid android.dataPartitionSizeGb value, an unsafe
  android.avdConfig key or fragment, a malformed ios.signingIdentity,
  ios.signingIdentitySha1 or ios.lanHost value, a metro.port or
  STIM_METRO_PORT that another workspace reserves or another process holds,
  a changed pin while this workspace's dev server runs or its supervisor
  cannot be verified, unreadable hosting credentials during
  \`stim remote remove\` (see guide settings),
  \`--device\` with an empty
  serial or UDID, \`--device\` together with \`--remote\` other than
  \`local\`, \`ios --runtime\`
  on an eas/proxy run (\`--remote\` or ios.remote; that backend picks the
  iOS version), \`ios --device-type\` on the proxy backend or with an
  eas-cli older than 22.2.0 on the eas backend, \`android --system-image\` or
  \`--device-profile\` on an eas/proxy run (\`--remote\` or android.remote), a
  \`android --remote auto\`, a changed hosted placement, or hosted Debug
  with \`--no-metro-check\` (see lifecycle hosted-android), a working directory
  with no supported app project, or a project whose integration refuses this
  operation. React Native and Expo require a readable package.json that
  declares react-native or expo; the refusal names the invalid file.
  \`doctor\` reports project admission problems as findings. A \`logs\` query in
  a workspace that has never produced a log timeline (the refusal names the
  nearest registered descendant app with logs when one exists), an
  android/app/build.gradle that declares product flavors with
  no variant selected (the refusal names the debug variants), or a
  \`--device-type\`, \`--runtime\`, \`--system-image\` or \`--device-profile\`
  name that is BLANK or is not installed on this machine. For the
  unknown-name case the installed names are printed in the message -- the
  versions \`xcrun simctl list runtimes\` reports, the models those runtimes
  can actually CREATE (not the whole \`simctl list devicetypes\` table, which
  also names watchOS, tvOS and visionOS models no iOS runtime offers), the
  system images the SDK has, or the hardware profiles \`avdmanager list device
  -c\` offers -- so the remedy is to re-run with one of them. An
  ios.deviceType, ios.runtime, android.systemImage or android.deviceProfile
  setting is checked the same way, and the check applies
  even when this workspace ALREADY owns a device, so a name that could never
  create anything is caught rather than left to a later run. When the bad
  value came from a settings layer rather than a flag, the message also names
  the layer (workspace, repo, committed, or machine) it is set at, since all
  four settings are readable from the machine layer too. The
  \`pixel_fold\` and \`resizable\` profiles on a system image without
  foldable support (SupportPixelFold in its advancedFeatures.ini) refuse the
  same way, since the emulator quits on boot; the remedy names an installed
  image that has it, or an sdkmanager install when none does.
  \`gc --json --cache <name>\` refuses with STIM_BAD_ARG when no shared cache
  carries the name; the remedy names the caches on this machine. \`gc\`
  refuses --cache together with --worktrees the same way. \`stim settings
  set\` and \`get\` refuse a removed setting, naming what replaced it, and
  \`start\`, \`ios\`, \`android\`, \`web\`, \`macos\`, \`revive\` and \`gc\` refuse
  while the environment sets a removed setting's variable, such as
  STIM_MAINTENANCE, or a config file still holds a removed setting's old value
  that turned something off; unset it, or set its replacement, such as
  STIM_DAEMON or daemon.mode (\`guide settings\`, REMOVED SETTINGS).
  A working directory with no supported project above it gets the same
  STIM_NO_PROJECT refusal from \`start\`, \`ios\`, \`android\`, \`stop\`,
  \`reload\`, \`logs\`, \`doctor\` and \`device lock|unlock\`. With \`--json\` the { code, message, remedy } object
  is on stdout, except \`logs --json\`, whose stdout stays empty NDJSON; the
  refusal is on stderr. \`stop\` outside a project refuses rather than
  reporting that nothing was running.
  For a changed Metro pin, run stim stop before retrying, or unset or restore
  the pin; for an unverified supervisor, stop it with the tool that started it. A foreign holder is refused before anything starts; this project's
  own Metro on the pin is attached to. stim web follows the same rules when
  its page uses Metro. ios and android with --no-metro-check use the pin,
  then the recorded port, then 8081, without probing or reserving; an invalid
  pin still refuses.
  These errors are caught before the port is reserved and before any build or
  device work, so nothing was started. The one listing they need
  (\`simctl list runtimes\`, the SDK's system-images directory, \`avdmanager
  list device -c\`) runs only when
  a name was actually given, and a listing that fails is reported as
  STIM_NO_DEVICE naming the tool, never as a crash.`,
    },
    STIM_LOCK_REFUSED: {
      summary: 'a directory lock is held by a removal, which is never waited out',
      separator: '--- COORDINATION CODES (any command that shares a resource) ---',
      body: () => `STIM_LOCK_REFUSED
  A directory lock that serialises two commands over the same thing -- this
  workspace's managed tunnel, its managed remote worktree, the machine's EAS
  project ledger -- is held by a REMOVAL, and a removal is never waited out:
  what it protects will not exist when the lock frees. Nothing was created.
  The message names the lock and the purpose holding it (\`worktree removal\`,
  \`workspace removal\` -- both are \`stim worktree remove\`). Let it finish,
  then run the command again. \`start --remote\` reports this same case as
  STIM_WORKTREE_REMOVAL_IN_PROGRESS instead.`,
    },
    STIM_REPORT_TIMEOUT: {
      summary: 'An in-process report or lifecycle operation exceeded its execution budget',
      body: () => `STIM_REPORT_TIMEOUT

An API operation exceeded its execution budget: 90 minutes for warmWorktree(),
60 seconds for doctor(), gc(), collectGarbage(), reload(), plan() and removeWorktree().
Stim attempts only that operation's cleanup before rejecting, with a 35 second
cleanup budget. Unfinished cleanup returns STIM_CLAIM_UNAVAILABLE instead.
Other clients are unaffected. Retry after the machine is less busy, or narrow
the report with doctor({ platform }) or gc({ cache }). doctor() and gc() remain
read-only. collectGarbage() can mutate resources; completed actions remain applied.
Inspect what remains with gc() before retrying a mutation.
`,
    },
    STIM_CANCELLED: {
      summary: 'an ios, android or macos run was interrupted by `stim stop` or Ctrl-C before it finished',
      body: () => `STIM_CANCELLED  (ios, android, macos; exit 130)
  "The ios run was cancelled by \`stim stop\` (pid <n>) before it finished."
  The run was interrupted: by \`stim stop\`, which cancels a build it leaves
  with nothing to deploy to, or by Ctrl-C. It forwarded the interrupt
  to the build tool it was running (xcodebuild, Gradle, pod install, expo
  prebuild) and failed through its own cleanup; the next line names the step it
  stopped at. An interrupted build stores no artifact, so the next run looks
  up the cache as usual. Stopped between build tools, a run that \`stop\`
  cancelled starts no further build tool and stops before it installs. A
  Ctrl-C while the run delivers the app to a hosting Mac, or waits for the app
  to load its bundle or report readiness, ends that work and reports
  STIM_CANCELLED. A second Ctrl-C exits at once, and so does a Ctrl-C with no
  build tool, SimSlim, hosted app delivery or launch readiness wait to stop;
  those exits print no payload. Run the same command again when you want the
  app on a device.`,
    },
    STIM_STOP_BLOCKED: {
      summary: '`stop` could not interrupt the ios or android run holding this workspace; names its pid and claim',
      body: () => `STIM_STOP_BLOCKED  (stop)
  \`stop\` found a live \`ios\` or \`android\` run holding this workspace's
  native-run claim and could not end it:
  - "... did not exit within 60s of SIGINT": the run was interrupted but is
    still running. Wait for it, or end it with the \`kill <pid>\` the remedy
    prints, then run \`stim stop\` again.
  - "... did not exit within 60s of the stop request": the run is inside a
    process that embeds Stim, such as stim-server, and runs other work too.
    Stop does not signal that process. Wait for the run, or cancel it from
    the client that started it, then run \`stim stop\` again.
  - "... pid <n> is no longer that run; the build tool it started (pid <m>)
    still holds the claim": the run itself died and its build tool keeps the
    claim. Stim signals only a claim owner whose recorded identity it can
    prove, so it leaves the tool alone. Wait for pid <m> to exit or end it.
    On Windows this is the usual outcome of an interrupt: Node cannot deliver
    a catchable SIGINT to another process there, so the run ends at once and
    its Gradle build keeps the claim until it exits.
  A recorded EAS session is ended before this refusal: ending a billable
  session never waits on a build. The JSON payload carries the session
  outcome under device.remote. Devices, collectors and the dev server are left
  as they were.`,
    },
    STIM_LOCK_TIMEOUT: {
      summary: 'a lock held past the wait; workspace-process and short directory locks',
      body: () => `STIM_LOCK_TIMEOUT
  The same locks, held by an ordinary command that is still running, for
  longer than the wait -- 60s by default, 4 minutes for the remote-session lock
  and for \`gc\` deleting EAS sessions under the EAS project lock (its sweep
  skips at once while that lock is held), and ~90 minutes for the \`worktree warm\` lock, which one
  \`--refresh\` can hold for a whole dependency install. The machine-wide EAS
  project lock admits one EAS session start at a time. A \`--remote eas\` run
  waits on it after its build with no overall limit, printing \`lock  waiting
  for EAS remote start (pid 41233, in <workspace>, running for 1m12s) to
  release the EAS project lock\` at once and \`still waiting for ...\` every 30
  seconds. It refuses only when one holder has held the lock for longer than
  the slowest EAS session start (39 minutes), naming that pid.
  The \`worktree warm\` wait prints its
  elapsed waiting time and holder every 30 seconds (\`lock        waiting 40s
  for stim worktree warm --refresh (pid 41233)\`) and the refusal names the same holder
  and the lock directory under ~/.stim/warm-locks.
  A lock whose owner died is taken over automatically (its recorded
  process identity is checked every poll), so this means another Stim command really
  is working on this workspace: wait for it and retry. Inspect the named
  holder before taking any recovery action. The same error code also covers
  the short-lock timeout below.

"Timed out waiting for the lock at <path>."
  Short locks serialize writes to config, workspace state, device
  leases, ownership records, metadata, and cache manifests. The path identifies
  the lock. These locks wait up to 12s and never expire based on age. When
  another Stim command holds the lock, the message says so: wait for it and
  retry.
  Short locks use the same process-identity claims as long operations. The
  exclusive claim at <path>.claims is the only lock state; Stim does not create,
  inspect or remove <path> itself. A complete claim left by a proven-dead owner
  is recovered automatically on the next attempt. An unreadable or undecodable
  record instead reports STIM_CLAIM_REFUSED and names the claim to inspect;
  an unavailable native identity reports STIM_CLAIM_UNAVAILABLE without running
  the protected work.
  Standalone Metro and Expo cache packages use the
  same core protocol and do not require the Stim CLI.`,
    },
    teardown: {
      summary: 'an unmanaged port, an unverified supervisor, and a failed device teardown',
      separator: '--- TEARDOWN AND WORKSPACE REFUSALS ---',
      body: () => `"metro       refusing to kill port <n>: ... runs from <dir>, outside
<project>"  (stop)
  Stim only signals processes it launched and whose saved identity still
  matches. Stop an externally started server with the tool that started it.
  Matching this workspace's port or directory does not authorize cleanup,
  and stop has no override for process ownership.

"port <n> is in use by <holder>; stim start will choose a free port"  (status)
  A note, not a problem: no supervisor of this workspace runs, and
  \`stim start\` reserves a free port when its own is taken. The holder's pid
  and directory are in \`status --json\` under metro.heldBy.

"port <n> is in use by <holder>, so this workspace's Metro cannot serve on
it"  (status)
  This workspace's supervisor runs but another process answers its port.
  Run \`stim stop\`, then \`stim start\`, which reserves a free port.

"stop        refusing to signal supervisor pid <n>: ..."  (stop)
  The records disagree, the saved OS identity is unavailable, or it records a
  port this project did not reserve. If process inspection is denied, retry
  with permission to inspect the processes Stim started. A pid is a number the OS reuses, so it is not
  signalled. The port reservation is KEPT -- it is the only handle a retry
  has. Check \`ps -p <n>\` and \`stim status\` before signalling by hand.

"supervisor pid <n> did not exit within 10s of SIGTERM"  (stop)
  Deliberately not escalated to SIGKILL: the supervisor may be mid-write on the
  very log files \`logs\` reads. The device is left alone and the port stays
  reserved. Re-run \`stop\`, or signal it yourself: kill -9 -<n> (note the
  minus -- it is a process group).

"metro       refusing to signal it: the identity of dev server pid <n> left by
the supervisor could not be verified"  (stop)
"metro       dev server pid <n> left by the supervisor did not exit"  (stop)
  The supervisor is gone but the dev server it started may still run. Stim
  signals it only while its saved identity matches, and on macOS and Linux
  never escalates to SIGKILL. The record and the port reservation are KEPT for a retry. Check
  \`ps -p <n>\`, stop it yourself if it is still running, then re-run \`stop\`.

"teardown failed: <reason>"
  Stim could not release the owned device and keeps its record for a retry.
  \`worktree remove\` exits 1 without removing the worktree while the device is
  still tracked. Fix the reported cause and re-run.

"teardown failed: Owned AVD <name> did not finish shutting down after <n>s:
emulator process <pid> is still running"
  An owned emulator counts as stopped only when no process launched for its
  AVD (\`qemu-system-*\` or \`emulator\` with \`-avd <name>\`) is left in the
  process table. Stim asks it to quit with \`adb emu kill\` and waits 60s.
  Then it sends SIGTERM and, 5s later, SIGKILL. When adb cannot reach the
  emulator, Stim sends SIGTERM at once and waits 60s before SIGKILL. It signals
  only a pid whose command line names the AVD and whose process identity,
  recorded before shutdown, still matches. "(Stim could not verify the
  identity of <pid>, so it sent no signal)" means that identity could not be
  read or no longer matches. Check \`ps -p <pid> -o command=\`, stop the
  process yourself, then re-run the command or \`gc --delete\`. Windows has
  no process-table check and Stim signals nothing there: it waits for the pid
  in the AVD's process lock after \`adb emu kill\`, and refuses at once when
  adb cannot reach the emulator.`,
    },
    remove: {
      summary: 'worktree remove refused a dirty tree: what it restores itself and what --force discards',
      body: () => `"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"  (worktree remove)
  A native build rewrites tracked files, and Stim now RESTORES the one class
  it can prove is not work: when the only dirt left is \`pod install\` churn
  (\`<app>/ios/Podfile.lock\`, \`<app>/ios/*.xcodeproj/project.pbxproj\`,
  tracked and unstaged), \`worktree remove\` runs the checkout itself and says
  so per file -- those files die with the worktree either way, and a lockfile
  change anyone meant would have been committed. ONE other dirty path and the
  whole set is refused, churn included, so this never eats real work.
  Untracked \`.watchman-cookie-*\` files, which watchman writes into the roots
  it watches, are not work either: \`worktree remove\` deletes them itself and
  ignores them when it counts dirty paths. Any other untracked file still
  refuses.
  When it does refuse, the refusal PRINTS THE DIRTY PATHS, and the restore
  command under it carries those same paths: run it as printed rather than
  reaching for --force.
  It is built from what git reported, so in a monorepo it names
  \`apps/<app>/ios/Podfile.lock\` rather than an \`ios/...\` example that would
  fail with "did not match any file(s) known to git".
  A setup script that rewrites tracked assets (brand icons, generated config)
  produces the same refusal, with the same treatment: restore the paths the
  refusal actually named.
  Use --force only when you genuinely intend to discard work; it deletes
  uncommitted and untracked files permanently.`,
    },
    STIM_MAIN_DIRTY: {
      summary: 'warm --refresh will not move a source checkout with local work or an operation in progress',
      body: () => `STIM_MAIN_DIRTY
  \`worktree warm --refresh\` writes to the SOURCE CHECKOUT, and it refuses one
  it cannot move: tracked files with uncommitted changes (the refusal names
  them), or a rebase or merge in progress. Untracked files are not a reason to
  refuse -- but git itself refuses a fast-forward that would overwrite one, and
  that reports this code too, quoting git. The remedy is the exact line that
  clears it: commit, \`git -C <source-checkout> stash push -u -m warm-refresh\`,
  or \`git -C <source-checkout> rebase --abort\`. Nothing was installed or
  copied. Plain \`stim worktree warm\` does not care: it copies from a dirty
  source checkout exactly as it always has.`,
    },
    STIM_MAIN_DETACHED: {
      summary: 'warm --refresh needs a branch to fast-forward, not a detached HEAD',
      body: () => `STIM_MAIN_DETACHED
  The source checkout's HEAD is detached, so there is no branch to fast-forward
  and no upstream to fast-forward it to. Run
  \`git -C <source-checkout> checkout <branch>\` and warm again. \`--refresh\`
  never picks a branch for you; a checkout whose job is to seed worktrees
  should sit on a branch someone chose.`,
    },
    STIM_MAIN_DIVERGED: {
      summary: 'the source checkout is both ahead of and behind its upstream; warm --refresh will not merge',
      body: () => `STIM_MAIN_DIVERGED
  The source checkout's branch has commits its upstream does not, AND its
  upstream has commits it does not. A fast-forward is impossible, and
  \`--refresh\` will not merge or reset someone else's checkout to make one:
  that decision is yours. Rebase or merge it yourself, then warm again. The
  message reports both counts. Nothing was installed or copied.`,
    },
    STIM_DEPS_INCOMPLETE: {
      summary: 'the last install recorded for the lockfile on disk now did not finish, so warm will not copy it',
      body: () => `STIM_DEPS_INCOMPLETE
  \`worktree warm\` refuses to copy dependencies the source checkout never
  finished installing. \`--refresh\` records a COMPLETED install of the lockfile
  it read under ~/.stim/warm-installs; an install that failed, or whose process
  was killed, leaves that record saying unfinished. A plain warm reads it after
  it takes its claim and before it copies, and this code is what it prints when
  the unfinished install is of the lockfile AS IT STANDS NOW. Without it the
  copy carries a partial node_modules and exits 0, and nothing else in the run
  says so: the refresh reported its own STIM_DEPS_FAILED in its own terminal,
  and a refresh that was killed reported nothing anywhere. Nothing was copied.
  Run \`stim worktree warm --refresh\`: it reinstalls rather than skipping for
  exactly the same record, and a plain warm copies once that install completes.
  Two states deliberately do NOT produce this code. A record of a DIFFERENT
  lockfile says nothing about the one on disk now, whose dependencies may well
  have been installed since; and a repository with no record at all -- every
  repository before its first \`--refresh\` -- copies as it always has.
  Each directory that owns a lockfile the refresh installs has its own record:
  the repository root and, when the app has a lockfile of its own, the app. A
  plain warm reads both.`,
    },
    warm: {
      summary: 'worktree warm claim storage refusals and recovery',
      body: () => `Both plain warm and --refresh require an ownership claim.
  Permission-denied or read-only claim storage reports STIM_CLAIM_UNAVAILABLE
  and names the path. Restore access to the existing claim store and retry.
  A non-directory claim ancestor reports STIM_CLAIM_REFUSED and names the
  blocking file. Inspect it and use the printed move-aside command to preserve
  its contents before retrying. See guide errors STIM_CLAIM_UNAVAILABLE and
  guide errors STIM_CLAIM_REFUSED for the recovery details.`,
    },
    carry: {
      summary: 'worktree warm copy results, lockfile mismatches, and remedies',
      body: () => `"carry       incomplete: ... ignored entries copied, ... kept, ... failed"
(worktree warm)
  At least one entry could not be copied. The command exits 1 and names each
  failure. Existing entries stay untouched; any files already published remain.
  Inspect failed paths before retrying, because existing directories are skipped
  whole. "complete" means the eligible copy finished, not that dependencies
  are installed or match this branch. Progress and results go to stderr,
  with empty stdout.

"carry       carried <dir>/Pods does not match the <dir>/Podfile.lock on disk here"
  Warm copied ignored Pods from the source checkout, but their Manifest.lock
  differs from the tracked Podfile.lock in this worktree. Warm does not change
  tracked files. Run the printed pod-install command before building directly.
  \`stim ios\` detects a mismatch and runs \`pod install\` for you. A mismatch
  limited to checksums of podspecs that embed the source checkout's path is
  resolved by warm itself ("carry moved <dir>/Pods to this checkout's path")
  and does not print this line. When the locks match but Pods still name the
  source path and warm cannot move it, it prints "removed <dir>/Pods/Manifest.lock
  so pod install runs" and \`stim ios\` runs \`pod install\`.

"carry       carried <dir>/Pods has N broken link(s), such as <path>; removed <dir>/Pods/Manifest.lock so pod install runs"
  The carried Pods contain symlinks that do not resolve, usually header links
  into <dir>/build/ that the source checkout lost. Matching locks do not make
  such Pods usable, so warm removes Manifest.lock and \`stim ios\` runs
  \`pod install\` here, which recreates the links. The line also names the
  \`pod install --clean-install\` command for the source checkout, which
  \`stim doctor\` reports as well; until that is run, every new worktree
  warmed from it pays one \`pod install\`.

"carry       carried <dir>/Pods: The source checkout's Pods were last built as ..."
  Warm copied Pods whose React-Core-prebuilt, ReactNativeDependencies or
  hermes-engine were last built in Debug or Release, and this workspace builds
  the other. React Native re-extracts those frameworks on the first build here,
  costing about 1 GB of unshared disk and extraction time. Nothing is wrong
  with the copy. Build the source checkout once in the configuration the
  worktrees build (\`stim ios\` there) before warming more worktrees. \`stim
  doctor\` reports the same condition as the \`ios-pods-flavor\` note.

"carry       left out <app>/<platform>: <reason>"
  The app is an Expo project whose ios/ or android/ Git ignores, and Stim
  cannot show the source checkout's copy was generated from the app's current
  inputs: Stim has no prebuild record for it, its last prebuild did not
  finish, or the record names an earlier native fingerprint. Warm does not
  copy it, so the first \`stim <platform>\` in this worktree generates it
  fresh. For ios that includes a fresh \`pod install\`, so the worktree's
  Pods are a private copy rather than a clone. Nothing to fix. To let later
  warms copy it, delete <platform>/ in
  the source checkout and run \`stim <platform>\` there, so Stim generates it
  fresh and records that.

"carry       carried <dir>/Pods but there is no <dir>/Podfile.lock"
  Warm copied Pods but the destination has no Podfile.lock. Follow the printed
  pod-install command before building.

"carry       carried [<dir>/]node_modules was installed from a different <lockfile> than ..."
  The carried node_modules records the lockfile it was installed from (npm
  node_modules/.package-lock.json, pnpm node_modules/.pnpm/lock.yaml, Yarn
  node_modules/.yarn-integrity or node_modules/.yarn-state.yml), and it
  differs from this worktree's lockfile. This fires even when both checkouts
  share the lockfile, because the source checkout itself was not reinstalled
  after it changed. Run the printed install command before building;
  otherwise pod install and native builds resolve the old package versions.
  A pnpm source checkout installed with --filter or --prod also reads as a
  mismatch, because pnpm records only what it installed.
  With an npm lockfile the command is \`npm ci\`, which deletes node_modules
  before it installs: it replaces the clone, which costs no disk, with a
  private copy of every package, and the line says so.

"carry       carried dependencies may be stale: they do not match ..."
  node_modules records no install state Stim can read (Bun, or no record),
  and the source checkout's lockfile differs from this branch's lockfile. Run
  the printed package-manager command before building. A carry whose lockfile
  matches is silent; the warning means a real difference.
  The same \`npm ci\` note applies.

  If the source checkout has no dependencies to copy, use this project's
  package manager to install them. Warm does not install dependencies or prove
  the app is ready, unless \`--refresh\` installed them in the SOURCE CHECKOUT
  first; even then the copy can still carry a lockfile this branch does not
  have, which is exactly what these carry warnings report.`,
    },
    environment: {
      summary: 'npx registry E401/E404, the Node floor, no free Metro port',
      separator: '--- ENVIRONMENT ---',
      body: () => `"npm error code E401 / E404" while \`npx\` resolves the stim package
  The repo probably pins a private registry in \`.npmrc\`, so \`npx\` looked for
  the package there instead of on npm. Use the public registry for this command:

    npx --registry=https://registry.npmjs.org stim <command>

  A line such as \`npm warn exec ... will be installed\` is normal when using
  the no-install form.

"Unsupported engine" from npm, or a syntax error before Stim starts
  Stim requires Node 22.12.0 or later. Stim itself refuses an older Node
  with STIM_NODE_UNSUPPORTED; see that section.


"Found no free Metro port between ..."
  200 consecutive ports are claimed or occupied. \`stim status\` shows what
  Stim knows about; the rest is other software.`,
    },
    sandbox: {
      summary: 'running under a sandboxing harness: EPERM under STIM_HOME, the stimd socket, CoreSimulatorService, adb',
      body: () => `RUNNING UNDER A SANDBOX

  An agent harness that sandboxes shell commands typically permits writes
  inside the project and blocks the rest. Four things Stim needs sit outside
  that boundary, and only the second failure names the sandbox:

    EPERM: operation not permitted, mkdir '<STIM_HOME>/workspaces/...'
      writes to STIM_HOME (~/.stim unless set)

    STIM_SANDBOX_BLOCKED: <STIM_HOME>/run/stimd.sock is outside this
    sandbox's allowance; run Stim outside the sandbox or see stim guide errors sandbox
      stimd's socket, which start, ios, android, web, macos and revive
      connect to or bind (see that code's entry)

    CoreSimulatorService connection became invalid   (macOS)
    Unable to locate device set: ... Code=61 "Connection refused"
      the simulator service simctl talks to over XPC

    ADB server didn't ACK
    could not install *smartsocket* listener: Operation not permitted
      the adb server socket on tcp:5037

  Measured on Claude Code and on Codex: the first, third and fourth fail the same way in both,
  so this is the shape of the problem, not one harness's quirk. Codex also
  blocks network egress by default, which breaks a cache lookup and a fetch.

  \`stim doctor\` names this when a write to STIM_HOME or a connection to
  stimd's socket actually fails, not merely when a harness that can sandbox
  is present. \`stim doctor --fix\`
  writes only when the report shows that finding, and only what the finding
  names: the four keys, into .claude/settings.local.json, the per-user file,
  merging with what is there. A report without the finding, with or without
  --platform, leaves that file alone. It refuses under Codex, which
  has no per-path allowance to add, and refuses any settings file it cannot
  parse rather than replace it: comments make one unparseable here even though
  Claude Code accepts them. Claude Code reads project settings from the
  directory a session starts in, so in a monorepo the file has to sit at that
  root to count, and a file written inside a worktree goes when the worktree
  does.

  Two ways out, and choosing at the start of a session beats discovering it
  four failures in. Either run Stim with the harness's sandbox disabled, or
  allow the four. In Claude Code that is settings.json:

    sandbox.filesystem.allowWrite     ["~/.stim"]
    sandbox.network.allowMachLookup   ["com.apple.coresimulator.*"]
    sandbox.network.allowUnixSockets  ["<STIM_HOME>/run/stimd.sock"]
    sandbox.network.allowLocalBinding true

  The socket entry is the absolute path stim doctor prints; when that path is
  longer than the platform's socket limit (103 bytes on macOS) stimd uses
  /tmp/stim-sockets-<uid>/<hash>.sock instead, and doctor writes that one.

  On Linux, Claude Code cannot allow individual Unix sockets through seccomp.
  If the socket is denied, run Stim outside the sandbox; doctor does not
  automatically enable access to every Unix socket.

  In Codex the sandbox is one flag, \`codex -s\`, with no per-path allowance:
  workspace-write still refuses STIM_HOME.

  A git credential helper is often blocked too. It prints \`failed to store\`
  on a fetch that otherwise succeeded, and is safe to ignore.`,
    },
    STIM_CONFIG_CORRUPT: {
      summary: '~/.stim/config.json is not a valid JSON object and Stim never resets it',
      body: () => `STIM_CONFIG_CORRUPT  ("Stim config at <path> is not valid JSON",
                     "... is not a JSON object",
                     "... has a projects that is not an object",
                     "... has a projects entry "<key>" that is not an object")
  Any command can raise it: every command reads ~/.stim/config.json first.
  The file holding every owned-device record will not parse into an object,
  or its projects or repos registry or one of their entries is not an object
  (a bare [], null or number counts as corrupt, not empty), and Stim never
  resets it for you -- a silent reset would orphan every simulator it names.
  Repair the file, or move it aside (\`mv <path> <path>.broken\`) and accept
  that the devices it recorded become orphans you delete by hand.`,
    },
    STIM_RELATIVE_PATH: {
      summary: 'STIM_HOME, STIM_BUILD_CACHE, STIM_METRO_CACHE or STIM_ENGINE_ROOT is set to a relative path',
      body: () => `STIM_RELATIVE_PATH  ("<NAME>=<value> is not an absolute path")
  Any command refuses before it reads or writes state. A relative value would
  resolve against each process's working directory, so the CLI, Metro and the
  Expo build-cache provider would each use a different store. Set the named
  variable to an absolute path, or unset it to use the default. Metro and the
  cache provider, which cannot refuse, ignore a relative value with a warning.`,
    },
    STIM_ENGINE_BUSY: {
      summary: 'another stim process is changing the machine engine',
      body: () => `STIM_ENGINE_BUSY  ("Another process is changing <root>.")
  A stim engine command found the engine store's promotion lock held: another
  install, update, rollback or promotion is running. Run the command again
  when it ends.`,
    },
    STIM_ENGINE_REFUSED: {
      summary: 'a stim engine command cannot move the engine as asked',
      body: () => `STIM_ENGINE_REFUSED  ("<reason> <remedy>")
  The engine stays where it is. The message names why (no engine installed,
  no previous build, a development tree, a build that predates the engine
  store) and the command that gets past it, such as stim engine install or
  stim engine use <version>.`,
    },
    STIM_ENGINE_UNAVAILABLE: {
      summary: 'the machine engine cannot load, so this copy of stim ran instead and refuses to start work',
      body: () => `STIM_ENGINE_UNAVAILABLE  ("the engine <version> cannot load ...")
  The router could not load the engine's build (the line above names the
  error) and ran the copy you invoked. start, ios, android, web, macos, revive
  and gc refuse there, since they would run beside the engine's stimd on
  another build; other commands run. Repair the pointer with this copy, as
  the remedy names: npx stim@<this version> engine rollback, or
  npx stim@<this version> engine use <this version>.`,
    },
    STIM_DAEMON_UNAVAILABLE: {
      summary: 'an attached Stim daemon, or a stimd of another build, could not admit or serve the command',
      body: () => `STIM_DAEMON_UNAVAILABLE
  An attached daemon may still be starting, ending, or serving a different
  build. Wait for its owning command to finish and retry, or use a separate
  STIM_HOME. After startup times out or is cancelled, Stim allows up to 10
  seconds for cleanup before forcing the daemon to exit. If startup still
  fails, run stim doctor or run outside the sandbox.
  stim share also answers it when this home's stimd runs another Stim build
  and no stimd of this build replaced it. The message names that build and
  pid: wait for the commands it serves when it restarts on this build, run
  the command with that build, or stop that stimd with kill <pid> so the
  next command starts one of this build.`,
    },
    STIM_CI_ATTACHED_HOME: {
      summary: 'another command owns this home’s attached daemon',
      body: () => `STIM_CI_ATTACHED_HOME
  A concurrent CI job cannot share a daemon tied to another command's lifetime.
  Use a separate STIM_HOME for each concurrent CI job.`,
    },
    STIM_ENGINE_HOST_UNAVAILABLE: {
      summary: 'the selected engine predates attached CI hosting',
      body: () => `STIM_ENGINE_HOST_UNAVAILABLE
  The selected machine engine cannot host the daemon for stim ci run.
  Run stim engine update to select an engine that supports attached hosting.`,
    },
    STIM_SANDBOX_BLOCKED: {
      summary: "a sandbox denies stimd's socket, so the command can neither reach nor host stimd",
      body: () => `STIM_SANDBOX_BLOCKED  ("<STIM_HOME>/run/stimd.sock is outside this sandbox's
                       allowance; run Stim outside the sandbox or see stim guide errors sandbox")
  start, ios, android, web, macos and revive run under this home's stimd.
  They start it detached; when a detached start has not bound within 2 s
  (a harness that blocks launchd, systemd-run or detached children), the
  command runs stimd as its own child for its lifetime instead, and after the
  command ends that stimd waits up to daemon.attachedExitWaitSeconds (120)
  for other commands still using it, then writes run/stimd-journal.json and
  exits; the next command starts or hosts the next one. The refusal comes
  only when the sandbox itself denies the socket (EPERM or EACCES): a stimd
  started outside the sandbox holds the home and this command may not
  connect, the attached stimd may not bind, or its engine store lock is denied.
  If the attached daemon cannot start or admit the command, it refuses with
  STIM_DAEMON_UNAVAILABLE instead.
  On macOS, run stim doctor --fix inside Claude Code, then restart the session.
  On Linux, a path-specific socket allowance is unsupported; run the command
  outside the sandbox. status, logs, reload, doctor and other read commands
  keep working inside the sandbox.`,
    },
    STIM_ENGINE_SWITCHED: {
      summary: 'the machine engine switched to a newer build while this run waited',
      body: () => `STIM_ENGINE_SWITCHED  ("Stim updated to <version>; rerun")
  A build waiting at its build slot, stim logs --follow and stim status
  --watch end when the engine switches builds under them; the CLI prints the
  quoted line and exits 75. While a newer build is staged, a cache miss waits
  at its build slot for up to 10 minutes so running builds can finish. When the
  current engine is retained by an attached host, CI job or active native log
  stream, builds skip that wait.
  Rerun the same command: it runs the new build.`,
    },
    STIM_ROUTER_TOO_OLD: {
      summary: 'this copy of stim cannot read the engine pointer a newer stim wrote',
      body: () => `STIM_ROUTER_TOO_OLD  ("this stim (<version>) cannot read engine format <n>")
  The machine engine's current.json has a format this copy does not know, so
  it refuses instead of guessing. Run a newer copy: npx stim@latest, npm i -D
  stim@latest in the project, or npm i -g stim@latest.`,
    },
    STIM_SCHEMA_NEWER: {
      summary: 'a newer stim migrated this Stim home to a schema this build cannot read',
      body: () => `STIM_SCHEMA_NEWER  ("home <dir> was migrated to schema <n> by <version>")
  A newer build moved the home's state forward and saved the files it changed
  under backup/schema-<n>. Run stim engine rollback --restore-state to put
  them back, or stim engine update to run a build that reads the new schema.`,
    },
    STIM_RUN_FAILED: {
      summary: 'a programmatic operation failed without a more specific Stim code',
      body: () => `STIM_RUN_FAILED  (programmatic API)
  The underlying operation threw an error without a specific code. Its
  message and workspace log path are preserved in StimError. Read diagnostics()
  and call stop() in cleanup, including after a partial run. If the error is
  unexpected, report its message and logs at github.com/appandflow/stim/issues.`,
    },
    STIM_NODE_UNSUPPORTED: {
      summary: 'stim or stim-server started on a Node older than 22.12.0, often a project pin',
      body: () => `STIM_NODE_UNSUPPORTED  ("Stim needs Node <floor> or later; this is Node <version> at <path>")
  stim and stim-server refuse before loading anything else when the Node that
  runs them is older than their engines floor. Both start through
  \`#!/usr/bin/env node\`, so the working directory can choose that Node: asdf,
  mise and Volta's node shim follow the project's .nvmrc, .node-version,
  .tool-versions or package.json, and nvm and fnm do when a shell hook
  switches versions on cd. A Stim installed with Volta keeps the Node it was
  installed with. Run Stim with a supported Node for that one command:

    ASDF_NODEJS_VERSION=<version> stim <command>
    mise exec node@<version> -- stim <command>
    volta run --node <version> stim <command>
    fnm exec --using=<version> stim <command>
    nvm exec --silent <version> stim <command>

  <version> is 22.12.0 or later. asdf, mise, fnm and nvm keep global packages
  per Node version, so when Stim was installed with npm under one of them, use
  the version it was installed with; asdf names it when it prints "No version
  is set for command stim" instead of running Stim. When that version is
  older than 22.12.0, first install Stim with npm under a supported version.
  The tools Stim starts inherit the override.`,
    },
  },
};

export default errors;
