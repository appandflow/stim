export default {
  summary:
    "Workspace services: a project's databases, API servers and workers, started, stopped and torn down per workspace",
  body: () => `WORKSPACE SERVICES

If Stim is not installed globally, replace stim with npx stim.

  stim services                 # each declared service, running or not, its ports
  stim services start [name]    # start them, dependencies first; a running one stays
  stim services stop [name]     # stop them; their data and ports stay
  stim services env [name]      # export lines for this workspace's values (--json)

A project declares its services once in the services setting, usually in the
committed .stim.json, so every worktree gets its own copy on its own ports.
Stim never starts one on its own: run stim services start. stim start does not
start them either.

Each start, including revive, queues for a native build slot under
concurrency.maxBuilds. Queue progress goes to stderr, also with --json. The
slot covers the start command, then up to 60 seconds of readiness wait, releasing
when ready, on failure, timeout or cancellation. Running services, stop and
teardown hold no slot. Ctrl+C during a start exits 130 with STIM_CANCELLED.

KINDS

Without a stop command, start is a long-running process Stim supervises. It
starts detached with the service env, its output goes to
logs/service-<name>.log in the workspace, and Stim stops it by its captured
process identity, SIGTERM then SIGKILL after 5 seconds. It has no Stim parent,
so Stim never learns its exit code; stim services shows it stopped.
With a stop command, start must return once the service runs in the background
(docker compose up -d, a database CLI's start). Stim runs stop, teardown and
orphanTeardown instead of signalling, and tracks the service through its ports.

FIELDS

  start           the command (required): a string split on spaces, no shell,
                  quotes refuse; or an argv array
  stop            the command that stops it and keeps its data
  teardown        what removal runs instead of stop, to delete its data
                  also runs from home when the folder is gone if it names {id}
  orphanTeardown  overrides teardown for a gone folder; runs from home,
                  so it must name its target by id
  ready           a command that exits 0 once it serves; default: every port
                  listens, else it lives one second after the start. Waited
                  up to 60 seconds
  ports           named port labels it owns, a list, or an object of label to
                  the environment variable that receives the number (or null),
                  or to { "env": name, "reverse": false } for a port the app
                  never uses
  idEnv           a variable that receives the service id, <name>-<workspace
                  id>, stable for the workspace path, for per-workspace
                  container and volume names
  env             more variables; values may use placeholders
  cwd             its folder, relative to the workspace (default the
                  workspace), anywhere in its checkout, e.g. ../api
  dependsOn       services started before it and stopped after it; naming
                  another service's port also adds it

Commands and env values take placeholders, substituted per argument after
splitting, never through a shell: {<label>} one of its ports, {<service>.<label>}
another service's port, {id} the service id, {dir} its absolute folder. Write {{
and }} for literal braces. An unknown name refuses, so does a dependency cycle.
Ports come from the same pool as stim ports get, so stim ports get <label>
prints the number a service uses. Stop and teardown time out after 2 minutes,
start after 5. Each run's output goes to the workspace log (stim logs,
service_* events).

stim services start records each service as it resolved it: commands, folder,
ports and env. Later stops, revive and removal run only that record, never the
settings of the moment, and act only on services Stim started.

LIFECYCLE

- Idle: once the workspace has had no activity for idle.minutes (no Stim
  command, file edit, git write or commit, and no process or agent session
  working in its checkout), the idle pass stops its running services. Their
  ports stay. maintenance.keep and idle.minutes 0 keep them.
- While it runs, each port is reversed to the workspace's devices, as stim
  ports reverse does: the app reaches http://localhost:<port> on a local
  emulator, a hosted device (with stim start running) and a simulator. Stop
  and teardown drop the reverses. A failed reverse is reported, not fatal.
- stim revive starts again the services the idle pass stopped, before Metro,
  never one stim services stop or you stopped.
- worktree remove of a linked worktree (also gc and maintenance removing a
  finished one) runs teardown first, before anything else, else stop while the
  service runs. A failure refuses the removal and keeps the worktree, the
  record and its ports; stim status and stim services show teardownFailure
  with the command, folder and env to run by hand. --force drops them.
- A reclaim that keeps the folder (the source checkout, a subfolder project)
  stops the services and forgets them; the data stays. Once the folder is gone,
  gc runs orphanTeardown once, prints the command to run by hand if it fails,
  and forgets the service. A failed idle stop is retried after idle.minutes.
- A port held by a process Stim did not start for the service refuses the
  start. A record still running, even one that only partly came up, runs its
  start again.
- Later runs use the PATH of the stim services start that recorded the
  service; put any other variable a command needs in env.
- stim test passes the started services' env to the test command, so tests
  reach this workspace's services. stim services env prints the values the
  current settings resolve to.
- A service that writes into its checkout (a database folder, a cache) counts
  as a file edit, so it never idles; keep its data outside the checkout.
- stim status lists the started services and whether each runs.

EXAMPLES

A web server that takes its port as an argument:

  "services": { "web": { "ports": ["web"], "start": "python3 -m http.server {web}" } }

An API that listens before it answers, ready once its health URL does:

  "api": { "ports": ["api"], "start": "node api.js {api}", "ready": "curl -sf http://127.0.0.1:{api}/health" }

A mock API server, its port by environment:

  "mock": { "ports": { "mock": "PORT" }, "start": "node mock/server.js" }

A docker compose stack with postgres and redis:

  "deps": {
    "ports": { "pg": { "env": "PG_PORT", "reverse": false },
               "redis": { "env": "REDIS_PORT", "reverse": false } },
    "idEnv": "COMPOSE_PROJECT_NAME",
    "start": "docker compose up -d --wait",
    "stop": "docker compose stop",
    "teardown": "docker compose -p {id} down -v"
  }

The compose file must take its host ports from the environment
("\${PG_PORT:-5432}:5432"), set no container_name, and keep the project name
Stim passes, or two workspaces collide; a start that fails on a taken port or
container name says so.

A local Supabase stack in ../api, its CLI reading SUPABASE_* variables:

  "supabase": {
    "cwd": "../api",
    "ports": { "sb-api": "SUPABASE_API_PORT",
               "sb-db": { "env": "SUPABASE_DB_PORT", "reverse": false },
               "sb-shadow": { "env": "SUPABASE_DB_SHADOW_PORT", "reverse": false },
               "sb-studio": { "env": "SUPABASE_STUDIO_PORT", "reverse": false },
               "sb-smtp": { "env": "SUPABASE_LOCAL_SMTP_PORT", "reverse": false },
               "sb-analytics": { "env": "SUPABASE_ANALYTICS_PORT", "reverse": false } },
    "idEnv": "SUPABASE_PROJECT_ID",
    "env": { "SUPABASE_URL": "http://127.0.0.1:{sb-api}" },
    "start": "supabase start",
    "stop": "supabase stop",
    "teardown": "supabase stop --no-backup --project-id {id}",
    "ready": "supabase status"
  }

Map every port the stack binds, or a second workspace's start collides on it.

An API that needs the compose stack, and a webhook forwarder to the API; the
app reaches the API at http://localhost:{api.http} on its devices:

  "api": {
    "cwd": "../api",
    "ports": ["http"],
    "env": { "DATABASE_URL": "postgres://127.0.0.1:{deps.pg}/app" },
    "start": "serverless offline start --httpPort {http}"
  },
  "webhooks": { "start": "stripe listen --forward-to localhost:{api.http}/webhook" }

stim ports stays for a server you start yourself; Stim only reserves its port.`,
};
