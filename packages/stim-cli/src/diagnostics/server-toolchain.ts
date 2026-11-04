import { delimiter } from 'node:path';
import type { InstalledService } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';
import { labelFlag, type ServerSetup } from './server-setup.ts';

/** The variables whose value is a directory or file a build needs, when a service pins one with `--env`. */
const PATH_VARIABLES = new Set(['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GEM_HOME']);

/** The default `PATH` launchd gives a user agent, and so the job's before the server reads the login shell. */
const LAUNCHD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Every path a service file records that a start depends on: its launcher, node, server script, the `--path-prepend`
 * directories, and the value of each pinned path variable.
 */
export function servicePaths(service: InstalledService): string[] {
  const pinned = service.env.flatMap((entry) => {
    const equals = entry.indexOf('=');
    return equals > 0 && PATH_VARIABLES.has(entry.slice(0, equals)) ? [entry.slice(equals + 1)] : [];
  });
  return [
    ...(service.host ? [service.host] : []),
    ...(service.node ? [service.node] : []),
    ...(service.script ? [service.script] : []),
    ...service.pathPrepend,
    ...pinned,
  ];
}

/**
 * The environment a service's recorded settings give its server before the login shell's: `--path-prepend` in front of
 * launchd's default `PATH`, plus each `--env` entry. The server applies the login shell's environment first, so this
 * is what discovery falls back on, not the whole environment.
 */
export function serviceToolchainEnv(service: InstalledService, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: [...service.pathPrepend, ...LAUNCHD_PATH].join(delimiter) };
  for (const entry of service.env) {
    const equals = entry.indexOf('=');
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

/** A service file that names a launcher, node, script or directory that is gone: the service cannot start or find its tools. */
export function serviceToolchainFindings(setup: ServerSetup): Finding[] {
  const missing = new Set(setup.missingPaths);
  return setup.services.flatMap((service): Finding[] => {
    const gone = [...new Set(servicePaths(service.installed))].filter((path) => missing.has(path));
    if (gone.length === 0) return [];
    const starts = [service.installed.host, service.installed.node, service.installed.script].some(
      (path) => path !== null && gone.includes(path),
    );
    return [
      {
        code: 'server-service-paths',
        level: starts ? 'cost' : 'note',
        title: `The ${service.label} service names ${gone.length === 1 ? 'a path' : 'paths'} that no longer exist`,
        detail: `${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} missing${starts ? ', so the service cannot start' : ', so the server will not find the tools they provide'}. A Homebrew or nvm upgrade removes the versioned directory that a service file pinned.`,
        fix: `Run \`stim-server service install${labelFlag(service.label)}${service.installed.port === null ? '' : ` --port ${service.installed.port}`}\` again from a shell where the tool is installed, repeating any --env and --path-prepend (\`stim-server service status\` lists them).`,
      },
    ];
  });
}
