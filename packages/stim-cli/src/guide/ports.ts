import { MAX_REVERSE_PORTS } from '@stim-cli/core/state';

export default {
  summary: 'Workspace ports for web and API servers that Stim does not manage',
  body: () => `NAMED SERVER PORTS

If Stim is not installed globally, replace stim with npx stim.

  stim ports get web
  pnpm exec vite --port "$(stim ports get web)" --strictPort
  stim ports
  stim ports stop web --dry-run
  stim ports stop web
  stim ports release api

get <label> allocates on first use and prints only the number to stdout.
Repeated calls reuse it, even while a server is listening. Labels start with
a letter and contain up to 64 letters, digits, underscores, or hyphens.
metro is reserved; use stim start and stim stop for managed Metro, and
metro.port or STIM_METRO_PORT to choose its number (guide settings).
Changing the pin while this workspace's dev server runs refuses until
stim stop; an unverified supervisor also blocks the change until you stop it with the tool that started it. A foreign holder
of the pin is refused before anything starts; this project's own Metro on
it is attached to. stim web follows these rules when its page uses Metro.
ios and android with --no-metro-check use the pin, then the recorded port,
then 8081, without probing or reserving; an invalid pin still refuses.

New allocations scan TCP ports 8900-8999. They skip registry reservations
and existing listeners, announcing occupied ports and upward retries on
stderr. All 100 ports occupied or reserved is a refusal; stop or release
unused allocations in their owning workspaces.

Metro allocation (from 8082 up) and named allocation find listeners in the
native TCP table: netstat on macOS and Windows, /proc/net on Linux. When that
table is denied, empty or unreadable, as in some sandboxes, each candidate is
checked with an lsof listener scan and connects to 127.0.0.1 and ::1 instead.
Allocation refuses only when none of them can answer: start refuses with
STIM_PORT_INSPECTION_FAILED, and ports get prints the same message.

The machine registry, under STIM_HOME, serializes allocation and cleanup.
The workspace is the nearest package.json directory, resolved through
symlinks. In a monorepo, a package that depends on neither react-native nor
expo, such as a Vite web app, uses the one Stim app registered in the same
git worktree instead, and says so on stderr. ports, web, settings, logs,
reload, stop and status follow this rule (status stars the app instead of
printing the note); other commands use the nearest package.json. Register the app first: run stim ports get <label>, stim start,
stim ios or stim android from the app directory. Every ports command then
acts on the app's ports, so ports stop without a label there also stops the
app's other labels. A package that already holds ports keeps them; release
them to move to the app. With no registered app, or more than one, the
nearest package.json stays the workspace; run ports from the app directory.
The allocation reserves a number, not a listening socket. Another process
can bind it before your server does. Use strict-port behavior when supported
and verify the server bound the number supplied. Stim does not start,
supervise, or capture logs for these servers.

ports lists named labels and ports, plus Metro marked managed.
ports stop [label] kills TCP listeners on those named ports and releases
the allocations. It sends SIGTERM, waits two seconds, then SIGKILL if needed;
on Windows it terminates the listener's process tree with taskkill.
Stopping listeners requires lsof on macOS and Linux, or netstat on Windows.
It prints the PID and command (the image name on Windows) for each stopped
process. The listener's cwd can be anywhere: the named reservation is
permission to stop that listener.
Reserve only services this workspace may stop. --dry-run prints what would
be stopped and released, without doing either. A failed inspection or stop
keeps that allocation for retry; other labels are still processed.
ports release [label] releases without signalling a process.
Omitting the label selects every named port, never Metro. stim stop leaves
named ports alone.

worktree remove, gc --delete and automatic maintenance release named
allocations without signalling their listeners; run ports stop first to stop
a server this workspace started. gc reports allocations whose workspace no
longer exists; gc --delete releases them. Unmounted or unresolved workspace
paths are retained. Use the same current Stim version for cleanup: versions
without ports do not know about named allocations.

REVERSE PORTS

  stim ports reverse api            # a named port from stim ports get
  stim ports reverse 4318           # a raw port a tool of this workspace listens on
  stim ports reverse --remove 4318
  stim ports --json                 # allocations and reverses as one payload
  stim ports reverse 4318 --json    # { action, port, ports, devices: [{ platform, device, status, detail }] }

An app on one of the workspace's devices reaches a server on this machine at
the same localhost:<port>, like adb reverse. reverse records the port in the
workspace (at most ${MAX_REVERSE_PORTS}) and applies it to the devices the workspace has now; it is
idempotent, so rerunning it repairs a lost reverse. Devices the workspace gets
later receive it when stim android launches the app. metro and the
workspace's Metro port are refused; Stim already makes Metro reachable.
status is one of reachable (nothing to do), applied, removed, pending (the
emulator is not running yet), unsupported or failed; unsupported and failed
exit 1 after the port is recorded.
- Local iOS simulator: shares this Mac's loopback, so the port is reachable
  already. Nothing is applied.
- Local Android emulator: adb reverse tcp:<port> tcp:<port>. stim reload
  android re-applies it when missing, stim status reports
  android-reverse-missing with the stim ports reverse remedy, and stim stop
  removes it.
- Android phone (android --device): adb reverse, removed by stim stop and
  worktree remove together with the Metro reverse. Only the recorded ports are
  removed.
- iPhone (ios --device): refused. USB carries no reverse forward.
- Hosted iOS and Android (--remote <machine>): reversed through the client's
  links to the host. stim start must be running, because its Metro supervisor
  opens those links, and the host needs hosted-reverse-ports (update
  stim-server there otherwise). A hosted simulator shares the host's loopback,
  so the host listens on the same port number; a port another process holds
  on the host is refused. A hosted emulator gets adb reverse to a private
  loopback port of the host. The host listens only on its own loopback, so any
  process on that Mac can reach the port while the session lasts; it never
  connects to this machine, and this machine forwards only the ports recorded
  here. stim ios and stim android with --remote set the ports up again when
  they place the app, stim reload android restores them, and a host restart
  resumes them. Stopping the session ends them.
- EAS Simulator sessions (--remote eas): not reversed; Stim has no route into
  the session.
stim stop removes the device-side reverses and keeps the recorded ports, so the
next launch applies them again. worktree remove, gc --delete and automatic
maintenance forget them with the workspace.

Tools that advertise an address to the app, such as Appduct's daemon, need that
address set to 127.0.0.1 (Appduct: advertisedIp in ~/.appduct/config.json).
Run stim ports reverse <daemon port>, then deliver the link with
stim agent-device open <app> "<link>".

A shared API does not get a shared reservation. Pass its port by environment
instead of allocating a separate label in every worktree.`,
};
