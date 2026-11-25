export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DeviceRefusal {
  rule: 'command' | 'host-path' | 'request';
  message: string;
}

function appId(value: unknown): boolean {
  return typeof value === 'string' && !/[\\:/]/.test(value) && !value.includes(String.fromCharCode(0));
}

// agent-device rewrites remote screenshot destinations to this temp shape before downloading the artifact.
export function remoteScreenshot(value: unknown): boolean {
  return typeof value === 'string' && /^\/tmp\/agent-device-screenshot-\d+-[a-z0-9]+\.png$/.test(value);
}

// agent-device rewrites an explicit remote `record start` destination to this temp shape, keeping its extension.
function remoteRecording(value: unknown): boolean {
  return typeof value === 'string' && /^\/tmp\/agent-device-recording-\d+-[a-z0-9]+\.[A-Za-z0-9]{1,8}$/.test(value);
}

// agent-device's daemon stats a push payload as a host path before it reads inline JSON (payload-input.ts).
function inlineJsonObject(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text.startsWith('{') || !text.endsWith('}') || text.includes('/../')) return false;
  try {
    return isJsonObject(JSON.parse(text));
  } catch {
    return false;
  }
}

const openClose = (command: string) => (positionals: readonly unknown[]) =>
  positionals.every(appId)
    ? undefined
    : {
        rule: 'host-path' as const,
        message: `${command} on a hosted device accepts only installed app names or bundle ids, never paths or URLs.`,
      };

export const DEVICE_POSITIONAL_CHECKS: Readonly<
  Record<string, (positionals: readonly unknown[], params: Record<string, unknown>) => DeviceRefusal | undefined>
> = {
  open: openClose('Open'),
  close: openClose('Close'),
  screenshot: (positionals) =>
    positionals.every(remoteScreenshot)
      ? undefined
      : {
          rule: 'host-path',
          message: 'Screenshots use only agent-device remote artifacts.',
        },
  record: (positionals, params) => {
    const [action, output, ...rest] = positionals;
    if ((action !== 'start' && action !== 'stop') || rest.length > 0 || (action === 'stop' && output !== undefined))
      return {
        rule: 'command',
        message: 'Refused record: this connection allows only record start and record stop.',
      };
    if (output !== undefined && !remoteRecording(output))
      return {
        rule: 'host-path',
        message:
          "Refused record start: the hosting Mac writes a recording only in this session's private area and returns it through agent-device's remote download, so a host output path is refused.",
      };
    const meta = params.meta;
    if (
      action === 'start' &&
      !(
        isJsonObject(meta) &&
        isJsonObject(meta.clientArtifactPaths) &&
        typeof meta.clientArtifactPaths.outPath === 'string' &&
        meta.clientArtifactPaths.outPath.trim() !== ''
      )
    )
      return {
        rule: 'request',
        message:
          'Refused record start: it needs the local destination agent-device sends when it runs with --remote-config.',
      };
    return undefined;
  },
  push: (positionals) =>
    positionals.length === 2 && appId(positionals[0]) && inlineJsonObject(positionals[1])
      ? undefined
      : {
          rule: 'host-path',
          message:
            'Refused push: a hosted device takes push <bundle id> <inline JSON object>; a payload file on the hosting Mac is refused.',
        },
  artifacts: (positionals) =>
    positionals.length === 0
      ? undefined
      : {
          rule: 'request',
          message: 'Refused artifacts: a hosted device lists only its own session artifacts.',
        },
  settings: (positionals, params) => {
    // agent-device trims and lowercases the setting, its action and the permission target.
    const [setting, , target] = positionals.map((value) => String(value).trim().toLowerCase());
    if (setting === 'permission' && ['accessibility', 'screen-recording', 'input-monitoring'].includes(String(target)))
      return {
        rule: 'command',
        message: `Refused settings permission ${target}: it is a macOS permission of the hosting Mac.`,
      };
    const app = isJsonObject(params.input) ? params.input.app : undefined;
    if ((setting === 'clear-app-state' && !positionals.slice(1).every(appId)) || (app !== undefined && !appId(app)))
      return {
        rule: 'host-path',
        message: 'Settings on a hosted device accept only installed app names or bundle ids, never paths.',
      };
    return undefined;
  },
};

const CLIENT_SIDE = 'it runs in the agent-device client on your Mac, not on the hosted device.';
const STIM_INSTALLS = 'Stim installs the hosted app; an install reads app files on the hosting Mac.';

export const REFUSED_DEVICE_COMMANDS: Readonly<Record<string, string>> = {
  logs: 'its log files live on the hosting Mac; read the hosted app logs with stim logs.',
  trace: 'trace capture writes files on the hosting Mac.',
  audio: 'it samples the hosting Mac audio, not only the hosted device.',
  doctor: 'it inspects the hosting Mac tools and projects.',
  prepare: 'it builds and installs helpers on the hosting Mac; Stim prepares the hosted device.',
  boot: 'Stim boots the hosted device; boot can start other devices on the hosting Mac.',
  shutdown: 'Stim shuts the hosted device down; use stim stop.',
  install: STIM_INSTALLS,
  install_source: STIM_INSTALLS,
  release_materialized_paths: STIM_INSTALLS,
  runtime: "it sets the Metro address the hosted app loads; Stim's Metro bridge already does.",
  session_save_script: 'it writes a script file on the hosting Mac.',
  lease_allocate: 'Stim holds the lease for this connection.',
  lease_heartbeat: 'Stim holds the lease for this connection.',
  lease_release: 'Stim holds the lease for this connection.',
  reinstall: STIM_INSTALLS,
  'install-from-source': STIM_INSTALLS,
  uninstall:
    'Stim records the hosted app as installed and serves its logs and agent access from that record, which an uninstall would leave wrong.',
  replay: 'it reads a script file on the hosting Mac.',
  test: 'it reads script files on the hosting Mac.',
  clipboard:
    'a simulator can sync its pasteboard with the hosting Mac and an emulator shares the host clipboard by default, so it could read or write the hosting Mac clipboard.',
  hover: 'it drives web pages only.',
  viewport: 'it resizes web pages only.',
  'tv-remote': 'it drives TV devices only.',
  auth: CLIENT_SIDE,
  cdp: CLIENT_SIDE,
  connect: CLIENT_SIDE,
  connection: CLIENT_SIDE,
  daemon: CLIENT_SIDE,
  debug: CLIENT_SIDE,
  device: CLIENT_SIDE,
  disconnect: CLIENT_SIDE,
  mcp: CLIENT_SIDE,
  metro: CLIENT_SIDE,
  plugins: CLIENT_SIDE,
  proxy: CLIENT_SIDE,
  'react-devtools': CLIENT_SIDE,
  session: CLIENT_SIDE,
  takeover: CLIENT_SIDE,
  web: CLIENT_SIDE,
};

export const REFUSED_DEVICE_INPUTS: Readonly<Record<string, string>> = {
  out: '--out',
  saveScript: '--save-script',
  sessionSaveScript: 'sessionSaveScript',
  baseline: '--baseline',
  launchConsole: '--launch-console',
  launchArgs: '--launch-args',
  launchUrl: '--launch-url',
  bundleUrl: '--bundle-url',
  artifactsDir: '--artifacts-dir',
  stepsFile: '--steps-file',
  searchPath: '--search-path',
  retainPaths: '--retain-paths',
  installSource: 'installSource',
  metroProjectRoot: 'metroProjectRoot',
  metroRuntimeFile: 'metroRuntimeFile',
  iosXctestrunFile: 'iosXctestrunFile',
  iosXctestDerivedDataPath: 'iosXctestDerivedDataPath',
  iosXctestEnvDir: 'iosXctestEnvDir',
  developerDir: 'developerDir',
  artifact: '--artifact',
  dsym: '--dsym',
  reportJunit: '--report-junit',
  metroHost: '--metro-host',
  metroPort: '--metro-port',
  surface: '--surface',
  osVersion: '--os',
  imageTag: '--image-tag',
  physical: '--physical',
  deviceMode: '--device-mode',
  deviceBaseline: '--device-baseline',
  record: '--record',
  recordAs: '--record-as',
  screenshotFullscreen: '--fullscreen',
  perfTemplate: '--template',
  providerSessionId: '--provider-session',
};
