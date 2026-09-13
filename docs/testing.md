# Test stages

`pnpm test` runs the deterministic parser and decision tests alongside real Git,
process, filesystem, HTTP, and WebSocket integration fixtures. It needs Node and
Git, but no Xcode, Android SDK, signing identity, or connected phone. The default
Vitest worker count and five-second unit timeout remain unchanged.

`pnpm run test:compat` runs the explicit native tool compatibility stage. It
requires macOS, Xcode with the iOS and iOS Simulator SDKs, `codesign`, `security`,
`clang`, `openssl`, and a paired, unlocked iPhone with Developer Mode enabled.
It builds generated scratch projects, signs temporary apps ad hoc, decodes
fixture provisioning profiles, reads signing identities, and queries devices and
processes through `devicectl`. It does not install an app, alter the keychain,
create or boot a simulator, or change an Apple Developer account.

Compatibility tests live beside the unit tests as `*.compat.test.ts`. Ordinary
unit discovery excludes them. Missing tools, no phone, a locked or disconnected
phone, and rejected argv make the explicit stage fail with evidence; they do not
count as a compatibility pass. Preserve both the command and its output when
reporting an unavailable prerequisite. A unit-only CI result is not native
compatibility evidence.

Run the stage when changing native tool calls and before a release. A focused
probe is useful while iterating, for example:

```sh
pnpm run test:compat engine-ios-device.compat.test.ts
```

`pnpm run test:e2e` covers the real CLI and cache flow without native tools.
`pnpm run test:runtime` checks the built packages at their published runtime floor.
The native app workflows remain separate; see [RELEASE.md](../RELEASE.md).

## Fixture isolation

Real listeners use port zero and obtain the assigned port only after the
listening event. Keep the listener bound for the fixture's lifetime. A mocked
process can publish readiness separately from socket allocation; never discover
a free port, close it, and assume it is still available when the mock starts.
The foreign-listener test still holds an actual occupied port, chosen by the OS.
The child-process port test reports its bound port over IPC before assertions and
awaits child exit during cleanup.

The socket inventory covers `start`, `ports`, `metro`, `status`,
`crash-diagnostics`, `metro-warmup`, `bundle-response`, `engine-reload`, and
`expo-metro-config`, plus the benchmark `metro-listeners` fixture. Numeric ports in parser inputs and mocked executor payloads
do not bind host sockets and remain deterministic constants. Process collector
fixtures already use explicit readiness and exit deadlines; real Git warm,
refresh, and remove fixtures use bounded operation and test timeouts. Keep the
short default on pure decision tests and retain longer operation-specific limits
where an integration case needs them.

To validate isolation changes, run two complete unit suites from separate Git
worktrees at the same time while an unrelated listener occupies an old fixture
port, such as 8166. Record each worktree commit, runner command, elapsed time,
worker setting, test totals, and both exit codes. Confirm that the seeded listener
still answers afterward. Run this deliberate contention check with the host's
other full-suite and native validation work paused. Do not use retries, change
the repository's worker defaults, or serialize the suites to call this proof a
pass.
