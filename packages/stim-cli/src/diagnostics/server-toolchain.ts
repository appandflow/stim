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

/** launchd gives a user agent this `PATH`; stim-server runs its tool discovery over it, then applies `--env` and `--path-prepend`. */
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
  const launchd = { HOME: home, PATH: LAUNCHD_PATH.join(delimiter) };
  const { entries } = discoverToolchain(launchd, { ...probe, home, execPath: service.node ?? probe.execPath });
  const pinned = new Map(
    service.env.flatMap((entry): Array<[string, string]> => {
      const equals = entry.indexOf('=');
      return equals > 0 ? [[entry.slice(0, equals), entry.slice(equals + 1)]] : [];
    }),
  );
  return entries.map((entry) =>
    pinned.has(entry.name)
      ? { name: entry.name, value: pinned.get(entry.name) ?? entry.value, source: 'environment' }
      : entry,
  );
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
        fix: `If a volume is unmounted, mount it. Otherwise run \`stim-server service install${labelFlag(service.label)}${service.installed.port === null ? '' : ` --port ${service.installed.port}`}\` again from a shell where the tool is installed, repeating any --env and --path-prepend (\`stim-server service status\` lists them).`,
      },
    ];
  });
}
