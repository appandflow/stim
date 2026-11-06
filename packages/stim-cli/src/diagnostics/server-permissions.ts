import { basename, dirname } from 'node:path';
import { permissionPanes } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';
import type { InstalledServerService, ServerReading, ServerSetup } from './server-setup.ts';

const OWNER_ONLY = 0o077;
const SERVER_START_LINE = /^stim-server \S+ \(stim /;

export function volumeDenialSinceStart(log: string): string | null {
  const lines = log.split('\n');
  const line = lines
    .slice(lines.findLastIndex((each) => SERVER_START_LINE.test(each)) + 1)
    .findLast((each) => /EPERM|Operation not permitted/i.test(each) && each.includes('/Volumes/'));
  return line ? line.trim().slice(0, 300) : null;
}

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
      fixes.push(`Remove it (\`rm ${dir}\`) and restart stim serve, which creates it with mode 700`);
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
      title: "The Stim home's stimd socket is not private to this user",
      detail: `${problems.join('; ')}. The socket answers without pairing or a key, so only this user may open it.`,
      fix: `${fixes.join('; ')}. Then run any stim command, which starts stimd again once it exits.`,
    },
  ];
}

const appName = (host: string): string => basename(dirname(dirname(dirname(host))), '.app');

const serviceApp = (service: InstalledServerService | undefined): string =>
  service?.installed.host ? appName(service.installed.host) : 'the node binary that runs stim-server';

const grant = (app: string) =>
  `Open System Settings > Privacy & Security > Files & Folders, turn on Removable Volumes for ${app} (or give it Full Disk Access), then restart it. Doctor does not change macOS permissions.`;

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
  const title = 'macOS blocks the Android SDK or AVDs on an external volume';
  if (blocked.length > 0) {
    findings.push({
      code: 'server-macos-permission',
      level: 'cost',
      title,
      detail: `Listing ${blocked.map((each) => each.path).join(', ')} failed with a macOS privacy denial for the process running doctor. A server needs the same permission for its own app, or Android builds and emulators on that volume fail.`,
      fix: grant(
        permissions.doctorApp ??
          'the app that runs stim (your terminal or agent app) and the app each stim-server runs under',
      ),
    });
  }
  for (const denial of permissions.logDenials) {
    findings.push({
      code: 'server-macos-permission',
      level: 'cost',
      title,
      detail: `The ${denial.label} service's log reports a denied read under /Volumes since it last started: ${denial.line}. The server reads the SDK and AVDs on that volume for Android builds and emulators.`,
      fix: grant(serviceApp(setup.services.find((service) => service.label === denial.label))),
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
