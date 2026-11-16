import type { GuideTopic } from './types.ts';

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + cost));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

const words = (code: string): string[] => code.split('_').filter(Boolean);

function oneWordApart(a: string, b: string): boolean {
  const [short, long] = words(a).length <= words(b).length ? [words(a), words(b)] : [words(b), words(a)];
  return (
    long.length - short.length === 1 && long.some((_word, at) => long.toSpliced(at, 1).join('_') === short.join('_'))
  );
}

function absentSectionLine(name: string, known: string[]): string | null {
  if (!/^STIM_[A-Z0-9_]+$/.test(name)) return null;
  const line = `${name} has no guide section. Follow the remedy the command printed.`;
  const close = known.filter(
    (each) => each.startsWith('STIM_') && (editDistance(name, each) <= 2 || oneWordApart(name, each)),
  );
  return close.length ? `${line}\nDid you mean ${close.join(', ')}?` : line;
}

// @ref LLP 0026#a-refusal-prints-what-the-agent-does-next -- a section stays until the remedy at every emitting site carries its action
const errors: GuideTopic = {
  summary: 'Recovery procedures for refusals whose printed remedy does not settle them, one section for each',
  sectionHint: '<CODE>',
  absentSection: absentSectionLine,
  preamble: () => `RECOVERY PROCEDURES

A refusal prints its code, a message and a remedy. Follow the remedy. A section
below covers a refusal whose remedy is missing or does not settle it. Branch on
the code, never on the message.`,
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
  is only full or loaded (that wait ends with STIM_AT_CAPACITY).
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
    STIM_PREBUILD_FAILED: {
      separator: '--- BUILD-PATH CODES (`stim ios` / `stim android`) ---',
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
  start, ios and android also refuse with this code when \`gc\`
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
  the messages and the remedy.`,
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
  \`gc --pressure critical\` does for every shared cache, and fails the build. It
  does not retry. RUN THE SAME COMMAND AGAIN: that build starts with an empty
  cache, so it is a cold one. The emptying is recorded in the cleanup log (stim logs --source gc).
  Every iOS build that compiles with the cache holds a shared claim on it,
  <cache>.claims beside the cache directory, while xcodebuild runs. Stim
  empties the cache only under that set's exclusive claim, here, in gc and in
  maintenance. When another build holds it or its claim is unresolved, Stim
  leaves the cache alone, because that build may be using it, and the message
  says so. Once nothing else is building, run the same command again: Stim
  empties the damaged cache itself when the compiler reports it corrupt.
  A build on a build worker gets the same handling on the worker, which
  empties its own cache for that client. With --remote-build <machine> the
  build fails with this code and the worker's message; otherwise it falls
  back to building here, and the fallback line names this code. Xcode builds
  run outside Stim take no claim, so a cache they share is not guarded.`,
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
  The stimd answer to a stop carries it when this workspace's Metro claim is
  unresolved, because Stim cannot tell whether that dev server still runs.
  \`stim stop\` prints that answer's message and remedy (the port check to
  run, then the removal of that claim) as a failed Metro stop, without the code.
  An acting \`stim gc\` takes the same exclusive maintenance claim as the
  stim-daemon's maintenance pass. While one holds it the other refuses at once
  with this code, naming the holder (pid, start, trigger); retry after it
  ends. \`gc --dry-run\` takes no claim.
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
A worker listens on its tailnet address only after a pairing, an approval, its
setup route or a request forwarded by tailscale serve reached it; when an
unreachable worker had none of these, run stim serve --tailnet on it once.
--tailnet is remembered in STIM_HOME/server/tailnet.json on the worker, refuses
with --loopback-only or --share (STIM_BAD_ARG), and warns when Tailscale is not
installed or not running. To undo it, delete that file and restart the server;
a start that finds a pairing or an approved client writes it again.
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
  it started has stopped, typically on a machine under heavy load. A child whose
  identity could not be captured is sent SIGKILL first on POSIX, to the child
  only; whatever still runs is left untouched. The remedy tells you what to check and which command to run
  again, and when the run held ownership claims it lists the exact \`rm\`
  command for each retained claim.
  When a Metro, tunnel, maintenance child or server worker cannot be verified
  stopped, Stim retains only the claim that guards that child's work. When the
  child is identified, that claim records it and frees itself once the child's
  process group has exited; otherwise it records an unknown child and waits
  for you. stimd's home, daemon and engine claims are never kept for a child:
  once that stimd is gone, the next one starts. Engine cleanup keeps every
  build that a running process's command line or working directory is in. A
  child of a detached stimd that names itself does not stop that stimd, for up
  to 8 such children at once: it logs daemon_cleanup_unverified, stays running
  and releases what that child held once the child has stopped. stim status and
  stim doctor list each such child with its remedy while the daemon waits;
  stopping that stimd is safe, and the next command starts a new one. An attached
  stimd still ends. A stimd that
  cannot start names every unresolved home, daemon and engine claim at once,
  with the Stim home that holds each.
  A physical iPhone console's helper that stimd cannot take over or verify
  stopped keeps the stream's claim the same way. stimd logs why once, with
  the claim path, tries the takeover again every second and does not exit
  while it waits. \`stim status\` and \`stim doctor\` report the unresolved console
  claim and its remedy. \`stim stop\` prints this code with the commands that list
  and stop what can still be the console's, then the claim's remove command.
  On Windows, the leader's exit alone does not prove its descendants stopped;
  verify the process tree before removing the listed claims.
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
  diagnosis. See \`stim guide lifecycle simslim\` for recovery and the slim
  simulator defaults.
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
    unverified: {
      separator: '--- iOS DEVICE DEBUG REACHABILITY CODES (`ios --device` in Debug) ---',
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
  run \`npx stim gc --dry-run\` to inspect orphaned owned AVDs, then \`npx stim gc\`
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
  \`gc\`) and run \`stim ios\` again to create the requested model,
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
    STIM_DEVICE_TOOL_FAILED: {
      summary: 'simctl or adb failed, or the device did not report the change afterwards',
      body: () => `STIM_DEVICE_TOOL_FAILED
  The tool call exited non-zero or timed out, with its output in the message, or
  the read-back after an Android permission or network change did not show the
  requested state. For a permission, the app must declare the permission in its
  manifest; when it declares none of the service's permissions the call refuses
  with this code. Check the device with \`stim status\` and retry.`,
    },
    STIM_REMOTE_METRO_UNREACHABLE: {
      separator: '--- REMOTE-DEVICE CODES (`ios --remote <proxy|eas>` / `android --remote <proxy|eas>`) ---',
      summary: 'a remote start could not create its managed tunnel or tell the device where Metro is',
      body: () => `STIM_REMOTE_METRO_UNREACHABLE
  A remote start could not create its selected managed tunnel, or the device
  could not be told where Metro is. Set metro.tunnel, or use
  metro.publicUrl for an existing endpoint. A Re.Pack app (repack-child,
  \`guide metro\`) refuses with this code on a --remote, tunnel or hosted run,
  because Re.Pack writes its localhost origin into the bundle's asset and chunk
  URLs: run it on a local simulator or emulator, or set metro.command.`,
    },
    STIM_SHARE_REFUSED: {
      separator: '--- SHARE CODES (`stim share`) ---',
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
    STIM_WEB_NO_URL: {
      separator: '--- WEB CODES (`stim web`) ---',
      summary: 'not an Expo app and web.url is unset, so Stim does not know which page to open',
      body: () => `STIM_WEB_NO_URL
  Only Expo serves web from Metro, so for any other app Stim needs web.url.
  stim web never starts a web server, for any framework. Start yours on a
  named port and point web.url at it:
    pnpm exec vite --port "$(stim ports get web)" --strictPort
    stim settings set web.url 'http://localhost:{port:web}/' --scope workspace
  See stim guide web.`,
    },
    STIM_REMOTE_START_REQUIRED: {
      separator: '--- DEV-SERVER CODES (`stim start`) ---',
      summary: 'a running server cannot gain a remote tunnel; stop, then start --remote, or metro.publicUrl',
      body: () => `STIM_REMOTE_START_REQUIRED
  A healthy bare or Expo server was started without its required remote
  tunnel. A running server cannot gain that option. For a Stim supervisor,
  run \`stim stop\`, then \`stim start --remote\`. For an external server,
  configure metro.publicUrl or let Stim supervise the server.`,
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
  \`gc --pressure <level>\` refuses with STIM_BAD_ARG when the level is not
  normal, high or critical. \`stim settings
  set\` and \`get\` refuse a removed setting as an unknown one, and
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
    STIM_REPORT_TIMEOUT: {
      separator: '--- COORDINATION CODES (any command that shares a resource) ---',
      summary: 'An in-process report or lifecycle operation exceeded its execution budget',
      body: () => `STIM_REPORT_TIMEOUT

An API operation exceeded its execution budget: 90 minutes for warmWorktree(),
60 seconds for doctor(), previewGarbage(), collectGarbage(), reload(), plan() and removeWorktree().
Stim attempts only that operation's cleanup before rejecting, with a 35 second
cleanup budget. Unfinished cleanup returns STIM_CLAIM_UNAVAILABLE instead.
Other clients are unaffected. Retry after the machine is less busy, or narrow
the report with doctor({ platform }) or previewGarbage({ pressure }). doctor() and previewGarbage() remain
read-only. collectGarbage() can mutate resources; completed actions remain applied.
Inspect what remains with previewGarbage() before retrying a mutation.
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
  build tool, hosted app delivery or launch readiness wait to stop;
  those exits print no payload. Run the same command again when you want the
  app on a device.`,
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
  process yourself, then re-run the command or \`gc\`. Windows has
  no process-table check and Stim signals nothing there: it waits for the pid
  in the AVD's process lock after \`adb emu kill\`, and refuses at once when
  adb cannot reach the emulator.`,
    },
    remove: {
      summary: 'worktree remove refused a dirty tree: what it restores itself and what --force discards',
      body: () => `"Refusing to remove <path>: uncommitted changes / untracked files / commits
not on any remote"  (worktree remove)
  A native build rewrites tracked files, and Stim RESTORES the one class it can
  prove is not work: a modified \`<app>/ios/Podfile.lock\` (tracked and
  unstaged) whose text \`ios/Pods/Manifest.lock\`, the copy \`pod install\` makes,
  holds too, or that is unchanged since gc deleted \`ios/Pods\` while the two
  matched. When the only dirt left is such a lock, \`worktree remove\` runs the
  checkout itself and says so. Known hole: a deliberate \`pod update\` (or a
  hand-resolved lock) followed by an install leaves the same evidence, so
  commit it before removing or it is restored as churn. Stim cannot tell what
  \`pod install\` changed in \`*.xcodeproj/project.pbxproj\` from a hand edit,
  so that file, and a lock without the evidence, count as uncommitted work.
  ONE other dirty path and the whole set is refused, so this never eats real
  work.
  A tracked file marked assume-unchanged, or skip-worktree with the file on
  disk, hides edits from git status, so \`worktree remove\` refuses and names
  it with the command that shows the edit:
  \`git -C <worktree> update-index --no-skip-worktree <file>\` (or
  \`--no-assume-unchanged\`), then commit or discard it; \`--force\` is the last
  resort. Files a sparse checkout leaves out are absent from disk and do not
  count.
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

"carry       left out <app>/target: <reason>"
  The app is an Exact app (exact.mjs sits beside target/). Exact refuses a
  Cargo target/ that was built in another checkout and fails every build
  until it is deleted, so warm does not copy it. The first build in this
  worktree compiles its own target/ from scratch, which takes minutes.
  Nothing to fix.

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
    STIM_RUN_FAILED: {
      summary: 'a programmatic operation failed without a more specific Stim code',
      body: () => `STIM_RUN_FAILED  (programmatic API)
  The underlying operation threw an error without a specific code. Its
  message and workspace log path are preserved in StimError. Read diagnostics()
  and call stop() in cleanup, including after a partial run. If the error is
  unexpected, report its message and logs at github.com/appandflow/stim/issues.`,
    },
    ci: {
      summary: 'the codes stim ci run and stim ci build report in failure, cleanup.error and diagnostics.error',
      separator: '--- STIM CI RESULTS ---',
      aliases: [
        'STIM_CI_SETUP_FAILED',
        'STIM_CI_TEST_FAILED',
        'STIM_CI_BUILD_FAILED',
        'STIM_CI_ARTIFACT_FAILED',
        'STIM_CI_TIMEOUT',
        'STIM_CI_CANCELLED',
        'STIM_CI_CLEANUP_FAILED',
        'STIM_CI_DIAGNOSTICS_FAILED',
        'STIM_CI_REPORT_FAILED',
      ],
      body: () => `STIM_CI_SETUP_FAILED       run failed before its test command started, or
                           failed with no test command given
STIM_CI_TEST_FAILED        the test command exited nonzero or was killed, or
                           the run failed after it with a test command given
STIM_CI_BUILD_FAILED       ci build could not build the app
STIM_CI_ARTIFACT_FAILED    ci build built the app but could not pack or copy it
STIM_CI_TIMEOUT            the job exceeded its timeout; exit code 124
STIM_CI_CANCELLED          the job was cancelled; exit code 130
STIM_CI_CLEANUP_FAILED     the workspace, attached daemon or engine claim could
                           not be released (cleanup.error)
STIM_CI_DIAGNOSTICS_FAILED the logs could not be read or copied (diagnostics.error)
STIM_CI_REPORT_FAILED      an onProgress callback or the result file write failed
                           (reportingError); it never interrupts cleanup
  An error that carries its own STIM_ code keeps it. A cleanup or reporting
  error becomes the failure only when the job would otherwise succeed. Read
  result.json and diagnostics.json from --artifacts; stim guide lifecycle
  describes stim ci.`,
    },
    'server-actions': {
      summary: 'the codes stim-server reports for start, stop, reload, gc, doctor and worktree actions',
      aliases: [
        'STIM_ACTION_BUSY',
        'STIM_OUTPUT_LIMIT',
        'STIM_METRO_START_FAILED',
        'STIM_RELOAD_TIMEOUT',
        'STIM_GC_TIMEOUT',
        'STIM_GC_FAILED',
        'STIM_DOCTOR_REPAIR_FAILED',
        'STIM_WORKTREE_WARM_TIMEOUT',
        'STIM_WORKTREE_WARM_FAILED',
        'STIM_WORKTREE_REMOVE_TIMEOUT',
        'STIM_WORKTREE_REMOVE_FAILED',
      ],
      body: () => `STIM_ACTION_BUSY              another action already runs in that workspace
STIM_OUTPUT_LIMIT             the action printed more output than the server keeps
STIM_METRO_START_FAILED       start failed without a more specific code
STIM_RELOAD_TIMEOUT           reload did not finish within the action's limit
STIM_GC_TIMEOUT               a gc action did not finish within its limit
STIM_GC_FAILED                gc reported failures
STIM_DOCTOR_REPAIR_FAILED     doctor repairs reported refusals
STIM_WORKTREE_WARM_TIMEOUT, STIM_WORKTREE_REMOVE_TIMEOUT
                              worktree warm or remove did not finish in time
STIM_WORKTREE_WARM_FAILED, STIM_WORKTREE_REMOVE_FAILED
                              worktree warm or remove reported failures
  stim-server runs these actions for a connected client such as Stim Desktop.
  Wait for a running action before retrying, or run the matching stim command
  in the workspace to see its full output.`,
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
