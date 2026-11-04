import { createHash, randomBytes } from 'node:crypto';

/**
 * The `systemd-run` arguments that start `command` as a transient user service with the working directory `cwd` and
 * the variables `env` on top of the user manager's own environment. A service is forked by the user's systemd manager, so a command runner that adopts
 * and kills the descendants of a call (a subreaper, as `PR_SET_CHILD_SUBREAPER` makes one) cannot reach it; a new
 * session or process group does not escape such a runner. `KillMode=process` leaves a child the daemon started, such
 * as an adb server, running when the daemon exits, as it does outside a service. `--collect` unloads the unit when it
 * ends, and a nonce keeps a daemon that replaces a running one from colliding with its unit name.
 */
export function systemdDaemonArgs(cwd: string, env: NodeJS.ProcessEnv, command: readonly string[]): string[] {
  const home = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return [
    '--user',
    '--quiet',
    '--collect',
    `--unit=stim-daemon-${home}-${randomBytes(3).toString('hex')}`,
    '--property=KillMode=process',
    `--working-directory=${cwd}`,
    ...Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [`--setenv=${name}=${value}`])),
    '--',
    ...command,
  ];
}
