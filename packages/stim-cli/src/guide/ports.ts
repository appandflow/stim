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
metro is reserved; use stim start and stim stop for managed Metro.

New allocations scan TCP ports 8900-8999. They skip registry reservations
and existing listeners, announcing occupied ports and upward retries on
stderr. Listener checks require lsof, or netstat on Windows. All 100 ports
occupied or reserved is a refusal; stop or release unused allocations in
their owning workspaces.

The machine registry, under STIM_HOME, serializes allocation and cleanup.
The workspace is the nearest package.json directory, resolved through
symlinks. Use the same package directory for every command in a monorepo.
The allocation reserves a number, not a listening socket. Another process
can bind it before your server does. Use strict-port behavior when supported
and verify the server bound the number supplied. Stim does not start,
supervise, or capture logs for these servers.

ports lists named labels and ports, plus Metro marked managed.
ports stop [label] kills TCP listeners on those named ports and releases
the allocations. It sends SIGTERM, waits two seconds, then SIGKILL if needed;
on Windows it terminates the listener's process tree with taskkill.
It prints the PID and command (the image name on Windows) for each stopped
process. The listener's cwd can be anywhere: the named reservation is
permission to stop that listener.
Reserve only services this workspace may stop. --dry-run prints what would
be stopped and released, without doing either. A failed inspection or stop
keeps that allocation for retry; other labels are still processed.
ports release [label] releases without signalling a process.
Omitting the label selects every named port, never Metro. stim stop leaves
named ports alone.

worktree remove stops named listeners and releases their allocations.
gc reports allocations whose workspace no longer exists; gc --delete stops
and releases them. Unmounted or unresolved workspace paths are retained.
Failed stops keep the registry entry. Use the same current Stim version for
cleanup: versions without ports do not know about named allocations.

A shared API does not get a shared reservation. Pass its port by environment
instead of allocating a separate label in every worktree.`,
};
