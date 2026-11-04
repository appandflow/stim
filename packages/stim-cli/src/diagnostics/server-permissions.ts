import { basename, dirname } from 'node:path';
import { permissionPanes } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';
import type { InstalledServerService, ServerReading, ServerSetup } from './server-setup.ts';

const OWNER_ONLY = 0o077;

const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, '0');

function socketFindings(setup: ServerSetup): Finding[] {
  const { socket } = setup;
  if (!socket || (!socket.socket && !socket.dir)) return [];
  const problems: string[] = [];
  const fixes: string[] = [];
  const dir = dirname(socket.path);
  if (socket.dir) {
    if (!socket.dir.isDirectory) {
      problems.push(`${dir} is not a directory`);
      fixes.push(`Remove it (\`rm ${dir}\`) and restart stim-server, which creates it with mode 700`);
    } else {
      if (socket.dir.uid !== socket.uid) {
        problems.push(`${dir} belongs to uid ${socket.dir.uid}, not to this user (uid ${socket.uid})`);
        fixes.push(`\`sudo chown $USER ${dir}\``);
      }
      if (socket.dir.mode & OWNER_ONLY) {
        problems.push(`${dir} has mode ${octal(socket.dir.mode)}, so other users can reach the socket inside`);
        fixes.push(`\`chmod 700 ${dir}\``);
      }
    }
  }
  if (socket.socket) {
    if (socket.socket.uid !== socket.uid) {
      problems.push(`${socket.path} belongs to uid ${socket.socket.uid}`);
      fixes.push(`\`sudo chown $USER ${socket.path}\``);
    }
    if (socket.socket.mode & OWNER_ONLY) {
      problems.push(`${socket.path} has mode ${octal(socket.socket.mode)}, not 600`);
      fixes.push(`\`chmod 600 ${socket.path}\``);
    }
  }
  if (problems.length === 0) return [];
  return [
    {
      code: 'server-socket-permissions',
      level: 'cost',
      title: "The Stim home's stim-server socket is not private to this user",
      detail: `${problems.join('; ')}. The socket answers without pairing or a key, and Stim Desktop's write authority on a server without Desktop's key depends on only this user being able to open it.`,
      fix: `${fixes.join('; ')}. Then restart stim-server.`,
    },
  ];
}

const appName = (host: string): string => basename(dirname(dirname(dirname(host))), '.app');

function responsibleApp(server: ServerReading | undefined, services: readonly InstalledServerService[]): string {
  if (server?.kind === 'desktop') return 'Stim Desktop';
  const service = services.find((each) => each.label === server?.label) ?? services[0];
  return service?.installed.host ? appName(service.installed.host) : 'the node binary that runs stim-server';
}

function macosFindings(setup: ServerSetup): Finding[] {
  const { permissions } = setup;
  if (!permissions) return [];
  const panes = permissionPanes(permissions.macosMajor);
  const findings: Finding[] = [];
  const hosted = setup.clients.deviceHost > 0;
  for (const server of setup.servers) {
    const host = server.health?.host;
    if (!host || server.kind === 'share') continue;
    for (const [granted, pane, needed] of [
      [host.screenRecording, panes.screen, "live device views and the frames of a hosted device's screen"],
      [host.accessibility, panes.control, 'sending touch and keyboard input to a hosted or shared device'],
    ] as const) {
      if (granted) continue;
      findings.push({
        code: 'server-macos-permission',
        level: hosted ? 'cost' : 'note',
        title: `${host.name} lacks the ${pane} permission`,
        detail: `${describeApp(server)} runs under ${host.name}, and macOS has not granted it ${pane}, which it needs for ${needed}.`,
        fix: `Open System Settings > Privacy & Security > ${pane} and turn on ${host.name}. Doctor does not change macOS permissions.`,
      });
    }
  }
  const blocked = permissions.external.filter((each) => each.blocked);
  if (blocked.length > 0 || permissions.logDenials.length > 0) {
    const app = responsibleApp(
      setup.servers.find((server) => server.kind !== 'share'),
      setup.services,
    );
    const where =
      blocked.length > 0
        ? `listing ${blocked.map((each) => each.path).join(', ')} failed with a macOS privacy denial for the app running doctor`
        : `${permissions.logDenials[0]?.label ?? 'the service'}'s log reports a denied read under /Volumes: ${permissions.logDenials[0]?.line}`;
    findings.push({
      code: 'server-macos-permission',
      level: 'cost',
      title: 'macOS blocks the Android SDK or AVDs on an external volume',
      detail: `${where}. The server reads the SDK and AVDs on that volume for Android builds and emulators, and a denial fails them with a permission error.`,
      fix: `Open System Settings > Privacy & Security > Files & Folders, turn on Removable Volumes for ${app} (or give it Full Disk Access), then restart the app or service. Doctor does not change macOS permissions.`,
    });
  }
  return findings;
}

const describeApp = (server: ServerReading): string =>
  server.kind === 'service' ? `The ${server.label} service` : `The stim-server on port ${server.port}`;

function lingerFindings(setup: ServerSetup): Finding[] {
  const { linger } = setup;
  if (!linger || linger.enabled) return [];
  const serves = setup.clients.build + setup.clients.deviceHost > 0;
  const unit = setup.services.find((service) => service.manager === 'systemd');
  return [
    {
      code: 'server-linger',
      level: serves ? 'cost' : 'note',
      title: 'The stim-server systemd user service stops when you log out',
      detail: `${unit ? `The ${unit.label} service runs` : 'The service runs'} in ${linger.user}'s systemd user manager, which stops at the last logout and does not start at boot, so ${serves ? 'machines that approved builds or devices here' : 'paired devices'} lose the server whenever no session is open.`,
      fix: `Run \`sudo loginctl enable-linger ${linger.user}\`. Doctor does not run sudo.`,
    },
  ];
}

export function serverPermissionFindings(setup: ServerSetup): Finding[] {
  return [...socketFindings(setup), ...macosFindings(setup), ...lingerFindings(setup)];
}
