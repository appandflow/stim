import { RECENT_LAUNCH_MS } from '../status.ts';
import type { GuideTopic } from './types.ts';

const facts: GuideTopic = {
  summary:
    'The --json payloads: `start`, `ios`, `android`, `web`, `ios|android --plan`, `reload`, `stop`, `status`, `doctor`, `device lock`/`unlock`, `gc`, and the error contract',
  preamble: () => `SLOTS
Named ios/android runs add slot to their JSON facts. Default-run fields remain
compatible. status adds a slots array per environment with each named slot's
ios/android device facts; top-level ios/android still describe default.
Named collector, lease-holder, and launch keys use platform:slot internally.

FACTS CONTRACT

\`start\`, \`ios\`, \`android\`, \`web\`, \`reload\`, \`stop\`, \`status\`, \`stats\`, \`doctor\`,
\`gc\`, and \`device lock\`/\`device unlock\` each print exactly ONE line of JSON on
stdout for \`--json\`. Every other line goes to stderr, so it is always safe
to pipe. \`logs --json\` is the one exception: it is NDJSON, one record per
line by design (see \`guide logs\`), not this single-payload contract.

status's unprovisionedWorktrees lists the linked worktrees with no Stim
environment in every repository with a registered environment, plus the
repository status runs from. A worktree counts as having an
environment when one is registered at it or inside it. Each entry is
{ path, branch, repository, git }; repository is the main checkout, or the git
directory of a bare repository. status lists worktrees from git's own worktree
records, and on macOS runs no git in a worktree with no environment under a
protected folder such as ~/Documents, so listing it raises no privacy prompt.
\`worktree warm\` registers the app it prepares, before it copies: the
nearest React Native or Expo app above where it runs when that is below the
worktree root; else the one app the source checkout has registered, at the
same path in this worktree; else the worktree root when it is the app. A warm
that finds none registers nothing and says so on stderr, and \`start\`, \`ios\`,
\`android\` and \`doctor\` register the app later. An environment's worktree is the linked worktree it is
registered at or inside.

Each worktree entry, in unprovisionedWorktrees and in an environment's
worktree, carries git:

  git          { changed, untracked, upstream, ahead, behind, mergedInto }, or
               null when git fails or does not answer within 3 s, or the
               worktree has no environment and sits in ~/Desktop, ~/Documents,
               ~/Downloads, iCloud Drive, ~/Library/CloudStorage or /Volumes,
               which status does not open on macOS
  changed      tracked paths with staged or unstaged changes, conflicts included
  untracked    untracked entries as git status lists them; a new directory
               counts once
  upstream     the branch's upstream, such as "origin/feat/x", or null
  ahead        commits on HEAD and not on upstream; null with no upstream, or
  behind       when the upstream branch no longer exists
  mergedInto   "origin/<default>" when gc would call the branch merged, judged
               from local refs without fetching, else null

status runs \`git status --porcelain=v2 --branch\` in every worktree in
parallel, and caches the merge verdict by HEAD and default-branch commit
under $STIM_HOME/git-merge. One call starts no new merge check 250 ms after
its first; later calls judge the rest, and until then a verdict for the same
HEAD at an older default-branch commit stands in; a check that timed out
is retried after 5 minutes. \`status --watch\` reuses a worktree's git read
until its index, HEAD, reflog or the branch, upstream or default-branch refs
change, and for at most 60 s, so a file edit, creation or deletion that is
not staged can take up to a minute to show. Plain status prints "git: 2 changed, 1 untracked, ahead 3" under
each environment, and the same after each worktree with no environment.

A worktree entry also carries pullRequest, the GitHub pull request of its
branch and HEAD, once \`status --watch\` has looked it up:

  pullRequest     { number, url, title, state, checks, reviewDecision,
                  checkedAt }, null when GitHub has none for the branch and
                  HEAD, absent when never looked up: gh missing or signed
                  out, no GitHub remote, or status could not read the
                  worktree's git. A later gh failure keeps the last answer.
  state           "open", "draft", "merged" or "closed"
  checks          { passing, failing, pending } counts of the head commit's
                  check runs and commit statuses, or null when it has none
  reviewDecision  "approved", "changes-requested", "review-required" or null
  checkedAt       when Stim last asked GitHub

\`status --watch\` asks GitHub off its refresh path, through the same gh api
graphql lookup gc uses, one call per repository, for a worktree whose lookup
is over 5 minutes old or whose branch or HEAD moved. It runs git in the
repository, never in the worktree. It caches each answer
under $STIM_HOME/pull-requests, which one-shot status only reads, and never
warns when gh is unavailable.

status's remoteDevices lists each environment's recorded EAS Simulator
session. The session is billable while it runs, and it makes the environment
live. status reads only local records; it does not ask EAS whether the session
is still running.

  remoteDevices   [{ platform, backend, sessionId, state, startedAt,
                  webPreviewUrl }], empty when the workspace has none
  backend         "eas"
  state           "claimed"    Stim's ownership ledger holds this workspace's
                               claim, so \`stop\` and \`gc --delete\` can end it
                  "unclaimed"  the ledger has no claim for this workspace;
                               \`stop\` still ends the recorded session
                  "unknown"    the ledger could not be read
  webPreviewUrl   the browser page showing the remote screen, recorded when
                  Stim created the session, or null

Plain status prints one "remote <platform>: EAS session <id> billable" line
per session, with the preview URL.

status's physicalDevices lists each physical phone or tablet the environment
holds an unexpired lease on, from \`ios --device\`, \`android --device\` or
\`device lock\`, in every slot. A run lease ends with its run, so a phone
stays listed after the run only while \`device lock\` holds it. A
simulator or emulator lease is not listed. The field is absent when the
workspace leases no physical device.

  physicalDevices  [{ platform, slot, id, name, model, owned, physical,
                   connection, lease }]
  id               the UDID or adb serial
  name             the device's own name, else the name the lease recorded
  model            devicectl's marketing name ("iPhone 12 Pro"), null when
                   unread, or the Android model the lease recorded
  owned            always false: Stim uses a physical device, never owns it
  physical         always true
  connection       "connected"     devicectl can reach the phone, or adb lists
                                   the serial as device
                   "disconnected"  the tool answered without it
                   "unknown"       the tool could not be read in time
                   status reuses one devicectl or adb listing for 30 s
                   under \`status --watch\`
  lease            { holder, kind, grantedAt, expiresAt }: holder is the
                   workspace path, kind "declared" (device lock) or "run"

Plain status prints "ios: Old iPhone (physical, iPhone 12 Pro) connected --
leased until <time>" for each one.`,
  sections: {
    payloads: {
      summary: 'every field of the start, ios, android, web and reload payloads, the error contract, the device rules',
      body: () => `  stim start --json

  port            the Metro port RESERVED for this workspace
  supervisorPid   the detached supervisor's pid, or NULL when a dev server was
                  already answering that Stim did not start
  mode            "bare-inproc" | "expo-child" | null (see \`guide metro\`)
  logsDir         where the NDJSON timeline is written
  alreadyRunning  true when nothing needed starting
  links           { desktop }: a stim-desktop://workspace?path=<workspace>
                  link that shows this workspace in Stim Desktop. Absent when
                  no app on this Mac opens stim-desktop links. Plain output
                  prints it on stderr as "Open in Stim Desktop: <link>"; so
                  does worktree warm, which has no JSON payload

  stim ios --json

  platform        "ios"
  udid            the owned simulator this workspace installed onto, or the
                  phone's UDID on \`--device\`. A physical device gets no
                  owned-device registry entry; its ID is stored in a temporary
                  lease. \`stop\` releases workspace leases and \`gc --delete\`
                  removes expired lease files
  deviceName      its name, or null
  deviceType      the owned simulator's MODEL, as
                  \`xcrun simctl list devicetypes\` names it ("iPad Pro 13-inch
                  (M5)"). Read from the simulator itself, so a run driven by
                  the ios.deviceType setting reports it too, not only a
                  \`--device-type\` run. Null on \`--device\` and on a
                  simulator Stim does not own
  runtime         that simulator's iOS runtime version ("26.5"), from the same
                  record. Null on the same paths as deviceType
  fingerprint     the @expo/fingerprint hash of the native inputs, AS STORED.
                  A run that had to \`expo prebuild\` or \`pod install\`
                  rewrote fingerprinted files while it worked (the generated
                  native directory, package.json's scripts, the app config,
                  Podfile.lock), so the hash it looked up is not the hash the
                  tree has afterwards. The artifact is stored under the hash
                  computed AFTER those steps -- the one the next run in this
                  tree computes -- and this field reports that one. The shift
                  is printed on stderr as one dim line naming both short
                  hashes. A prebuild shift is RE-LOOKED-UP before anything
                  compiles (\`cache
                  hit 6564e2.. (post-prebuild key)\`), so a cold tree -- a
                  fresh worktree or clone of a CNG app -- installs an entry
                  another workspace already built instead of compiling
                  beside it. Both platforms fingerprint again after the
                  compile because Gradle plugins can rewrite native inputs
                  while they build; a change under node_modules/ or the
                  native directory stores the artifact only under that
                  post-build hash. A stable fingerprint prints no shift line.
                  If any other input changed while the build ran (the app
                  config or a config plugin since the first lookup, other
                  than the bundle id or package prebuild adds, or any
                  other source during the compile), or a fingerprint after
                  prebuild, pod install or the compile cannot be computed,
                  the build is installed but not cached, and fingerprint and
                  cacheKey are null
  configuration   the Xcode configuration that was built ("Release" from
                  --configuration or the ios.configuration setting); null for
                  the default Debug
  scheme          the explicit shared Xcode scheme selected by --scheme;
                  absent for automatic selection; not the app URL scheme
  cacheKey        the shared-build-cache key derived from it (the
                  configuration is part of it: -release-sim vs
                  -debug-sim-arm64). A single-architecture simulator build
                  ends in its architecture (-arm64 or -x86-64): a local Debug
                  build compiles this Mac's, a --remote build the remote
                  host's. A local non-Debug simulator build compiles every
                  architecture the project lists and has no suffix
  With --eas-profile, fingerprint is computed by EAS CLI using the selected
  profile/environment, and cacheKey identifies the EAS project and build ID
  separately from local native builds. cacheHit is "remote" for the EAS
  source, including when EAS CLI reuses its own downloaded artifact cache.

  cacheHit        WHICH LEVEL answered, not a boolean:
                    "local"   this machine's shared cache (free, instant)
                    "remote"  the project's own Expo buildCacheProvider (a
                              download; it is copied into the local cache on
                              the way past, so the next workspace is "local")
                    false     nothing answered, so it was compiled
  webPreviewUrl   only on a remote device that has one (an EAS Simulator
                  session): a browser URL showing that device's screen. Absent
                  on a local device. Hand it to the human -- it is the only way
                  to see a device that is not on this machine. Never open it ON
                  the device; it is a page, not a deep link.
  cacheSkipped    true only when --no-build-cache was passed: "nothing was
                  looked up", which is a different fact from "nothing was found"
  offloadedTo     only on an app a build machine compiled: its
                  offload.machines entry (see \`guide settings\`). cacheHit is
                  false for it. The Android payload carries it too
  offloadFallback only on an app compiled here after the run considered
                  offloading it: why it built here -- one reason per
                  machine when none took the build, or why the offload
                  stopped. The Android payload carries it too
  compilationCache
                  Xcode compilation-cache activity for a compiled iOS app:
                    { status: "reported", hits, cacheableTasks, hitRatePercent }
                  status is "not-run" when the artifact cache supplied the app.
                  status is "unavailable" when Xcode did not print reliable
                  statistics. This field is separate from cacheHit
  waitedForBuild  { pid, ms } when ANOTHER workspace was already compiling this
                  exact fingerprint and this run waited for its artifact instead
                  of compiling a second copy
                  (see \`guide lifecycle concurrency\`); null when nothing was
                  waited for.
                  cacheHit is "local" either way -- the artifact did come from
                  the local cache -- so this is what separates "it was already
                  there" (free) from "it was there twelve minutes later" (still
                  cheaper than a second build). Both commands carry it
  appPath         the .app that was installed
  bundleId        the iOS bundle id that was launched
  installSkipped  true when the artifact was ALREADY on the device byte for
                  byte, so nothing was installed and the run went straight to
                  launch (see \`guide lifecycle builds\`). false means an
                  install ran.
                  Always false on \`--device\`: proving a phone already holds
                  the bundle would cost more than installing it
  launched        true, "bundling", or "unverified". THE THREE ARE DIFFERENT
                  FACTS and only the last one is a problem.
                    true         Metro finished the bundle response, then the app stayed
                                 alive through a three-second stability window.
                                 The command checks process liveness when the
                                 platform exposes it. Errors from that window
                                 are printed even when the app stays alive,
                                 EXCEPT the device log's, which is COUNTED into
                                 one \`launch\` line instead (see
                                 \`guide logs\`). The agent decides whether a
                                 nonfatal error matters.
                                 IT IS NOT A PAINTED SCREEN. Stim observes the
                                 bundle and the process, never a frame, and a
                                 cold app can keep rendering for a minute or
                                 more after this, which is why the stderr line
                                 reads \`bundle loaded, process alive, stable
                                 for 3s -- the first screen may still be
                                 rendering\`. Poll the UI before you trust a
                                 screenshot. Optional app-declared readiness
                                 adds a separate stderr readiness phase; it
                                 does not change this field. See
                                 \`guide lifecycle readiness\`
                    "bundling"   the request DID arrive and Metro was still
                                 building or delivering when the bundle timeout closed.
                                 The wiring is proven; the JS has simply not
                                 run yet (a cold bundle of ~10k modules takes
                                 longer than the window). Nothing to do --
                                 no remedy list is printed for it -- and
                                 \`logs --source metro\` shows the build
                                 finishing
                    "unverified" nothing was observed at all: usually a
                                 dev-client server picker awaiting a tap
                  Neither "bundling" nor "unverified" is reported for an app
                  whose process is gone when the bundle timeout closes: the
                  run fails as FATAL, "the app process exited", with the
                  device log's errors. An iOS crash report can land a minute
                  after the crash, so \`logs --errors\` may show the native
                  stack only later
                  See \`guide facts devmenu\` for the dev menu and its button.
  metroPort       the port the app was wired to; NULL on a non-Debug
                  configuration, whose JS is embedded and which is launched
                  with no dev server at all. There, \`launched\` is verified
                  by the app process staying alive after launch (a bad
                  embedded bundle crashes within seconds), not by a bundle
                  request. A process that exits fails the command. An iOS
                  launch with no process id is "unverified", and
                  \`stim logs --errors\` has the device log that says why
  logs            { dir }
  durationMs      wall time for the whole run

  stim android --json

  platform        "android"
  serial          the owned emulator (always "emulator-<consolePort>")
  avdName         the AVD's NAME (stim-<label>). The serial is a slot --
                  emulator-5554 is whatever booted into that console port
                  first -- so this is what addresses the emulator in
                  \`emulator -avd\`, avdmanager, or a device tool. The console
                  port is CHOSEN AND RECORDED under the global config lock
                  BEFORE the emulator starts, then passed to it as \`-port\`,
                  so two workspaces booting at the same moment cannot land on
                  one serial. A boot that fails releases the port again and
                  keeps the AVD recorded for \`gc\`
  deviceName      the same name, matching the iOS payload's field
  systemImage     the sdkmanager package id the owned AVD was created from
                  ("system-images;android-36;google_apis;arm64-v8a"), read from
                  the AVD's own config.ini, so a run driven by the
                  android.systemImage setting reports it too, not only a
                  \`--system-image\` run. Null on \`--device\` and on an
                  emulator Stim does not own
  deviceProfile   the avdmanager hardware profile of the owned AVD
                  ("pixel_6", "pixel_fold"), read from its config.ini
                  hw.device.name. Null where systemImage is null, and on an
                  AVD of the old generic profile, which has no hw.device.name
  fingerprint / cacheKey / cacheHit / cacheSkipped / waitedForBuild /
  appPath / installSkipped / launched
                  as above -- cacheKey keys on the VARIANT here
                  (<fingerprint>-productionrelease-sim). A Debug artifact for
                  a proven target ABI also ends in that ABI
                  (<fingerprint>-debug-sim-arm64-v8a)
  variant         the gradle variant that was built ("productionDebug" from
                  --variant or the android.variant setting); null for the
                  default assembleDebug. A variant whose name ENDS IN Release
                  is a release build: its JS is embedded and no dev server is
                  used
  metroPort       the port the app was wired to; NULL on a release-shaped
                  variant, exactly as on a non-Debug iOS configuration.
                  There, \`launched\` is verified by the app PROCESS being
                  alive on the device a moment after launch (\`pidof\`, then
                  \`ps -A\`), not by a bundle request -- "unverified" means
                  no process was found fails the command, and
                  \`stim logs --errors\` has the device log that says why
  bundleId        the ANDROID PACKAGE NAME the launch, the port wiring and
                  the remedies all target -- read from the BUILT APK's
                  manifest, which on a flavored project is the flavor's
                  applicationId, not what the project files say
  debugHttpHost   "127.0.0.1:<port>" on an emulator, "localhost:<port>" on a
                  physical device, when the app's SharedPreferences were
                  pointed at this workspace's Metro; null when they were not.
                  A healthy run reverses only <port> -> <port>, which is what
                  that host resolves to. Only when the write fails does Stim
                  also reverse 8081 -> <port>, so the app's compiled-in
                  default still finds this workspace's Metro
  debugHttpHostNote
                  why the write did not land, when it did not. A launch
                  survives it -- this is the difference between the two
  devClientUrl    the expo-dev-client deep link that was opened, or null for
                  a plain launcher start. This is the command that puts the
                  app back on THIS workspace's bundle
  ccache          the Android C++ compilation cache, the counterpart of the
                  iOS compilationCache field:
                    { status: "reported", hits, misses, hitRatePercent }
                  status is "not-run" when the artifact cache supplied the
                  APK. status is "unavailable" when no C++ compile went
                  through ccache -- ccache absent from PATH, a project that
                  sets its own CMake compiler launcher, or a Gradle run whose
                  native work was all up to date. None of the three is an
                  error, and this field is separate from cacheHit. On an
                  offloaded APK it is the build machine's ccache
  logs            the workspace log directory
  durationMs      wall time for the whole run
  reclaimed       present only when the run was over its disk or memory
                  budget and reclaimed first (\`start\`, \`ios\` and
                  \`android\`, on success and failure alike). One entry per
                  step that acted, in order:
                    { step, targets, failures, freedMb }
                  step is "idle-devices", "idle-dev-servers",
                  "workspace-outputs" or "stale-cache-entries"; targets names
                  the devices, workspaces or caches it acted on; freedMb is the
                  free disk the step added. See \`guide lifecycle budget\`
  devServer       present only when this run started the workspace's dev
                  server because none was running (\`ios\` and \`android\`):
                    { started: true, reason }
                  reason is "not running" or "stopped (idle)" when the
                  supervisor had stopped it after metro.idleStopMinutes
  links           as in start, with &platform= and, for a named slot, &slot=,
                  so Stim Desktop can focus that device

  stim reload [ios|android|web] --json

  Exit 0 and this payload confirm that the reload request was sent. They do
  not prove that new JavaScript loaded or that the screen recovered. The
  command does not observe completion. Verify the expected UI on deviceId
  and inspect stim logs --errors before claiming recovery.

  platform        "ios" | "android" | "web"
  deviceId        the exact owned simulator UDID or emulator serial targeted;
                  for web, the owned Chrome's DevTools endpoint
  deviceName      the owned simulator or AVD name; for web, the Chrome version
  appId           the live bundle id or Android package; for web, the URL the
                  owned page was on when Stim sent the reload
  metroPort       the workspace's verified Metro port; for web, the reserved
                  Metro port or null
  strategy        how the reload was addressed.
                  "metro-websocket" -- Metro named its clients and Stim
                  addressed every peer matching this platform. A workspace
                  Metro serves one app, so those peers are this app on however
                  many devices are attached to that port.
                  "metro-broadcast" -- this Metro cannot name its clients, so
                  the reload went to all of them and Stim cannot confirm appId
                  was among them. Verify the UI on deviceId; if it did not
                  change, reload from the app's own error screen or dev menu
                  "cdp" -- web: Page.reload on the owned Chrome page, sent
                  over a DevTools connection verified to reach that Chrome
  targets         how many peers the reload was addressed to, or null when
                  broadcast. Greater than 1 means several devices are running
                  this app on that Metro and the request addressed all of
                  them, not only deviceId. Completion is not observed
  reverseRestored the Android serials whose adb reverse for metroPort was
                  missing and that Stim re-applied before reloading; [] when
                  none was, and always [] for iOS and web

  stim web --json

  platform        "web"
  browser         "chrome"
  version         the Chrome product, such as "Chrome/153.0.8010.49", or null
  running         true: the owned Chrome answered and holds the page
  pid             the owned Chrome's browser process; null when not running
  supervisorPid   the Stim process holding its DevTools session, or null
  url             the page opened, web.url with its ports filled in
  headless        false only with --headed
  viewport        "desktop" | "phone" (web.viewport)
  profile         the Stim-owned Chrome user data directory
  cdpEndpoint     http://127.0.0.1:<port>, the reserved DevTools endpoint, or
                  null when not running
  targetId        the DevTools target id of the owned page, or null when not
                  running
  reused          true when the running Chrome navigated again instead of
                  starting: same --headed, viewport and certificate options
  launched        true | "bundling" | "unverified" (see \`guide web\`)
  metroPort       the Metro port the page loads from, or null for a web.url
                  that does not use {port:metro}
  logs            { dir }: web.ndjson holds the page records
  durationMs      wall time of the run
  links           as in start, with &platform=web

  stim doctor --json

  project         the resolved app root
  platform        "ios" | "android" | null
  stim            { runningVersion, runningPath, resolved, installations,
                    versions, highestVersion, resolvedIsOlder }
                  resolved is the first executable named stim on PATH;
                  installations contains every distinct real executable on
                  PATH and the version each reports. resolvedIsOlder is true
                  only when that first executable is below the highest version
                  available from this invocation or PATH
  budget          { budget, volumes, memory, plan } or null when a budget
                  setting is invalid. budget echoes minFreeDiskGb,
                  hardFloorDiskGb, maxCommittedMemoryGb and maxLiveWorkspaces;
                  volumes is { volume, freeGb } for the volumes holding the app
                  and $STIM_HOME; memory is { committedGb, liveWorkspaces } or
                  null when off; plan lists what the next start, ios or
                  android would reclaim, in the \`reclaimed\` shape without
                  freedMb, and is empty while under budget
  buildMachines   one { machine, state, dnsName?, deviceId?, requestedAt?,
                  offloadable?, reasons?, problems?, capacity? } per
                  offload.machines entry; state is "approved", "pending", "not-asked",
                  "revoked" (revoked, or the request lapsed), "node-changed",
                  "not-on-tailnet", "tailscale-off", "unreachable" or
                  "invalid". An approved machine also carries offloadable,
                  true when it would take this app's builds now (iOS
                  simulator unless --platform android, Android emulator when
                  --platform android or the app has android/ or uses Expo),
                  and reasons, each reason it would not, prefixed "iOS: " or
                  "Android: " when only one platform has it, with a finding
                  per reason (code build-machine-<reason>: unreachable,
                  checkout, stim-build, arch, xcode, simulator-sdk,
                  cocoapods, runtime, jdk, android-sdk, ndk, build-tools,
                  compile-sdk, disk or busy). problems lists the same
                  reasons as { code, reason } with that code. capacity
                  is the machine's offer: { running, max, diskFreeBytes,
                  minDiskFreeBytes, cpus?, loadPerCore?, builds?, maxBuilds?,
                  maxLoadPerCore?, declined? }; an older stim-server omits the
                  optional fields
  findings        the diagnostic findings; a lower resolved Stim is a
                  costs-time finding with a PATH or installation remedy

ON FAILURE
  \`start\`, \`ios\`, \`android\` and \`web\` all print the error contract instead,
  still one line on stdout, and exit 1:

    { "code": "STIM_METRO_TIMEOUT", "message": "...", "remedy": "..." }

  If a native build returned before the failure, this payload also carries
  \`ccache\` (Android) or \`compilationCache\` (iOS), with the status and
  counters described above. This includes failed builds and later install
  or launch failures. The field is absent when no native build returned.
  \`reclaimed\` is present the same way as on success when the run reclaimed
  before failing, including a STIM_LOW_DISK refusal.

  An \`ios\` or \`android\` run that \`stim stop\` or Ctrl-C interrupted
  reports STIM_CANCELLED and exits 130. A
  run that exits on the interrupt at once (a second SIGINT, a physical-device
  lease, Ctrl-C with no build tool running) exits 130 with no payload.

  \`stop --json\` prints { root, ok, supervisor, collectors, metro, device,
  port, metroTunnel, releasedLeases }. When it cannot end the \`ios\` or
  \`android\` run holding the workspace, it prints the error contract with
  root and ok: false instead, plus device.remote when it ended a recorded EAS
  session first, and exits 1:

    { "root": "...", "ok": false, "code": "STIM_STOP_BLOCKED", "message": "...", "remedy": "..." }

  device.web is present when the workspace had an owned Chrome:
  { status, label: "Chrome", kind?, reason?, remedy? }; kind is null when no
  kind applies. status is "shut-down"
  when Chrome closed (its profile is kept), else "skipped" (its identity could
  not be verified) or "failed", and ok is then false.

  Branch on \`code\`, never on the message text. \`guide errors\` enumerates
  every code.

RULES
  - Never hardcode or guess a udid/serial/port. Read them from the payload.
  - Pass them EXPLICITLY to every device tool you drive yourself
    (agent-device, xcrun simctl, adb -s, idb).
  - Never assume "booted" is your simulator. Other agents have theirs booted
    too.
  - Every device Stim creates or boots is one Stim created, named
    stim-<label> (<model> <runtime>) on iOS. New local device labels combine
    the git worktree directory and app directory names, e.g.
    pr6460-tlon-mobile. Equal names collapse to one; outside git, the app
    directory name is used. An iOS name collision adds the workspace ID
    after the model and runtime, preserving it when the label is truncated.
    Existing owned iOS simulators are renamed on reuse. Android keeps
    existing and adopted AVD names. The exceptions are
    \`android --device\` and
    \`ios --device\`, which use a connected physical device Stim never
    creates, boots, or deletes.`,
    },
    devmenu: {
      summary: 'why the Expo dev menu or Tools button is or is not over the app, per platform and device kind',
      body: () => `  EVERY DEV-CLIENT DEEP LINK CARRIES disableOnboarding=1
  INSIDE ITS PROJECT URL
  (\`...?url=http%3A%2F%2Fhost%3Aport%2F%3FdisableOnboarding%3D1&disableFab=1\`),
  and expo-dev-launcher finishes its own dev-menu ONBOARDING
  when it reads it. That is all the flag does: it sets
  EXDevMenuIsOnboardingFinished. ON iOS it has to sit on the
  PROJECT url -- the value of the \`url\` parameter -- because
  that is the URL the launcher hands to the check; on the
  outer deep link it does nothing there. Android reads it on
  either.
  ON A SIMULATOR, before a local dev-client openurl, Stim
  preapproves CoreSimulatorBridge for exactly the installed
  bundle id and discovered scheme on its owned simulator. That
  suppresses iOS's first-launch confirmation;
  unrelated schemes remain unapproved. The approvals persist
  until the simulator is erased, so Stim records the ones it
  wrote on the workspace's device record and writes only the
  ones missing from it. Parking drops the record, so an
  adopted simulator gets them again once.
  THE DEV MENU AND ITS BUTTON stay off a simulator through
  EXDevMenuShowsAtLaunch=false and
  EXDevMenuShowFloatingActionButton=false in the app's
  defaults, which the onboarding flag does NOT cover. Stim
  writes them whenever it actually installs the app; an
  install skipped as byte-identical keeps the app's data and
  so the values already written. They cover every later
  launch, including a home-screen tap or an agent relaunch.
  When the project's installed expo-dev-launcher (found
  through expo-dev-client, no network) is 58.0.0 or later
  (expo/expo#49651), Stim's own deep link also carries
  \`disableFab=1&disableAutoLaunch=1\` on the outer link and
  on the project url, plus
  \`__expo_disable_fab=1&__expo_disable_auto_launch=1\` on the
  project url, which is the only url \`simctl launch
  --initialUrl\` hands the launcher and the one 58.0.7 reads
  the \`__expo_\` spellings from, for that launch only. So
  device automation opens on the app.
  The \`install     dev client prepared (...)\` line appears
  only when one of those simulator writes ran. The
  unverified warning therefore leads with the picker, then
  prints the openurl
  retry. ON LOCAL ANDROID the same deep link also carries the
  \`EXDevMenuDisableAutoLaunch\` boolean intent extra, which
  the launcher reads to set EXDevMenuShowsAtLaunch=false and
  EXDevMenuIsOnboardingFinished=true. It stops the menu
  opening automatically, but does NOT set expo-dev-menu's
  showFab preference, so its floating Tools button can remain.
  Remote Android opens only the URL, so that intent-extra
  suppression does not apply there.
  Every Stim deep link also carries an outer \`disableFab=1\`
  query parameter. Versions with expo/expo#49651 read it and
  hide the button; earlier versions ignore it. Stim does
  not rewrite expo-dev-menu's private SharedPreferences XML:
  that internal file is not a supported API, and changing it
  would persist over the user's own Tools-button setting. The
  list leads with the supported launch command (\`am start -a
  android.intent.action.VIEW -d '<devClientUrl>'
  --ez EXDevMenuDisableAutoLaunch true\`).
  ON A PHONE NONE OF THAT PREAPPROVAL APPLIES. The
  preapproval and that write both go
  through \`simctl spawn defaults write\`, and devicectl has
  no defaults command; the one file route,
  \`devicectl device copy to --domain-type appDataContainer\`
  onto Library/Preferences/<bundleId>.plist with the app
  terminated, copies successfully and then loses the seeded
  keys, because cfprefsd serves its cached domain and rewrites
  the file. THE FLAG ALONE DOES NOT COVER A PHONE:
  EXDevMenuShowsAtLaunch defaults to TRUE on iOS
  (DevMenuPreferences.setup), and DevMenuManager arms its
  auto-launch observer when \`showsAtLaunch ||
  shouldShowOnboarding()\`, so finishing onboarding clears
  only the second half. THE LAUNCH ARGUMENTS COVER THE REST.
  The device launch ends in
  \`<bundleId> -- -EXDevMenuShowsAtLaunch 0
  -EXDevMenuShowFloatingActionButton 0\`: devicectl passes
  everything after \`--\` to the app, and NSUserDefaults reads
  the argument domain AHEAD of the persisted one, so the menu
  and its floating button are off for that launch and nothing
  is written to the phone. So a fresh install comes up on the
  app, not on the menu, and with no floating button.
  THE FAB IS REAL ON A PHONE, and a screenshot is the only
  way to see it: about four seconds after launch a blue gear
  labelled Tools appears top-right over the app, the label
  fades after roughly ten seconds, and the gear stays as a
  translucent grey circle for the life of the app. It carries
  no accessibility label after the fade, so
  \`agent-device snapshot -i\` stops listing it. Measured
  with the argument on: the corner is clean at 4s and at 12s.
  Stim's own launch is the only one that
  carries these: an app started ANOTHER way -- a home-screen
  tap, a relaunch without the arguments -- still gets the
  stored value, and on a fresh install that is the menu
  (runtime version, Close, Reload, Go home) and the button.
  \`agent-device press 'label="Close"'\` dismisses it -- or
  \`snapshot -i\` and the ref. The onboarding key the flag
  writes and the Local Network grant both survive an
  UPGRADE install. Android's intent extra prevents the menu's
  automatic launch; versions with expo/expo#49651 also honor
  the outer FAB flag in Stim's deep link.
  The phone's unverified remedy is also ROUTED, not a fixed
  list. When this launch's device records carry the Local
  Network path reason, the remedy leads with that evidence and
  with \`agent-device alert get\`, \`alert accept\`, then
  \`snapshot -i\` and \`press 'label="Reload"'\` -- the grant
  alone does not reload the dev client. Otherwise the network
  list stays. Routing changes no record's level, so nothing new
  reaches \`logs --errors\`. The OTHER first-launch tap,
  developer trust, has no API at all and is always the user's.
  \`guide errors unverified\` has the signature and the
  full commands.`,
    },
    gc: {
      summary: 'the gc report payload: mode, sections, reasons, failures, results, inventory, and the gc refusals',
      body: () => `  stim gc [--delete] [--older-than <days>] [--cache <name|all|workspaces|recordings|parked>]
          [--worktrees] [--idle <duration>] --json

  The report the text prints, as one payload. Show the user its sections
  before you run \`gc --delete\`. Under --delete it is the report that run
  acted on: \`results\` lists each entry's outcome, \`failures\` counts the
  entries it could not delete, and a nonzero count exits 1. Run
  \`stim gc --json\` again to see what is left.

  mode            "dry-run" | "delete"
  idle            the --idle duration in milliseconds, or null
  cacheScope      the --cache name, or null. When set, devices, project
                  entries and locks were not inspected and their sections
                  are empty, except that --cache parked fills
                  parkedSimulators and parkedEmulators
  olderThan       the --older-than days, or null
  worktreeSweep   null without --worktrees; otherwise { olderThan, defaulted }:
                  the idle days a linked worktree needs, and whether that is
                  the default 7 because --older-than was not given. Merged
                  worktrees are swept either way
  actionable      true when --delete with the same flags reclaims something
  failures        null on a dry run without --idle; otherwise the entries it
                  could not delete or shut down
  results         what --delete or --idle did, one { kind, status, label,
                  id, bytes, detail } per entry it acted on; empty on a dry
                  run. status is "done", "kept" (left alone, detail says
                  why) or "failed" (detail says why and what to retry).
                  kind: device, parkedDevice, idleDevice, deviceRecord,
                  workspaceOutputs, recording, workspaceDirectory, project,
                  buildLock, buildSlot, deviceLease, easSession, worktree,
                  cache.
                  label is a device, path or cache name; id is the UDID,
                  AVD name or path behind it, or null. Under --cache
                  parked, a "done" parkedDevice was erased and stays
                  parked; otherwise it was deleted
  inventory       null except on a dry run without --cache or --idle. Report
                  only: gc never acts on it, even under --delete.
                  { devices, runtimes, systemImages, notices }
    devices       { kind, id, name, model, runtime, state, lastUsedAt, bytes,
                    directory, owner, project, slot }  every available iOS
                    simulator and registered AVD. runtime is the simctl
                    runtime identifier or the AVD's system image package.
                    lastUsedAt is simctl's last use, or when the emulator
                    last wrote the AVD's hardware-qemu.ini. bytes is the
                    simulator's data size from simctl; null for AVDs.
                    owner is workspace (project and slot say which),
                    parked, orphaned (this Stim home created it and no
                    workspace holds it), otherStimHome (a stim-* device this
                    home has no record of creating, even when a workspace
                    names it) or user. Off macOS no simulator is listed
    runtimes      { identifier, runtimeIdentifier, version, build, bytes,
                    lastUsedAt, deviceCount, command }  iOS simulator
                    runtimes from \`xcrun simctl runtime list -j\`, then
                    any other \`simctl list runtimes\` shows, with bytes
                    and command null. deviceCount is the simulators on
                    it; command is the \`xcrun simctl runtime delete\`
                    line for a deletable runtime, else null. Stim never
                    runs it
    systemImages  { package, directory, avdCount, command }  installed
                    Android system images; avdCount is the AVDs whose
                    image.sysdir.1 names it; command is the
                    \`sdkmanager --uninstall\` line. Stim never runs it
    notices       why a listing is missing or partial, such as simctl
                    timing out or an AVD or system image folder Stim
                    cannot read. A macOS privacy denial (EPERM) names the
                    Privacy & Security setting to grant
  sections        one array per report section, in the text order. Every key
                  is present, empty when there is nothing to report:
    deadProjects            { path }
    invalidProjects         { path }  the registry key is not absolute
    orphanedPorts           { project, label, port }
    orphanedWorkspaces      { dir, projectRoot, bytes }  --delete removes the
                              whole workspace directory
    linkedWorktrees         { path, idleDays, mergedInto, pullRequest,
                              pullRequestUnknown, willRemove, reason,
                              detail, eligibleAt }  mergedInto is the
                              default branch HEAD is merged into
                              ("origin/main"), or null. pullRequest is the
                              branch's pull request { number, state:
                              "open" | "merged" | "closed", url,
                              containsHead }, or null; pullRequestUnknown
                              says why gh could not answer, else null.
                              detail says why it is removed ("merged into
                              origin/main", "PR #12 closed", "idle 9d") or
                              kept. eligibleAt is the ISO time a
                              recent-activity worktree becomes removable,
                              else null. Without --worktrees, the source
                              checkout and roots outside git are left out
    parkedSimulators        { udid, name, model, runtime, parkedAt, app,
                              bytes, listed }  app is the bundle id recorded
                              at park, else null; with --older-than, only
                              those parked at least that long
    parkedEmulators         { name, systemImage, deviceProfile, parkedAt, app,
                              bytes, listed }  app is the package name;
                              likewise
    orphanedDevices         { kind, id, name, bytes, directory }
    unverifiedDevices       { kind, id, name, command }  stim-* devices this
                              Stim home has no record of creating; never
                              deleted, run command yourself (rm -rf <dir>
                              for AVD data with no registration)
    staleDevices            { kind, id, name, project, slot, idleDays,
                              bytes }  only with --older-than
    staleDeviceRecords      { kind, id, project, slot }  --delete clears
                              the record only
    staleLedgerEntries      { kind: "ios" | "android" | "web", id }
                              simulators this Stim home created that a
                              complete simctl listing no longer shows, AVD
                              names with no registration or data in any AVD
                              root, and browser profile paths whose
                              directory is gone; --delete forgets the
                              ledger entry only
    idleDevices             { kind, id, name, project, slot, lastActivityAt,
                              idleForMs, buildInProgress }  booted owned
                              devices whose status activity is "idle";
                              --idle shuts down those idle long enough,
                              --delete never touches them
    orphanedEasSessions     { id, name, platform, status, projectScope }
    staleBuildLocks         { path, platform, key, pid, projectRoot }
    staleBuildSlots         { path, index, pid, projectRoot }
    unresolvedBuildClaims   { kind: "lock" | "slot", path }  never touched
    buildsInProgress        { path, platform, key, pid, projectRoot }
                              never touched
    expiredDeviceLeases     { path, platform, id, deviceName, holder,
                              expiresAt }
    keptDeviceLeases        { name, path, detail }  never deleted
    deviceSweepNotices      { message }
    easSessionSweepNotices  { message }
    skipped                 { path, detail }  not classified as dead
    workspaceLogs           { dir, projectRoot, bytes, trimBytes, willTrim,
                              reason, detail }  logs/ of each workspace;
                              trimBytes is what --delete would drop from
                              Metro, client and device logs over twice the
                              8 MiB cap; willTrim marks the ones it would
                              trim
    recordings              { dir, projectRoot, bytes, deleteBytes,
                              willDelete, withWorkspace, reason, detail }
                              recordings/ of each workspace; deleteBytes is
                              what --delete would remove; withWorkspace
                              marks those of a gone workspace, removed with
                              its workspace directory
    workspaceBuildOutputs   { dir, projectRoot, bytes, idleDays, willClear,
                              reason, detail }  derived-data, gradle-build,
                              android-cas and cache-provider of each
                              workspace; willClear marks the ones --delete
                              would clear
    caches                  { name, dir, source, bytes, note, willEmpty,
                              emptySkipped }  alive, not garbage; willEmpty
                              marks the ones --delete would empty
  bytes is null when the size is unknown: not measured, or the measurement
  failed. idleDays is null when the last use is unknown. listed is false for
  a parked device that is no longer on this machine, and null when its
  listing was unavailable.

  reason is null for an entry --delete acts on, and otherwise a stable code
  to branch on; detail is the text line, for the user. Never parse detail.
  A linked worktree's detail is never null.
    workspaceBuildOutputs   unresolved | in-use | last-use-unknown |
                            recently-used
    workspaceLogs           unresolved | in-use | collector
    recordings              unresolved | retained | recently-recorded
    linkedWorktrees         not-a-worktree | bare-repository |
                            source-checkout-unknown | source-checkout |
                            locked | in-use | status-unreadable | dirty |
                            unpushed-unchecked | unpushed | submodules |
                            not-merged | merge-unknown | last-use-unknown |
                            recently-used | activity-unknown |
                            recent-activity

  These print the error contract instead and exit 1:

    { "code": "STIM_BAD_ARG", "message": "...", "remedy": "..." }

  - a --cache name that no shared cache carries; the remedy names the
    caches on this machine
  - --cache together with --worktrees or --idle`,
    },
    status: {
      summary:
        "the status payload's lifecycle phase, issues and their codes, build and device activity fields: a running build, its estimate, each platform's last build, who drives each device, whether the app runs on it, and what uses CPU and memory now",
      body: () => `  stim status --json

  Each environment carries phase, where the workspace is in its lifecycle:

  phase       "warming"  stim worktree warm runs in it now
              "ready"    its last warm succeeded and nothing has run there
                         since: no start, ios, android, web or reload, for
                         at most 2 hours
              "live"     live is true: Metro, a device, Chrome or a remote
                         session of it runs
              "idle"     none of these
  phaseSince  when the warm started ("warming") or finished ("ready"); null
              for "live" and "idle"
  warmStep    "refresh" or "copy", the step a warming workspace is in;
              absent in other phases
  recording   { enabled }: whether stim-server may record the workspace's
              device screens for replay, from recording.enabled

  A warm records warming under its own ownership claim, so a warm that was
  killed or failed reads as idle, never as warming. Plain \`stim status\`
  marks the workspace [warming: <step>], [ready] or [idle].

  Each environment carries issues, the things in that workspace that need
  the user, and warnings, its error and warning issues as text ("<slot>: "
  when not the default slot, then "<message>; run \`<remedy>\`"):

  issues   [{ code, severity, message, remedy, workspace, slot? }]

  code       port-not-ours          another process answers Metro on this
                                    workspace's reserved port. "info" with
                                    remedy stim start when no supervisor
                                    runs: start reserves a free port.
                                    "warning" when this workspace's
                                    supervisor runs and cannot serve there
                                    (remedy stim stop), or its supervisor is
                                    unverified. The message names the holder:
                                    "Metro for workspace <name>" when it runs
                                    inside another workspace, else "a dev
                                    server in <last dirs>"; metro.heldBy
                                    carries its pid and cwd
             sim-missing            the recorded simulator no longer exists
             sim-without-metro      the simulator is booted and no Metro
                                    serves the workspace
             avd-serial-changed     the owned emulator came back on another
                                    serial, so Metro forwarding is lost
             avd-missing            the recorded AVD no longer exists
             android-reverse-missing the owned emulator runs this
                                    workspace's debug app against its live
                                    Metro, but the adb reverse for that Metro
                                    port is gone, so the app cannot reach
                                    Metro; the remedy stim reload android
                                    restores it
             avd-not-detected       adb does not see the owned emulator while
                                    the workspace expects it: it holds an
                                    unexpired lease on its serial, or it
                                    launched onto it and has not stopped
                                    that slot since, and its dev server runs
                                    or the launch was in the last
                                    ${RECENT_LAUNCH_MS / 60_000} minutes. An idle workspace's
                                    shut-down emulator is android.state
                                    "not-detected" with no issue.
             avd-unchecked          the emulator listing could not be read
             supervisor-unverified  a supervisor record whose process status
                                    cannot prove gone or ours; stop refuses to
                                    signal it
             browser-unverified     the owned Chrome's supervisor or Chrome
                                    process cannot be proven gone or ours;
                                    stop and stim web refuse to signal it
             browser-orphaned       the owned Chrome runs but its supervisor
                                    exited, so page logs are not captured;
                                    stim stop closes it
  severity   "error" when stop or start refuses until it is resolved,
             "info" for a note that blocks nothing (not in warnings, and
             not shown as a problem), else "warning"
  remedy     a command to run from workspace, such as "stim android --slot
             fold"
  slot       absent for the default slot

  A supervisor record whose pid is gone or reused is not an issue: status
  reports supervisor null, and the next stop or start clears the record.
  \`stop --slot <name>\` forgets that slot's launch, so a device stopped on
  purpose is not reported while the shared dev server keeps running.

  An environment where \`stim web\` ran carries web, its Stim-owned Chrome:

  web  { browser, version, running, pid, supervisorPid, url, headless,
         viewport, profile, cdpEndpoint, targetId, page?, activity? }

  running        the browser supervisor and Chrome are both verified live;
                 pid, supervisorPid, cdpEndpoint and targetId are null when
                 false, and page and activity are absent
  url            the page stim web opened; page.url is the document the page
                 loaded last, and page.route the URL an in-app route change
                 (history API or fragment) moved it to since
  cdpEndpoint    http://127.0.0.1:<port>, the reserved loopback DevTools
                 endpoint of that Chrome. Attach Playwright MCP
                 (--cdp-endpoint) or agent-browser (--cdp <port>) to it; it
                 reaches only the Stim profile, never your own browser
  targetId       the DevTools target id of the owned page, the one Stim
                 Desktop and the phone stream; other tabs are not the page
  profile        the Stim-owned user data directory under STIM_HOME
  page           { url, state, error?, route? }: the page's latest load, from
                 the newest page-load marker in web.ndjson; null before the
                 first. route is absent until an in-app route change after
                 that load
                 "loading"  the document was requested; no load event yet
                 "loaded"   the load event fired
                 "failed"   the document failed (connection refused, HTTP
                            error, certificate) or the page crashed; error
                            is the log message
  activity       like a device's activity below. driver.tool names a
                 DevTools client connected to cdpEndpoint (agent-browser,
                 agent-device, argent, playwright, puppeteer,
                 chrome-devtools-mcp, or the executable's name); Stim's own
                 connections (the browser supervisor, stim-server, Stim
                 Desktop, the stim CLI) are not drivers. basis: cdp-client
                 (one lsof of the DevTools port); agent-action (the newest
                 agent input the browser supervisor recorded in web.ndjson)
                 and page-log (the newest other
                 web.ndjson record) for recency

  Each booted simulator and detected emulator in environments (and in
  slots) carries activity; a shut-down or physical device has none:

  activity  { state, driver?, lastActivityAt?, recent?, basis }

  state            "driven"   a live claim or driver holds the device now
                   "active"   no driver, but activity in the last 10 minutes
                   "idle"     no driver and no activity for 10 minutes or more
                   "unknown"  a claim or driver check could not be read;
                              never treated as idle
  driver           { tool, pid, since } for "driven": agent-device, stim device
                   lock, argent, xcodebuild, idb, maestro, appium, simctl,
                   uiautomator or instrumentation; pid and since are null when
                   the claim does not record them
  lastActivityAt   the newest of this device's app log records, this
                   platform's Metro bundle requests, the workspace's last
                   Stim run, while agent-device drives it the agent's last
                   recorded action, and now while a stim-server client views
                   it, rounded down to the minute; absent when none is
                   recorded
  recent           the newest time of each kind of evidence behind
                   lastActivityAt: agent-action, device-log, metro-bundle,
                   workspace-use, supervisor-start, page-log or viewer, each
                   rounded down to the minute. viewer is now while a
                   stim-server client streams the device's frames
  basis            the evidence behind state, strongest first:
                   agent-device-claim, agent-device-lease  agent-device state,
                     read only; live only when every recorded process is alive
                     with its recorded start time, so a reused pid is dead.
                     A runner lease that declares agent-device's device
                     claims is never a driver: without a claim, the runner
                     is one agent-device kept warm after close or handed
                     off when its daemon exited
                   device-lock          an unexpired \`stim device lock\` lease
                   driver-process       a host process naming the UDID or
                                        serial, other than such a runner
                   instrumentation      an on-device uiautomator, androidx.test or
                                        argent helper process (one adb shell ps
                                        per emulator)
                   device-log, metro-bundle, workspace-use, agent-action,
                   viewer               recency

  Plain \`stim status\` appends it to each device line: "driven by
  agent-device for 12m", "active", "idle 3h", or "activity unknown (...)".

  An owned device that is not booted after its supervisor shut it down for
  devices.idleShutdownMinutes carries idleShutdown, and plain \`status\`
  appends "shut down after 30m idle at <at>" to its line; the next \`ios\` or
  \`android\` run for that slot clears it (\`guide lifecycle budget\`):

  idleShutdown  { at, idleMinutes }
  \`gc --idle <duration>\` shuts down owned devices idle that long
  (\`guide cleanup gc\`).

  An owned booted simulator or detected emulator also carries app, whether
  the workspace's app process is alive on it now:

  app  { id, state }

  id     the bundle identifier or package checked: the one launched on this
         device, else the project's
  state  "running"  a process of that app runs on the device
         "stopped"  no such process: it crashed, was killed or never launched
         "unknown"  the process listing or the app's Info.plist could not be
                    read; never "stopped"

  app is absent when the device is not owned or no app id is known: the
  process was not checked.

  This is current process state, read from one host ps (simulator apps are
  host processes) and the same adb shell ps as activity, so a status --watch
  refresh notices an exit within its 30-second fallback. It is not launch
  evidence: launched in an ios or android result keeps its own meaning. For
  "stopped", run \`stim ios\` or \`stim android\` to launch it again. Plain
  status appends "<id> running", "<id> not running" or "<id> process
  unknown" to the device line.

  An environment's metro carries idleStop { reason: "idle", at, idleMinutes }
  when its supervisor stopped the dev server for idleness and nothing serves
  the port since; plain \`status\` prints "stopped (idle)" (\`guide metro\`).
  Whenever nothing serves the port, metro also carries lastStop when the cause
  is known, one of:
    { reason: "idle", at, idleMinutes }
    { reason: "requested", at, by, byPid, byWorkspace? }  a Stim command
    { reason: "signal", at, signal }        a signal no Stim command sent
    { reason: "server-exited", at, mode, code, signal }
    { reason: "vanished", pid, startedAt }   the recorded supervisor is gone
                                             and recorded no cause
  (\`guide metro\`, WHY IT STOPPED).
  When another process answers Metro on the port, metro carries
  heldBy { pid, cwd }, cwd null when its directory could not be read.

  metro also carries bundle, from the bundle requests Stim's middleware
  records in the workspace's metro log: an app's, and Stim's own prefetch
  before a launch. It is absent when the log's tail holds none.

  bundle     { bundling, platform?, startedAt?, percent?, last? }
  bundling   true while a request is in flight: Metro runs, and the request
             started under the current dev server less than 10 minutes ago
  platform   with bundling, the in-flight request's "ios" or "android";
  startedAt  when it started
  percent    0-100, only when Metro reported progress for that request,
             which it does for clients that accept multipart responses
  last       { platform, status, durationMs, finishedAt }: the newest
             finished request, status "ok" or "failed", durationMs from the
             request to the end of the response

  Each entry of environments also carries build: null, or the ios or android
  run that holds this workspace's native-run.lock:

  build   { platform, slot, state, phase, startedAt, phaseStartedAt,
            outcome, expectedMs, expectedPhaseMs, basis, missReason?,
            detail?, placement }

  state            "running" while the run's own native-run claim is live;
                   "stale" when that claim was released or its process is
                   gone -- the run was killed, and the next run replaces the
                   record; "unknown" when the claim set cannot be resolved.
                   Never treat a stale record as a build in progress.
  phase            prepare | cache-lookup | wait | prebuild | pods |
                   compile | install | launch. prepare covers settings,
                   Metro and the owned device; wait is waiting on another
                   workspace's build of the same fingerprint; install
                   includes waiting for the device to boot.
  startedAt        when the run started; phaseStartedAt when its phase did
  outcome          "cold" once the run reached prebuild, pods or compile,
                   "hit" once it reached install without them. Before
                   that, the outcome of this project's most recent run.
  expectedMs       the median duration of this project's last successful
                   runs with that outcome on that platform, or null with
                   no history
  expectedPhaseMs  the median duration of this phase in those runs, or null
  basis            how many runs the medians come from (at most 10)
  missReason       once the run knows its cache lookup missed, why, in the
                   shape of lastBuilds missReason below
  detail           on a running build whose tool printed a line Stim reads:
                   { step, unit, done, total, line, updatedAt }
    step           the tool's step: configure, compile, link, resources,
                   script, dex, package or sign; null before one is known
    unit           "targets" for xcodebuild, "tasks" for Gradle
    done           xcodebuild: targets that started work; Gradle: tasks it
                   reported so far
    total          xcodebuild: targets in its dependency graph; Gradle: null,
                   since its plain output gives no total
    line           the latest compile, link or task line, paths shortened
                   to file names, at most 160 characters
    updatedAt      when the build last wrote it; the run writes it at most
                   every 2 seconds
  placement        where the build runs: "local", or while it is offloaded
                   { host, phase, startedAt, phaseStartedAt }. host is the
                   offload.machines entry; phase is the step there: sync,
                   deps, prebuild, pods, build (xcodebuild or Gradle) or fetch;
                   startedAt is when the offload started and phaseStartedAt
                   when that step did. Meanwhile phase above follows it as
                   prebuild, pods or compile.

  Plain \`stim status\` prints the same as one line per workspace:

    build: ios compile, 1m10s elapsed -- about 3 min left (median of 4 cold runs)
    build: ios compile on janics-mac-mini (build, 2m10s), 3m05s elapsed

  An environment with a recorded run also carries lastBuilds, each
  platform's most recent ios or android run, finished or failed:

  lastBuilds   { ios?, android? }, each { platform, status, cacheHit,
               cacheSkipped, durationMs, fingerprint, startedAt, finishedAt,
               errorCode?, missReason?, offloadedTo?, offloadFallback?,
               diagnostics? }

  status       "ok" or "failed"
  cacheHit     "local" or "remote" for an app from that cache tier; false
               for an ok run that compiled, or a failed run that had none
  durationMs   the run's wall time; finishedAt is startedAt plus it. Both
               are null when the record carries no duration.
  fingerprint  the key's fingerprint after any prebuild or pod install
  missReason   only on a run that did not install a cached app (it
               compiled, or failed before finding one): { kind, summary, changes,
               changeCount, baseline, rekeyedBy }. kind is "changed",
               "no-baseline", "same-sources", "cache-skipped" or
               "fingerprint-error"; summary names the cause, such as
               "native dependency added: expo-clipboard". changes holds up to
               20 { source, change, category } of changeCount changed sources;
               baseline is { fingerprint, from: "workspace" | "project" }, the
               cached build compared with; rekeyedBy lists "prebuild" or
               "pod install" when those steps moved the key.
  diagnostics  only on a failed run whose compiler reported errors: up to
               5 { file, line, column, message }, null where the compiler
               gave no position.
  offloadedTo  only on a run a build machine compiled: its name
  offloadFallback
               only on a run that considered offloading and built here: one
               reason per machine when none took the build, or why the
               offload stopped

  Plain status prints "last build: ios local cache in 12s, android compiled
  in 7m02s". To predict the next run instead, see \`guide facts plan\`.

  An environment with a recorded run also carries builds, each platform's
  last 10 runs, newest first. Its newest entry that is not "interrupted" is
  the run lastBuilds reports, once a run has recorded builds.

  builds         { ios?, android? }, each a list of lastBuilds entries
                 with { result, slot, configuration, cacheKey, phases }
  result         "succeeded", "failed", "cancelled" (Stim stopped the run
                 after an interrupt or \`stim stop\`) or "interrupted": its
                 process ended without recording a result, such as a kill or a
                 second interrupt, so the next run recorded it with
                 null durationMs and finishedAt, no cache facts, and 0 for the
                 phase it stopped in
  slot           the device slot, "default" without --slot
  configuration  the iOS configuration or Android variant the run built,
                 "Debug" or "debug" by default; null when the run ended
                 before resolving it
  cacheKey       the cache key the run looked up or stored under
  phases         milliseconds spent in each phase the run entered, among
                 prepare, cache-lookup, wait, prebuild, pods, compile,
                 install and launch

  Only runs that record a last build are listed: a run that stops before
  looking up a build, such as a bad flag, is not. Estimates (expectedMs) come from run statistics, not builds.

  done and total are counts, not a completion fraction: a target or task
  can take a second or ten minutes, and cached work finishes instantly.

  Each environment also carries disk, and each owned simulator and owned
  emulator in ios, android and slots carries disk, once \`status --watch\` has
  measured them:

  disk (environment)  { worktreeBytes, nodeModulesBytes, buildBytes,
                      measuredAt }
    worktreeBytes     the linked worktree, or else the checkout holding the
                      workspace, node_modules included
    nodeModulesBytes  node_modules at that root and at the workspace path;
                      part of worktreeBytes
    buildBytes        Stim's folder for the workspace: Xcode derived data,
                      Gradle outputs and logs
    measuredAt        the oldest of the three measurements; a figure not
                      measured yet is null
  disk (device)       { bytes, measuredAt }: the simulator's data folder
                      under CoreSimulator/Devices, or the AVD's .avd folder

  \`status --watch\` runs one du at a time off its refresh path, and measures
  a folder at most every 5 minutes while its environment is live and every
  hour otherwise. It caches each size under $STIM_HOME/disk-usage, which
  one-shot status only reads, so the fields appear once a watcher, such as
  stim-server or Stim Desktop, has measured.

  An environment carries agents when coding-agent sessions work in it, most
  recently active first:

  agents        [{ tool, sessionId, title?, cwd, startedAt?, lastActiveAt?,
                pid?, openUrl?, webUrl? }]
    tool        claude-code | codex
    title       the short name the tool keeps for the session; never a
                prompt or any conversation content
    cwd         the session's working directory, canonical
    lastActiveAt the tool's last update of the session, or the last Stim
                command the session ran here when that is newer
    openUrl     opens the session in the Claude desktop app
                (claude://code/continue) or the Codex app
                (codex://threads/<id>) when that app is installed on the
                Mac; absent for a Claude Code session started in a terminal
    webUrl      https://claude.ai/code/<id> for a Claude Code session with
                Remote Control connected; it opens the session in a browser
                or the Claude mobile app

  A session works in an environment when its cwd is the environment's
  path or inside it (the deepest environment wins), or is the environment's
  git worktree root. \`status --watch\` looks for sessions at most every 15
  seconds: Claude Code sessions in ~/.claude/sessions whose process runs,
  and Codex threads in $CODEX_HOME (~/.codex) updated in the last 30
  minutes. It caches them in $STIM_HOME/agent-sessions.json, which one-shot
  status reads and ignores once it is 2 minutes old. Both sources are other
  tools' internal files; a missing or changed one only drops its sessions.
  \`start\`, \`ios\`, \`android\`, \`web\`, \`reload\` and \`worktree warm\`
  also record the CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID of the shell
  that ran them, so that session is listed for 30 minutes after the command
  even when status cannot see it, and for as long as it runs.

  memorySource says how a memory figure was obtained:

  footprint  physical footprint, the figure Activity Monitor's Memory
             column shows, read by a small helper Stim compiles with the
             Xcode command line tools into $STIM_HOME/helpers on first use
  rss        summed resident set size, for machine owners when the helper
             cannot be built (no Xcode command line tools, Linux). It
             overstates a simulator many times over.
  estimate   a fixed amount per booted simulator, detected emulator,
             running Metro and running Chrome

  An environment's memoryMb is what its own processes use now, the sum of
  memoryMb over the machine owners whose workspace is that environment,
  builds included, when machine.memorySource is footprint. Otherwise it is
  the estimate, with memorySource estimate.

  capacity.committedMb sums memoryMb. The memory budget plans before a boot
  and always uses the estimate. What is using CPU and memory now is the
  top-level machine section:

  machine   null, or { memorySource, owners: [{ kind, name, workspace,
            slot?, id, owned, cpuPercent, residentMb, memoryMb,
            processes }] }

  kind         simulator  a booted simulator's launchd_sim tree
               emulator   an emulator's launcher and qemu tree, by its -avd
               metro      a workspace's supervisor and Metro trees
               build      a running ios or android run's process tree,
                          xcodebuild, Gradle and compilers included
               browser    the Chrome of \`stim web\` and its supervisor
               server     stim-server
               shared     machine-wide processes no workspace owns:
                          CoreSimulator services, adb server, Gradle and
                          Kotlin daemons, Watchman, the emulator's netsimd
  workspace    the workspace that records the device or runs the process;
               null for a device no workspace records and for server and
               shared
  id           the simulator's UDID, the AVD name, Metro's port or the
               build's platform; null otherwise
  owned        true for what Stim started and stops: a workspace's owned
               device (\`stim stop --slot <slot>\`), its Metro (\`stim
               stop\`), build or Chrome. Never act on an owner with false.
  cpuPercent   ps %CPU summed over the owner's processes; 100 is one core
  residentMb   summed resident set size. Pages shared between processes
               count once per process, so a simulator reports well above
               its physical footprint.
  memoryMb     summed physical footprint when machine.memorySource is
               footprint; a process the helper cannot read, another user's
               or one that just exited, counts its resident size. Equals
               residentMb when memorySource is rss.

  Each process counts in exactly one owner, the one whose root process is
  its nearest ancestor, so the supervisor a build started counts as Metro,
  not as the build, and a Gradle or Kotlin daemon counts in the build that
  started it until that build exits, then as shared. Processes with no owner
  are left out. machine comes from one host ps, the one status reads for
  device activity, and one run of the footprint helper. It is null when no
  simulator is booted, no workspace is live and no build runs: status then
  runs neither. \`status --watch --json\` rereads both every 15 seconds while
  machine is not null, with no other subprocess.`,
    },
    plan: {
      summary: 'the ios and android --plan payload: fingerprint, cacheHit, prebuild, missReason, expectedMs and basis',
      body: () => `  stim ios --plan --json            # or: stim android --plan --json

  { platform, slot?, fingerprint, cacheKey, cacheHit, provider,
    cacheSkipped, prebuild, outcome, expectedMs, basis, missReason?,
    refusal? }

  fingerprint   the fingerprint the run would look up first; with
                --eas-profile, the one EAS CLI computes
  cacheKey      the key under that fingerprint; null for an EAS miss
  cacheHit      "local", "remote", or false for a miss
  provider      the remote tier that answered, "eas" with --eas-profile,
                otherwise null
  cacheSkipped  true when cache reads are off (--no-build-cache or config)
  prebuild      on a miss, the run's decision for the native dir: "none",
                "generate", "regenerate" or "refuse"; null on a hit
  outcome       "hit" or "cold"; null when the run would refuse
  expectedMs    the median wall time of this project's last successful runs
                with that outcome on that platform, or null with none
  basis         how many runs expectedMs comes from (at most 10)
  missReason    on a predicted cold build with cache reads on, why the
                cache has no app, in the shape of lastBuilds.<platform>
                .missReason (\`guide facts status\`), compared with the same
                baseline the run would use. kind is "changed",
                "no-baseline", "same-sources" or "prebuild-pending": a
                baseline exists and the run would prebuild first, which the
                plan does not, so changes compare the fingerprint before that
                prebuild; changeCount 0 then means those inputs match the
                baseline. rekeyedBy is empty.
  refusal       { code, message, remedy } when the run would refuse:
                STIM_PREBUILD_FAILED for a tracked native dir the fingerprint
                leaves out, STIM_EAS_BUILD_MISSING for an EAS miss

  A plan that would refuse still exits 0: the payload is the answer. A plan
  that cannot be computed prints the error contract and exits 1, for example
  STIM_NO_FINGERPRINT, STIM_EAS_UNAVAILABLE, or STIM_BAD_ARG for a flag that
  picks a device. When and why a plan and the run can differ: \`guide
  lifecycle builds\`.`,
    },
    stats: {
      summary: 'the stats payload, what counts as a run, hit, miss and failed, timeSavedMs, the heartbeat estimate',
      body: () => `  stim stats --json

  { "version": 1,
    "project": { "key": "<path>", "ios": <bucket|null>,
                 "android": <bucket|null> } | null,
    "machine": { "ios": <bucket|null>, "android": <bucket|null> } }

  \`project\` is null outside a project; a platform with no run yet is null.
  A bucket carries runs, failed, hits, misses, coldRuns, coldRunMs, hitRuns,
  hitRunMs, timeSavedMs, firstRunAt and lastRunAt, plus lastColdBuildMs and
  lastPodsMs once the project has compiled or installed pods, and
  offloadedRuns, offloadedRunMs and lastOffloadHost once a build machine
  compiled one. An offloaded run is a miss but not a cold run, so the cold
  average, time saved and build estimates stay local. Milliseconds are
  integers.

HOW A RUN IS COUNTED (\`stats\`)
  Every \`ios\` or \`android\` invocation that got as far as computing a
  cache key is one run, in this project's bucket and in the machine-wide one.
  The project key is the app's path IN THE SOURCE CHECKOUT, so every
  worktree of a repository pools into one bucket and two apps in a monorepo
  do not. A run that ends through an error or an uncaught exception counts
  only as \`failed\`; \`launched: "unverified"\` or \`"bundling"\` is a
  success. Otherwise the run's own \`cacheHit\` decides: "local" or "remote"
  is a HIT, false is a MISS -- including a release run on a phone and a swap
  that fell back to a full build. A miss adds its \`durationMs\` to the cold
  runs; a hit adds it to the hit runs and credits \`timeSavedMs\` with this
  project's mean cold run BEFORE it, minus its own duration, floored at zero.
  A hit that WAITED for another workspace's build (\`waitedForBuild\`) counts
  as a hit and is credited nothing: the compile it skipped was paid for in the
  wait, and with no cold run recorded for this project and platform there is
  nothing to compare against, so it credits nothing either. The saved figure
  is therefore an ESTIMATE and is printed as one. The file is
  $STIM_HOME/stats.json (see \`guide lifecycle builds\`). Beside the
  aggregates it keeps the last 10 successful runs per project, platform and
  outcome (hit or cold) that did not wait for another workspace's build: each
  one's duration and per-phase durations. \`stim status\` estimates a running
  build from them (see \`guide facts status\`); \`stats --json\` does not
  print them.

  A run also keeps the duration of its own two long phases in that bucket:
  the build phase of a miss that compiled (lastColdBuildMs) and the last
  \`pod install\` (lastPodsMs). The last value only, not a series. THAT IS
  WHERE THE HEARTBEAT ESTIMATE COMES FROM. A later run reads this project's
  bucket before it compiles, and prints:

    build       still compiling (1m00s of ~3m10s)
    pods        still installing (1m30s of ~1m40s)

  The \`~\` value is THIS PROJECT'S LAST COLD BUILD, or its last
  \`pod install\`, and never a mean: a project's build time drifts with its
  size, so the most recent run is the best single guess. Past the estimate
  the line reads \`(4m00s, usually ~3m10s)\`, because a slower machine is not
  a hang. A project with no record yet gets \`(1m00s)\`, the elapsed alone,
  and a warm run has no long phase to size. That read takes no lock and
  ignores what it cannot read, so nothing about statistics can change a
  run's outcome.`,
    },
  },
};

export default facts;
