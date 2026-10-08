export default {
  summary: 'Typed lifecycle API: createStim, run, stop, diagnostics, and cancellation',
  body: () => `PROGRAMMATIC API

Install stim as a project dependency: npm install --save-dev stim.
Import { createStim, StimError } from 'stim'. Node 22.12 or later is required.

  const stim = createStim({ projectRoot: process.cwd() });
  try {
    const result = await stim.run({ platform: 'ios' });
  } finally {
    try {
      const diagnostics = await stim.diagnostics({ errors: true });
    } finally {
      const cleanup = await stim.stop();
      if (!cleanup.ok) throw new Error(cleanup.summary);
    }
  }

createStim takes projectRoot, optional absolute home and buildCache paths,
and onProgress({ stream, message }). message is an output chunk. Without
onProgress, operations write nothing to the caller's stdout or stderr. Each
operation uses a bundled worker that calls the same lifecycle operations as
the CLI; it never parses CLI arguments or changes the caller's cwd/environment.

run takes platform plus its options:
  ios:     configuration, scheme, deviceType, runtime
  android: variant, systemImage, deviceProfile
  macos:   remoteBuild
  web:     headed (default false)
iOS and Android also accept slot, metroCheck, buildCache, and remoteBuild.
All methods accept signal. run builds, installs and launches; build-only is
not available. Web requires a running server, just like stim web.

run returns { platform, facts }. iOS facts include udid; Android includes
serial; both include bundleId, appPath, metroPort, cacheHit and launched.
macOS facts include bundle, bundleId, executable, pid, build and launched.
Web facts contain the owned browser's existing launch and page facts.
Do not interpret 'bundling' or 'unverified' as proven application readiness.

stop({ slot? }) returns { ok, outcomes, summary }. It acts on the workspace,
including resources from earlier runs. Use a dedicated workspace in CI.
Cancellation waits for the operation worker to exit; stop with a fresh signal
after cancellation or partial failure. Always inspect cleanup.ok.

diagnostics({ tail: 200, errors: false }) returns { directory, records } from
the local timeline, even before a successful run. tail: 0 returns paths only.
It does not fetch remote logs or capture new crashes. Failures reject with
StimError carrying code, message, remedy and details (including the log path).

Normal ownership, device creation, cache locks and coordination remain active.
All concurrent artifact-cache writers must share the same coordinating home.
Do not point independent Stim homes at a concurrently writable shared cache.
`,
};
