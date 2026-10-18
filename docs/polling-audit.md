# Server and CLI polling audit

This records the server/CLI part of [#3547](https://github.com/appandflow/stim/issues/3547),
reviewed on 2026-10-17 against
[`480879f`](https://github.com/appandflow/stim/commit/480879f43b096ffbe246b1f8ce2ab1f860998966).
It covers `packages/core`, `packages/server`, `packages/stim-cli`, and the
agent-device driver. Desktop rendering and interactive performance remain in
[#3548](https://github.com/appandflow/stim/issues/3548).

## Merged changes

| Change                                                                            | Result and evidence                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Git status memoization, #4020](https://github.com/appandflow/stim/pull/4020)     | A controlled deferred-merge case dropped from 37 to 16 status scans. The warm-home samples still made 84 status scans; this is not a general idle CPU improvement.                                                                                                        |
| [Tunnel child completion, #4022](https://github.com/appandflow/stim/pull/4022)    | Owned child exit/error events replace the exit-flag polling loop. Final process/group verification remains; a reproduced descendant-drain race was fixed.                                                                                                                 |
| [macOS registration, #4024](https://github.com/appandflow/stim/pull/4024)         | Owned inherited IPC delivers readiness. Matching journal/identity checks, deadlines, and disconnected-launcher repair remain. Local native launch and early-disconnect cases passed.                                                                                      |
| [Binary upload backpressure, #4026](https://github.com/appandflow/stim/pull/4026) | Send completion wakes pressured writes; local close also wakes them. Real encrypted 64 MiB transfers preserved bytes/order/buffering. The paused local-cancel median dropped from 6.6 ms to about 0.06 ms; throughput and CPU samples do not establish a general CPU win. |
| [Browser registration, #4028](https://github.com/appandflow/stim/pull/4028)       | Owned IPC readiness replaces the normal registration poll. The repair/deadline path remains for missed messages and the Windows launcher handoff. Real owned Chrome launch and teardown passed.                                                                           |
| [Attention deadlines, #4041](https://github.com/appandflow/stim/pull/4041)        | Future device-lease expiry and unattended EAS thresholds now contribute to the next wake. Quiet-hours and clock reevaluation remain.                                                                                                                                      |
| [Navigation timeout cleanup, #4043](https://github.com/appandflow/stim/pull/4043) | Fast acknowledgement, error, and cancellation clear the losing timeout. An isolated CDP fixture went from one remaining timer and exit at 1019 ms to zero timers and exit at 17 ms. The slow-server acknowledgement bound remains.                                        |

These changes passed independent review and their full merge-candidate checks.
Their PRs contain the regression and real-tool evidence. The simulator metadata
file-watch change [#4016](https://github.com/appandflow/stim/pull/4016) also merged;
the separate simulator audit owns that slice.

## Current status-watch measurement

The local MacBook probe used Node 22.22.2 and the merged `7ae982c` build, before
the navigation-only change above. The status-watch sources did not change
between that build and `480879f`. It ran `status --watch --json` against the real
Stim home with maintenance disabled and Git optional locks disabled only for
the probe. A native Git wrapper collected `wait4` resource usage; the root
process hook recorded spawns, asynchronous errors, watcher close duration, and
its own CPU. Output and process samples stayed private.

| Observation                             |            Result |
| --------------------------------------- | ----------------: |
| Observation cutoff                      |          65.003 s |
| Root lifetime                           |          67.496 s |
| Shutdown after cutoff                   |           2.493 s |
| Root Node CPU                           |       0.948 CPU s |
| Root Git status completions             |                82 |
| CPU of those status processes           |       7.704 CPU s |
| All intercepted native Git completions  | 147 / 8.273 CPU s |
| Distinct status payloads / stderr bytes |             6 / 0 |

The 142 root Git attempts include three `ENOENT` spawn errors without a child
PID. The native completion population also includes synchronous invocations and
possible `gh` descendants. Only asynchronous root Git proxies have direct PID
joins; the two populations must not be treated as identical. Git wall times can
overlap and cannot be added to obtain elapsed time. This does not attribute all
descendant CPU.

Git status remains the largest captured native CPU cost. Its freshness cache
must still observe unstaged and untracked changes: index/HEAD/ref changes do not
signal all of those edits. Increasing the TTL or deleting repair would change
visible freshness. The sample ranks remaining cost; changing workload, registry,
and machine conditions prevent a causal comparison with earlier runs.

Nine CoreSimulator `device.plist` watcher closes totaled 0.806 ms. Four
CoreSimulator directory closes totaled 1490.504 ms, and eight Git directory
closes totaled 696.199 ms. The directory fallback covers devices whose metadata
file does not yet exist. The file-watch optimization remains effective;
removing creation coverage is not an equivalent optimization.

The root exited normally, and its recorded root/last-unclosed child PIDs were
absent in the subsequent scoped process check. The root exit callback alone
does not prove cleanup: exit-listener ordering can precede cleanup listeners.
No unknown process was signaled.

## Remaining recurring timers

The source inventory found 289 scheduling/wait call sites, including one-shot
deadlines, cooperative yields, and network timeout setters. It is not a count
of live recurring timers. A supplementary text pass found two timer contexts
inside generated JavaScript, listed below. There are 28 directly parsed
`setInterval` calls, plus the generated Windows service monitor.

| Owner                                          | Disposition and reason                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentDeviceDriver.launch`                     | Keep the five-second check of the separately recorded daemon and Android identity. The retained proxy's exit is an earlier event, but is not a complete daemon/device identity signal.                                                                        |
| `AgentDeviceDriver.issue`, `ControlHub.open`   | Keep protocol lease renewal for active sessions. Expiry is part of the external lease contract; these are not process-ownership heartbeats.                                                                                                                   |
| `BuildHost`                                    | Keep the ready-gated minute sweep of idle Gradle daemons for revocation and memory pressure. Daemons outlive build children; Gradle handles its configured idle age.                                                                                          |
| `UsageSampler.start`, `runStatusWatch.machine` | Keep resource sampling. The usage sampler is subscriber-driven; the status machine refresh applies to a JSON machine snapshot.                                                                                                                                |
| `PushNotifier.watch`                           | Keep disk sampling, pull-request lookup, and clock reevaluation while watching. Local status events cannot announce remote PR changes, quiet-hours transitions, or wall-clock jumps. The new semantic deadline wake is complementary.                         |
| `Recorder`                                     | Keep segment keyframe/recording-time maintenance, failed-session retry, and retention pruning. An unchanged screen still needs segment boundaries; exclusive ownership is checked separately.                                                                 |
| `startServer` revocation repair                | Keep event-first registry observation with one-second safety rereads. A missed watch event must not retain revoked access.                                                                                                                                    |
| `startServer` setup pruning                    | Keep hourly expiry pruning. Tickets age without local file activity.                                                                                                                                                                                          |
| `runStatusWatch.fallback`                      | Keep the 30-second full repair alongside file/native events. Git's separate freshness cache limits repeated expensive reads.                                                                                                                                  |
| `watchStatusSources.processTimer`              | Keep the two-second external-PID disappearance hint. It requests a refresh, not authority to signal or reclaim a process.                                                                                                                                     |
| `watchStatusSources` simulator check           | Keep the simulator inventory repair from #3503, with metadata hints as the primary signal. This audit does not change native ownership or that slice.                                                                                                         |
| `followLogs`, hosted log followers             | Keep their missed-file-event/context-settlement repair and remote log query cadence. Log transport and collection belong to #3482.                                                                                                                            |
| `bootIosSim.monitor`                           | Keep progress reporting during the active native boot. It does not discover or start work while idle.                                                                                                                                                         |
| `cancelOnAbort`                                | Keep cross-process cancellation-request repair under #3467. Local abort callbacks remain primary.                                                                                                                                                             |
| `waitForFileUrl`                               | Keep the bounded file-hint repair and discovery deadline. Both stop once discovery settles.                                                                                                                                                                   |
| `BuildConnection`                              | Keep connection ping/silence enforcement. This bounds a network session; it does not establish process or artifact ownership.                                                                                                                                 |
| `watchStdoutReader`                            | Keep quiet-stream reader-loss observation. A zero-length write does not detect a closed Linux pipe reader; the parent change is the fallback. No payload bytes are added.                                                                                     |
| `watchHostedMetro`                             | Keep file hints with a ten-second hosted-session repair. The current remote protocol does not expose a complete session-change subscription.                                                                                                                  |
| `watchIdleDevServer`, `watchIdleDevices`       | Keep idle-clock/external-activity observation. Driver, lease, build blockers, and clock changes can occur without a local callback; expensive blocker probes remain behind the idle threshold.                                                                |
| `runSupervisor` maintenance                    | Keep the age-based maintenance trigger. Retention can become due without a new filesystem event.                                                                                                                                                              |
| Generated `service-manager.WAIT`               | Keep the one-second lifetime monitor for the deliberately orphaned Windows service process. Its intermediary parent has exited, so this monitor has no `ChildProcess` exit handle. PID presence only keeps the monitor alive; it grants no cleanup authority. |

Node's [watch-readiness issue](https://github.com/nodejs/node/issues/52601) was
closed after inactivity, not by a readiness API fix. Separate local probes on
Node 22.22.2 and 24.18.1 reproduced missing immediate/50 ms startup notifications.
File hints therefore remain hints; replacing atomic files or unavailable watch
roots also requires reattachment and repair.

## Retry, deadline, and batching decisions

| Case                                                                                                                            | Disposition                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory/cache/build/warm/workspace claims, build slots, device capacity/pools, native-run cancellation, shutdown confirmation | Retain identity/fairness/ownership revalidation and bounded repair. These 18 remaining candidate sites belong to the separate #3467/#3503 slices. A file disappearance or timestamp is not authority.                                                                                                                                                                                           |
| Windows TaskScheduler and detached launcher registration                                                                        | Retain bounded journal/identity readiness checks. A launcher or manager acknowledgement cannot prove the detached worker registered.                                                                                                                                                                                                                                                            |
| Setup approval tickets                                                                                                          | Retain the bounded cross-process ticket/capability query until expiry. Keep doctor-only reconnect guidance separate from ordinary setup.                                                                                                                                                                                                                                                        |
| Previously recorded Android collectors                                                                                          | Retain bounded identity/exit verification without an owned child handle.                                                                                                                                                                                                                                                                                                                        |
| Hosted Metro gateway request/close                                                                                              | Retain matching request-ID/process-token acknowledgement and bounded repair. No inherited child IPC handle exists for an already-running supervisor.                                                                                                                                                                                                                                            |
| Native app launch, Metro delivery, public tunnel reachability, browser readiness                                                | Retain bounded positive-evidence probes. A process launch, printed URL, or transport connection alone does not prove these conditions.                                                                                                                                                                                                                                                          |
| Failed connections/listeners/subscriptions, missing watch roots, degraded homes                                                 | Retain retry/backoff only after a failure or while repair is required, cancelled when closed or recovered.                                                                                                                                                                                                                                                                                      |
| Request, authentication, startup, upload-idle, report, and shutdown budgets                                                     | Retain finite deadlines and required cleanup escalation. Custom request timers clear at settlement; native timeout APIs and forced-stop bounds retain their own semantics. These are not discovery polling.                                                                                                                                                                                     |
| Frame/replay congestion                                                                                                         | Retain pacing and pressure retry under their output contracts. Playback timestamps/rate and latest-frame delivery are separate from state discovery.                                                                                                                                                                                                                                            |
| Server artifact download pressure                                                                                               | Retain the current bounded active-transfer retry. A real local-close test returned before receiver resume; a callback-only prototype waited for resume (109 ms versus 318 ms total). A write callback and completed close handshake do not announce the earlier `CLOSING` transition. #4044 records the rejected direct substitution. The client upload path has a separate local-close wakeup. |
| Log/context batches, progress/status refreshes, navigation updates                                                              | Retain event-triggered coalescing/throttling and required quiet-settlement deadlines. There is no new batch timer without pending work.                                                                                                                                                                                                                                                         |
| Generated `INPUT_LISTENER` in `web/input.ts`                                                                                    | Retain the input burst flush: it coalesces trusted input, bounds a continuous burst, and flushes on `beforeunload`. Text contents are not recorded.                                                                                                                                                                                                                                             |
| Legacy cache worker journal                                                                                                     | Retain event-triggered `setImmediate` reads and cooperative final draining. It does not run an idle polling loop.                                                                                                                                                                                                                                                                               |
| Cooperative file/archive/log reader yields                                                                                      | Retain event-loop fairness while actual bytes or records remain to process.                                                                                                                                                                                                                                                                                                                     |

The old lexical inventory still labeled 37 sites as candidates. Eighteen are
the excluded ownership/native cases above, eighteen have the required
observation/clock contracts above, and the last was the navigation timeout now
fixed by #4043. Eight later IPC/deadline/drain sites were reviewed separately.
Of 244 previously reviewed sites, 233 had unchanged enclosing named-function
bodies; the nine changed and two newly introduced contexts were reread.
Function equality supports carrying a disposition, not a claim about every
caller or a substitute for native validation.

## Limits and remaining acceptance

This audit does not establish Desktop visible/hidden CPU, main-thread stall,
scroll, switching, or live-view acceptance. It does not complete the pending
Desktop-to-server migration or release QA. Those still require their actual
app interactions and release-candidate evidence. No timer count, document, or
queued PR is a substitute for those gates.
