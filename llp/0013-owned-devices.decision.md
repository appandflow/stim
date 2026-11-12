# LLP 0013: Owned devices, pools, and leases

**Type:** Decision
**Status:** Active
**Systems:** Devices, Cleanup, Claims
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0002, LLP 0007, LLP 0010, LLP 0014

## Prove ownership in this Stim home

Stim can create, boot, shut down, or delete only devices it created. Owned iOS
simulators are named `stim-<label> (<model> <runtime>)`; owned Android AVDs
remain `stim-<label>`. Both are recorded with `owned: true`, and every device
Stim creates is also listed in the locked `$STIM_HOME/created-devices.json`
ledger. A scoped home owns only devices in its ledger. The default home can
also use pre-ledger pool records and project records with `owned: true`.
An ownership check requires the `stim-` prefix and the home record. A name or
AVD `config.ini` never proves ownership on its own because homes share those conventions,
and a home cannot enumerate other homes; the machine list of homes
(`~/.stim/machine/homes`) lets an unscoped `gc` report them, never own their
devices or tear them down. The ownership re-check
before boot and teardown applies that rule, and `gc` only lists other `stim-*`
devices with a manual delete command. Never do any of those actions to a
user-created emulator or simulator. Keep a device record
when teardown fails so `gc` can find the device later.

Scratch homes and the main home use the same naming convention. Name-based ownership previously let a main-home GC delete devices that agents still owned. The per-home record lets cleanup distinguish those devices even when their names look identical. [Cross-home deletion fix](https://github.com/appandflow/stim/pull/1395), [Ownership recheck](https://github.com/appandflow/stim/pull/4693).

## Park to reuse the installed app

Stim parks an eligible owned simulator or emulator it no longer needs instead
of deleting it, up to a per-platform configured maximum, and adopts a compatible
parked one before creating. While the disk pressure level is critical it
deletes instead of parking. Owned devices are disposable: the stim-daemon's
dormant stage and pressure ladder, automatic maintenance and `gc`
delete the owned devices of an idle workspace (one with no activity for
`idle.dormantDays`, 1 by default, at every level), never of one that is in use,
leased, driven, locked or pinned by `maintenance.keep`. Parking keeps the device's apps and data; the pool
record names the installed app and its cache key. Parked devices are
Stim-owned and listed in the pool record. Adoption removes other third-party
apps except iOS XCUITest runners (`*.xctrunner`) and clears the adopting app's data before launch, on every adoption, and
skips the install only after verifying the installed bytes. On Android that proof is the installed
APK's size and the SHA-256 of its tail, from the v2 or v3 signing block through the end of the file,
matching the values recorded after one `apksigner verify` of the local APK; an APK without a recorded
tail, or a device that cannot answer that probe, compares the SHA-256 of the whole APK. Android adoption
matches the system image and recorded AVD creation settings and keeps the AVD
name. When an adopted emulator lacks room on `/data` for the install, trim app
caches, then wipe its user data through centralized teardown. Delete parked
devices only by eviction, adoption-time reconciliation of a listed unavailable
simulator, `stim gc` at high or critical, the stim-daemon's pressure ladder at
high or critical disk pressure, or automatic maintenance's age sweep after
`maintenance.olderThanDays`; no CLI path erases one and keeps it parked. Every
route uses centralized teardown and ownership revalidation. `gc` deletes parked
hosted devices through their owning session home.

A pool avoids booting a new device and reinstalling a cache-hit build for every worktree. Adoption separates the retained installed app from the previous workspace’s data. A byte check is the condition for skipping install. [Pool design](../docs/specs/2026-09-02-simulator-pool-design.md), [First pooled adoption](https://github.com/appandflow/stim/pull/286).

## Unused runtimes and unavailable simulators

Simulator runtimes are not Stim-owned. Deleting an unused one through
`xcrun simctl runtime delete <identifier>` is the one deliberate exception: `gc`
and automatic maintenance do it at every level, only when simctl marks the image
deletable and no simulator on the machine, user-created ones included, uses it.
The only installed runtime stays, and when no runtime is used the newest stays.
An owned simulator whose runtime is gone and that no registered workspace
records is deleted through centralized teardown. Stim never deletes a user-created unavailable simulator and never runs
`simctl delete unavailable`.

Removing an unused runtime frees shared disk, so the check considers every simulator on the machine. The rest of the protections are in [LLP 0002](./0002-cleanup-never-deletes.decision.md#runtimes-the-one-exception-to-ownership).

## Booted grace and deferred shutdown

Park keeps a simulator that is booted when it parks it booted for
`pool.bootedGraceMinutes`, only while memory pressure is normal and a device slot
is free, and records `bootedUntil`; adoption of it still resets and verifies as
above, without the boot. The stim-daemon shuts a booted parked simulator down
through teardown at expiry, under memory pressure before any workspace's device,
and before it reclaims a workspace's device for a waiting run.
`stop` applies the same gates to the workspace's owned iOS simulator: it ends
the app and the agent-device sessions, leaves the simulator booted and assigned
to the workspace, and records a deferred shutdown in the workspace state with the
expiry. A later `ios` run uses the booted simulator and forgets the record; a
later `worktree remove` parks it booted. The stim-daemon shuts a deferred
simulator down through teardown at expiry or under memory pressure, under the
workspace's native-run lock, unless the workspace serves again. A stopped
workspace holding one is outside the idle stage until the expiry. Android
emulators are shut down by `stop`.

Keeping an already booted simulator can save a restart when memory and device capacity permit. The temporary grace yields that capacity to active work before reclaiming an active workspace’s device. [Booted pool grace](https://github.com/appandflow/stim/pull/5159).

## Chrome profile and process ownership

`stim web` launches the installed Chrome only with a profile Stim created under
`$STIM_HOME/workspaces/<id>/web/`, listed under `web` in the created-devices
ledger, and never attaches to a browser it did not start. The command starts
Chrome through `spawnOwned`, which gives Chrome an ownership claim of its own,
and stimd holds its DevTools session. Teardown goes through
`devices/teardown.ts`, signals Chrome (or the browser supervisor an older Stim
started) only after verifying the recorded identity, removes Chrome's `Singleton*` lock files only once Chrome
is gone, and deletes a profile only when the ledger lists it.

A separate ledger-owned profile lets Stim verify what it can stop or delete without touching someone’s browser or another workspace’s data. [Browser ledger](https://github.com/appandflow/stim/pull/1496), [Browser observation in stimd](https://github.com/appandflow/stim/pull/5386).

## Physical devices are leased

A physical device reached through `android --device` or `ios --device` is
used but not owned. Hardware cannot be created or booted, so those paths
install, launch, and read what logs they can, and nothing more. The only
state a physical device leaves is its lease: the file under
`$STIM_HOME/device-locks/` and the holder's token in that workspace's
`state.json`, plus, for Android, the serial and Metro port of the `adb reverse`
the run added, recorded in that `state.json` so `stop` and `worktree remove`
remove the reverses that point at that Metro port or at a port the workspace
reversed with `ports reverse`, and nothing else on the phone. For live view and control of a leased Android phone, stim-server pushes the
scrcpy server jar to `/data/local/tmp`, runs it with `app_process` over an
`adb forward`, and removes the jar and the forward when the stream stops; it
changes no setting. A serial or UDID never enters the project registry, and
`devices/teardown.ts` never sees a physical device. `stop` and `worktree remove`
release the workspace's leases; `gc` deletes only expired lease
files.

A lease serializes Stim use of a device that belongs to a person. Scoped reverse-port cleanup leaves other apps and other tools’ device state alone. [Lease design](../docs/specs/2026-09-02-device-lease-design.md).

## Code

- [Ownership checks](../packages/stim-cli/src/devices/device-ownership.ts), [centralized teardown](../packages/stim-cli/src/devices/teardown.ts), and [pool](../packages/stim-cli/src/devices/sim-pool.ts).
- [Leases](../packages/stim-cli/src/engine/device-lease.ts) and [Android reverse ports](../packages/stim-cli/src/devices/android.ts).
