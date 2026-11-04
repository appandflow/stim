import { describe, expect, it } from 'vitest';
import { serverPermissionFindings } from '../diagnostics/server-permissions.ts';
import type { PermissionReading, SocketReading } from '../diagnostics/server-setup.ts';
import { health, reading, service, setup } from './_server-setup.ts';

const DIR_OK = { isDirectory: true, mode: 0o40700, uid: 501 };
const SOCKET_OK = { isSocket: true, mode: 0o140600, uid: 501 };
const socketReading = (over: Partial<SocketReading> = {}): SocketReading => ({
  path: '/Users/me/.stim/server/local.sock',
  dir: DIR_OK,
  socket: SOCKET_OK,
  uid: 501,
  ...over,
});

describe('socket permissions', () => {
  it('is quiet for an owner-only socket in a 0700 directory this user owns, or when there is no socket', () => {
    expect(serverPermissionFindings(setup({ socket: socketReading() }))).toEqual([]);
    expect(serverPermissionFindings(setup({ socket: socketReading({ dir: null, socket: null }) }))).toEqual([]);
    expect(serverPermissionFindings(setup({ socket: null }))).toEqual([]);
  });

  it.each([
    [
      'a world-readable directory',
      { dir: { ...DIR_OK, mode: 0o40755 } },
      'mode 755',
      'chmod 700 /Users/me/.stim/server',
    ],
    [
      'a group-writable socket',
      { socket: { ...SOCKET_OK, mode: 0o140660 } },
      'mode 660',
      'chmod 600 /Users/me/.stim/server/local.sock',
    ],
    [
      'a directory owned by another user',
      { dir: { ...DIR_OK, uid: 0 } },
      'uid 0',
      'sudo chown $USER /Users/me/.stim/server',
    ],
    [
      'a directory that is a symlink or file',
      { dir: { ...DIR_OK, isDirectory: false } },
      'is not a directory',
      'rm /Users/me/.stim/server',
    ],
  ])('reports %s with its command', (_name, over, problem, fix) => {
    const [finding] = serverPermissionFindings(setup({ socket: socketReading(over) }));
    expect(finding).toMatchObject({ code: 'server-socket-permissions', level: 'cost' });
    expect(finding?.detail).toContain(problem);
    expect(finding?.fix).toContain(fix);
  });
});

const permissions = (over: Partial<PermissionReading> = {}): PermissionReading => ({
  macosMajor: 27,
  external: [],
  logDenials: [],
  ...over,
});

const hostedServer = (over: { screenRecording?: boolean; accessibility?: boolean } = {}) =>
  reading({
    health: health({ host: { name: 'Stim Host', screenRecording: true, accessibility: true, ...over } }),
  });

describe('macOS permissions', () => {
  it('names the pane for the macOS version and treats it as a problem when this Mac hosts devices', () => {
    const [finding] = serverPermissionFindings(
      setup({
        servers: [hostedServer({ screenRecording: false })],
        permissions: permissions({ macosMajor: 15 }),
        clients: { build: 0, deviceHost: 1 },
      }),
    );
    expect(finding).toMatchObject({ code: 'server-macos-permission', level: 'cost' });
    expect(finding?.fix).toContain('Privacy & Security > Screen & System Audio Recording and turn on Stim Host');
    const [control] = serverPermissionFindings(
      setup({ servers: [hostedServer({ accessibility: false })], permissions: permissions({ macosMajor: 27 }) }),
    );
    expect(control).toMatchObject({ level: 'note' });
    expect(control?.fix).toContain('Device Control and Data Access');
  });

  it('is quiet when the host holds both grants or the server reports none', () => {
    expect(serverPermissionFindings(setup({ servers: [hostedServer()], permissions: permissions() }))).toEqual([]);
    expect(serverPermissionFindings(setup({ permissions: permissions() }))).toEqual([]);
  });

  const hostService = service({
    installed: { ...service().installed, host: '/Users/me/Applications/Stim Host.app/Contents/MacOS/stim-host' },
  });

  it('asks for Removable Volumes for the service launcher when listing the SDK volume is denied', () => {
    const [finding] = serverPermissionFindings(
      setup({
        services: [hostService],
        permissions: permissions({ external: [{ path: '/Volumes/ExternalSSD/Android/sdk', blocked: true }] }),
      }),
    );
    expect(finding?.title).toContain('external volume');
    expect(finding?.detail).toContain('/Volumes/ExternalSSD/Android/sdk');
    expect(finding?.fix).toContain('Removable Volumes for Stim Host');
  });

  it('takes a denial recorded in the service log as evidence, and names Stim Desktop for its own server', () => {
    const logDenials = [
      { label: 'dev.stim.server', line: "Error: EPERM: operation not permitted, scandir '/Volumes/ExternalSSD/avd'" },
    ];
    const [finding] = serverPermissionFindings(
      setup({ servers: [reading({ kind: 'desktop', label: undefined })], permissions: permissions({ logDenials }) }),
    );
    expect(finding?.detail).toContain('/Volumes/ExternalSSD/avd');
    expect(finding?.fix).toContain('Removable Volumes for Stim Desktop');
  });

  it('is quiet when an external volume lists fine', () => {
    expect(
      serverPermissionFindings(
        setup({ permissions: permissions({ external: [{ path: '/Volumes/X/sdk', blocked: false }] }) }),
      ),
    ).toEqual([]);
  });
});

describe('systemd lingering', () => {
  const unit = service({ manager: 'systemd' });
  it('recommends enable-linger for a user service that stops at logout, as a problem for a build worker', () => {
    const [worker] = serverPermissionFindings(
      setup({
        platform: 'linux',
        services: [unit],
        linger: { user: 'bot', enabled: false },
        clients: { build: 1, deviceHost: 0 },
      }),
    );
    expect(worker).toMatchObject({ code: 'server-linger', level: 'cost' });
    expect(worker?.fix).toBe('Run `sudo loginctl enable-linger bot`. Doctor does not run sudo.');
    const [other] = serverPermissionFindings(
      setup({ platform: 'linux', services: [unit], linger: { user: 'bot', enabled: false } }),
    );
    expect(other?.level).toBe('note');
  });

  it('is quiet with linger on or without a systemd service', () => {
    expect(
      serverPermissionFindings(setup({ platform: 'linux', services: [unit], linger: { user: 'bot', enabled: true } })),
    ).toEqual([]);
    expect(serverPermissionFindings(setup({ platform: 'linux', linger: null }))).toEqual([]);
  });
});
