import { REMOVED_SETTINGS } from '@stim-cli/core/state';

export default {
  summary: 'Migrate a home or project that an earlier Stim used',
  body: () => `UPGRADE FROM STIM 1.x

The STATUS block of stim guide agent lists what an earlier Stim left in this
home or project. Work through the items it names, in this order, then run
stim guide agent again: the line clears once nothing is left. Steps marked
(ask) change the user's machine, environment or defaults; ask first.

1. OLD PROCESSES
  Detect: stim status prints "Daemon: pid <n> from an older stim holds the
  daemon claim".
  Migrate: when it adds that the next command that starts stimd stops it, run
  stim start. Otherwise (ask) stop that pid with the command it prints. Run
  stim stop in each workspace a 1.x Stim started before the upgrade.

2. SETTINGS
  Detect: stim settings --json lists them under unknown; stim doctor rates
  each one.
  Migrate: when start, ios, android, web, macos, revive or gc refuses, run the
  printed set and unset commands in order. For the rest, set the replacement
  in the same layer (--scope), then run the unset shown, which removes the old
  key from every layer:
${[...REMOVED_SETTINGS]
  .filter(([, entry]) => !entry.kept)
  .map(
    ([key, removed]) =>
      `  \`${key}\`${removed.env ? ` (${removed.env}${removed.refuses ? ', refused' : ''})` : ''}\n    ${removed.key ? `replaced by ${removed.replacement}` : removed.replacement}; stim settings unset ${key}`,
  )
  .join('\n')}
  remote.buildMode -> remote.build (auto->auto, force->remote, off->local),
  daemon.enabled -> daemon.mode (true->on, false->off), caches.injectMetroStore
  -> optimizations.metroSharedCache. Unset any other unknown key: the budget.*
  and maintenance.* pressure keys, share.webrtc and devices.reclaimIdleMinutes
  have no replacement. maintenance.idleStopHours still applies to hosted
  sessions; keep it. Until daemon.mode is set, a leftover maintenance.mode off
  or report holds the daemon at report: it acts on nothing.

3. ENVIRONMENT (ask)
  Detect: env | grep -E '^STIM_(MAINTENANCE|BUDGET_|REMOTE_BUILD_MODE|WEBRTC_STUN)'
  Migrate: the user replaces each in their shell, CI or service environment
  with the variable of the replacement above, such as STIM_MAINTENANCE ->
  STIM_DAEMON and STIM_BUDGET_MIN_FREE_DISK_GB -> STIM_DISK_MIN_FREE_GB.

4. CHANGED DEFAULTS (ask)
  2.0 cleans up sooner: idle.dormantDays 1 (was 3),
  maintenance.olderThanDays 3 (was 7), disk.minFreeGb 40 (was 20),
  disk.criticalFreeGb 20 (was 6), ios.simslim on (was off). To keep a 1.x
  value: stim settings set <key> <value> --scope machine.

5. PROJECT FILES
  Detect, from the repository root:
    git grep -nE '@stim-cli/|stim-server|stim-ci|stim gc|"stim": *"[~^]?1\\.'
  Migrate:
    stim-server             stim serve, stim pair, stim pairings
    stim-ci                 stim ci; GitHub Action version 2.0.0 or later
    stim gc --delete        stim gc --dry-run, then stim gc
    gc --cache, --older-than, --worktrees
                            gc --pressure normal|high|critical
    "stim": "^1..."         a 2.x range, then install
    @stim-cli/metro         remove it and sharedCacheStores from
                            metro.config.js and the dependencies
    @stim-cli/expo-build-cache
                            remove it from the dependencies and from the Expo
                            buildCacheProvider config
    other @stim-cli/* imports
                            import from stim, stim/ci or stim/plugin;
                            @stim-cli/cache-s3 stays
  API callers: StimOptions.buildCache -> buildCacheDir, run option wait ->
  waitSeconds, diagnostics({ errors }) -> diagnostics({ errorsOnly }),
  gc() -> previewGarbage() or collectGarbage(). See stim guide api.

6. SERVICE AND REMOTE MACHINES (ask)
  Detect: stim service status; stim remote list.
  Migrate: a service a 1.x Stim installed is reinstalled with stim service
  install and its existing options; a worker is updated with
  stim remote update <machine>.

7. FIRST BUILD
  Expect one cold native build per fingerprint. An untracked ios/ or android/
  that a 1.x Stim generated is prebuilt again once: (ask) preserve manual edits
  first. stim doctor lists fingerprint.config.js options 2.0 ignores.

8. VERIFY
  stim doctor, then stim guide agent: STATUS no longer lists leftovers.`,
};
