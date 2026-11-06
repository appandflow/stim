import { delimiter } from 'node:path';
import type { InstalledService } from '@stim-cli/core/state';
import {
  defaultToolchainProbe,
  discoverToolchain,
  type ToolchainEntry,
  type ToolchainProbe,
} from '@stim-cli/core/toolchain';
import type { Finding } from './doctor.ts';
import { labelFlag, type ServerSetup } from './server-setup.ts';

const PATH_VARIABLES = new Set(['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GEM_HOME']);

/** launchd gives a user agent this `PATH`. The plist carries `--env` values in its environment, so stim-server's tool discovery starts from them. */
const LAUNCHD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

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

export function serviceToolchainEntries(
  service: InstalledService,
  home: string,
  probe: ToolchainProbe = defaultToolchainProbe(),
): ToolchainEntry[] {
  const pinned: Record<string, string> = {};
  for (const entry of service.env) {
    const equals = entry.indexOf('=');
    if (equals > 0) pinned[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  const path = [...service.pathPrepend, pinned.PATH ?? LAUNCHD_PATH.join(delimiter)].join(delimiter);
  const base = { HOME: home, ...pinned, PATH: path };
  return discoverToolchain(base, { ...probe, home, execPath: service.node ?? probe.execPath }).entries;
}

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
        detail: `${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} missing${starts ? ', so the service cannot start' : ', so the server will not find the tools they provide'}. A Homebrew or nvm upgrade removes the versioned directory a service file pinned, and a path on an unmounted volume looks the same.`,
        fix: `If a volume is unmounted, mount it. Otherwise run \`stim service install${labelFlag(service.label)}${service.installed.port === null ? '' : ` --port ${service.installed.port}`}\` again from a shell where the tool is installed, repeating any --env and --path-prepend (\`stim service status\` lists them).`,
      },
    ];
  });
}
