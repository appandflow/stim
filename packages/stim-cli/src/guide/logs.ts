export default {
  summary: 'Querying the merged NDJSON timeline, and what --errors means',
  body: () => `LOGS

  stim logs [filters]

Reads every *.ndjson file in the global workspace logs directory, merges them into one timeline
ordered by timestamp, prints what matches, and EXITS. The file set is
discovered, not enumerated.

EXIT 0 MEANS THE QUERY SUCCEEDED, whether or not records matched. A clean
\`stim logs --errors\` check requires exit code 0 AND no matching errors in
captured logs. An empty result does not prove launch or log capture succeeded;
a workspace with no log directory also returns an empty result.

For zero matches: STDOUT IS EMPTY, exit code 0, and
one dim note on STDERR reading \`No matching log records in <logs dir>\`
(human mode only -- \`--json\` prints nothing at all, on either stream).
The only exit-1 paths are a malformed query and no project.

Device collectors and build records carry their named slot. Use --slot phone
for that slot's timeline; its launch marker cannot hide a sibling's errors.
Untagged legacy records belong to default. Metro/client records are shared and
usually untagged: use an unfiltered workspace query to inspect those errors.

FLAGS
  --slot <name>   only this slot's records (default includes untagged records)
  --source <s...>  metro, client, device, build (one or more), or all. An
                   unknown value is REJECTED rather than quietly matching
                   nothing.
  --level <l>      minimum level: debug, info, warn, error, fatal
  --since <d>      only records newer than this: 30s, 5m, 2h
  --grep <re>      only records whose msg matches this regular expression
  --tail <n>       only the last n MATCHING records (applied after filtering,
                   so --level error --tail 5 is the last five ERRORS)
  --errors         errors and fatals since the last marker, from metro, client
                   and build, plus confirmed native app-crash reports.
                   Capped at 20 printed records.
  --follow         keep streaming until interrupted (Ctrl+C is exit 0)
  --json           the raw records, one per line, so stdout is valid NDJSON.
                   ZERO matches is ZERO bytes on stdout (an empty NDJSON
                   stream), exit 0 -- parse stdout line by line, never as one
                   JSON document. The "No matching log records" note is human
                   mode only, on stderr.

--ERRORS, PRECISELY
  Level error or fatal, from metro, client and build, plus device records with
  event native_crash (app/device/time-correlated OS reports or fatal app console output), timestamped after the
  marker that closes their window. Three rules, and a field test
  caught all three wrong at once -- it returned 3,004 iOS syslog lines on a
  healthy app while hiding a real startup crash.

  SCOPE. General device logs are NOT in the default scope. A device log is the OS talking:
  \`simctl log stream\` is predicated on the app's PROCESS, and inside that
  process Apple's frameworks log thousands of Error-typed lines (nw_socket,
  SecTrust, WebKit, CoreUI) that have nothing to do with your app. The proven
  ones are demoted to info by the collector; the scope rule covers the rest.
  The metro stream carries exactly one demotion of its own, and it is Stim's
  doing: the dev-client deep link \`ios\`/\`android\` open to wire the app to
  your port arrives inside the app as a link, and React Navigation logs at
  error that no navigator handled a NAVIGATE to \`expo-development-client\`.
  There is no such screen and there is not meant to be, so that one record is
  recorded at info -- it made every healthy cold launch report 1 error. A real
  unhandled NAVIGATE names a route your app has, and is still an error.
  A native crash can happen before JS or Metro exists. Confirmed native_crash
  records are included without admitting the rest of the device noise. Opt back in with
  \`--source device\` or \`--source all\`; a plain \`logs\` with no --errors
  has always shown everything. ON A PHYSICAL IPHONE opting back in buys less
  than it does on a simulator: the device console carries no severity, so
  \`--source device --errors\` there reports crash and refusal lines only,
  never a level. Read a phone's device records with a plain \`logs
  --source device\`.

  THE WINDOW. A marker closes the window for the sources it can speak for:
    a BUNDLE marker (src metro: bundle_build_done / bundle_build_failed, or
      Expo's "Bundled" / "Bundling failed" lines) is written when a bundle
      attempt FINISHES, success or failure. It resets METRO errors from
      before the attempt -- a resolve failure you fixed and rebuilt is
      history, and when bundles fail back to back only the newest attempt's
      errors are reported -- and nothing else. A failed attempt's own summary
      and details land at or after its marker, so they stay reported.
    a LAUNCH marker (src build, written before \`ios\` / \`android\` attempts
      launch) resets EVERYTHING. It precedes the tool call so an immediate
      native crash is not hidden by a marker written after the process died.
  A finished bundle is not evidence that the app which loaded it is fine.
  In the field case the app threw at 16:03:54 and Metro wrote its marker at
  16:03:55, one second later, because the bundler finishes accounting for a
  build after the client has already evaluated it. Under one marker for all
  sources that crash was reported as nothing at all. The cost of the rule is
  the safe direction: a client redbox that Fast Refresh already fixed keeps
  being reported until the next launch.

  OUTPUT. Every logs command, including --errors and --follow, shows full captured
  error, component and native stacks, with no frame or message-length limit.
  --errors shows the first 20 matching error records, plus stack context.
  This record-count limit never truncates a stack. A footer reports hidden
  records; use its printed --tail value to include all records before grouping.
  To read the complete timeline without the default error-record limit:
    stim logs --source all
  This includes all sources, levels and history, not just the latest errors;
  add --since, --level or --grep to narrow it. --source all selects sources,
  not stack depth. For untouched captured records use:
    stim logs --source all --json
  Neither form can restore text the runtime truncated before capture.
  In non-follow human output, an Expo error includes its immediately
  following code frame and Call Stack lines. Bare React Native symbolication is
  shown as separate context because Metro does not provide an error correlation
  identifier. Context does not change the error count or the raw error records
  returned by --json. --json is never capped, and neither is an explicit --tail.

  In --follow mode the marker window is dropped -- every error arriving from
  then on is by definition after the last marker seen.

  \`stim status\` reports the same count per workspace, as
  logs.errorsSinceMarker: the same query, the same scope, so the two can never
  disagree about whether this workspace is failing.

THE RECORD
  { ts, src, level, msg } always. ts is epoch milliseconds; src is one of
  metro / client / device / build; level is one of the five above.
  Optional fields:
    event    the producer's own event name (bundle_build_done, client_log, ...)
    stack    frames of { file, line, column, fn }, passed through as reported
    marker   true on the records that close an error window
    deviceTs Android logcat's original epoch milliseconds; ts is aligned to
             host time using a bounded clock query at each collector attachment
    clockOffsetMs the offset added to deviceTs; absent if the query failed.
             A collector_clock warning then says timestamps retain device time.
    raw      true when the level was inferred from a line of text rather than
             reported by the producer (every expo-child record)

WHAT WRITES WHAT
  metro.ndjson         the bundler, in both supervisor modes
  client.ndjson        in-app console logs and redboxes -- BARE PROJECTS ONLY.
                       In expo-child mode everything Expo prints lands in
                       metro.ndjson with raw: true, so \`--source client\`
                       returns nothing there.
  device.ndjson        the device-log collector uses \`simctl log stream\`
                       predicated on the app, or \`adb logcat\` filtered to
                       the app's pid. Local iOS simulator capture starts
                       before launch; Android attaches once the pid is known
                       and reads buffered logcat records. This
                       is where a native crash that never reached JS shows up
                       -- and, on iOS, where every Apple framework running in
                       the app's process also logs. The proven noise sources
                       are recorded at info rather than error; the rest is why
                       --errors leaves this source out unless asked. A VERIFIED
                       LAUNCH counts these records and prints one line:

                         launch      9 general device error-level records
                                     (not confirmed app errors); inspect with
                                     stim logs --errors --source device

                       The count does not attribute unknown OS errors to the app.
                       Known JavaScript errors also print individually: Android
                       ReactNativeJS records, and iOS com.facebook.react.log /
                       javascript records. These can interrupt an optional
                       readiness wait even without a client or Metro copy.
                       Client and Metro errors still print individually.
                       A native app that loaded its bundle but reported app errors
                       ends with WARNING rather than OK. This does not change the
                       launch JSON or exit code: launched describes bundle/process
                       evidence, not a healthy UI. Inspect the errors and readiness.

                       Only human ios/android launch output previews up to
                       ten frames per error, component or native stack. App-source
                       frames take priority; selected frames retain captured
                       order, with an omitted-frame count. Escaped
                       component stacks print one frame per line. Long bundle
                       URLs are shortened and labeled unsymbolicated; shortening
                       is not source-map resolution. A Metro error body that an
                       Android DebugServerException embeds prints as the
                       error's message and import stack, not its JSON. All
                       logs commands show full
                       captured stacks, including \`stim logs --errors\`.
                       Use \`stim logs --source all\` for all sources/history,
                       or add \`--json\` for raw
                       records. This preview does not alter logs or JSON.

                       Symbolication is best effort. Human launch and non-follow
                       logs queries ask the verified workspace Metro's /symbolicate
                       endpoint to resolve captured JS coordinates, with a 2s
                       request deadline and raw-coordinate fallback. Successful
                       launch context is retained separately under logs/error-context
                       so stopping Metro does not discard resolved evidence.
                       Expo code frames are attached; uncorrelated bare Metro
                       symbolication events remain separate. A component stack
                       never substitutes for a missing error stack. Historical
                       stacks need matching sources/maps, not a rebuilt bundle.

                       Cross-source copies combine only with matching error
                       title, stack location, compatible platform and timing.
                       Same-source repeats and raw JSON records stay intact.
                       Human queries may attach a correlated device component
                       stack to a selected Metro error, but never an unrelated
                       device error.

                       iOS simulator cold launch attaches app stdout/stderr and
                       passes Expo's initial URL directly. Fatal output is available
                       before delayed OS reports, which can take about a minute
                       or longer to appear; rerun logs --errors for those
                       before stopping or releasing the device. Collection requires
                       this workspace's current launch and device ownership or lease;
                       afterward only already-captured reports remain available.
                       The app cache holds console files, so external STIM_HOME
                       paths do not violate the app sandbox. Crash evidence is
                       retained in workspace logs. --follow does not poll for
                       delayed OS reports.
                       Native iOS simulator reports match app ID, simulator ID
                       and launch time. atos resolves app addresses only after
                       the local binary UUID matches the report. Android reads
                       the crash buffer even when the app PID has exited. Java
                       traces remain readable; C/C++ resolution uses NDK tools
                       and matching local ELF build IDs. General OS noise remains
                       excluded from --errors. Full native evidence is in
                       logs --source device --json. Physical iPhone capture stays
                       console-only; missing reports or symbols are not proof
                       of a healthy app. No symbol downloads are performed.
                       Android may keep a crashed Java PID alive behind its
                       crash dialog. Follow the app-scoped force-stop remedy
                       printed by android after fixing the crash, then rerun
                       stim android. Metro reload alone cannot recover it.

                       The connection refusal \`TCP Conn ... Failed :
                       error 0:61 [61]\` (61 is ECONNREFUSED) is not even
                       counted. The app got its bundle over this workspace's
                       Metro and outlived the stability window, so it
                       recovered. A refusal before the
                       launch verifies still prints, as does every record on a
                       launch that does not verify, and the record stays an
                       error in device.ndjson either way; read it with
                       \`logs --errors --source device\`.

  ON A PHYSICAL IPHONE THE SAME FILE CARRIES LESS, and the difference is not
  cosmetic. \`simctl spawn\` is simulator-only and there is no devicectl
  console subcommand, so a device run reads
  \`devicectl device process launch --console\`, which connects the app's own
  stdout and stderr and nothing else. Stim launches it with
  OS_ACTIVITY_DT_MODE, which makes os_log mirror itself onto that stderr --
  without it React Native's own logging, which goes through os_log, would not
  appear at all. What the mirror carries, and what it drops:

    ts        KEPT   the device's own timestamp, off the mirrored line
    proc      KEPT   as name(pid), from the mirrored line, not a path
    category  KEPT   only when the logger has a subsystem; \`javascript\` and
                     \`native\` for React Native's own log calls
    msg       KEPT   a multi-line message arrives as separate records
    subsystem LOST   the mirror never prints it
    level     LOST   Default, Error and Fault all render identically, and
                     Debug is not mirrored at all

  So every device record from a phone is \`raw: true\` and \`info\`, except
  the lines that OPEN with a marker the runtime itself prints: an uncaught
  ObjC exception, a libc++abi termination, an assertion failure, or a Swift
  fatal error. The match is anchored, so an app logging ABOUT a crash stays
  info. devicectl's own \`ERROR:\` is read only on a line with no mirror
  prefix, because that is the only kind devicectl writes. Severity cannot be
  recovered, so it is not guessed. The NOISE_RULES that demote Apple's framework chatter key on
  subsystem and cannot fire either -- but they have less to do, because
  --console carries only the app's streams rather than every framework
  logging inside its process.

  \`log collect --device-udid\` WOULD carry all six fields, in the same NDJSON
  the simulator path parses. It is not used because it requires root
  (\`log: Must be root to collect logs from attached device\`) and produces an
  archive rather than a stream. Streaming with full fidelity needs
  libimobiledevice or pymobiledevice3, which are third-party installs Stim
  does not require. See appandflow/stim#179.
  build-ios.ndjson     the xcodebuild / gradle transcript at level debug, the
  build-android.ndjson extracted diagnostics at level error, and the launch as
                       a marker record. One RUN's worth: each build starts the
                       file over, so the first error in it always belongs to
                       the run that pointed you at it.

  Only a dev server Stim hosted is captured. If you started the bundler
  yourself, the metro and client sources stay empty -- which is not a sign of a
  clean build. The device and build sources are written either way, because
  \`ios\` / \`android\` produce them.

  A collector is killed and replaced on the next \`ios\` / \`android\` run for
  that platform, and reaped by \`stop\`.`,
};
