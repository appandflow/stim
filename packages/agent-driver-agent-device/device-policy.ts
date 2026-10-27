import { isJsonObject } from '@stim-cli/core/state';

/**
 * What a hosted client may send with one agent-device command. `flags` and `refused` classify every flag
 * `agent-device help <command>` lists, by its first spelling, with the request key the client sends for it.
 */
export interface DeviceCommandRule {
  flags?: Readonly<Record<string, string>>;
  refused?: Readonly<Record<string, string>>;
  /** Request keys the client derives from positionals or sends as structured `input` fields. */
  keys?: readonly string[];
  positionals?: (positionals: readonly unknown[], params: Record<string, unknown>) => DeviceRefusal | undefined;
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

const SNAPSHOT_VIEW = { '--depth': 'snapshotDepth', '--scope': 'snapshotScope', '--raw': 'snapshotRaw' };
const SETTLE = { '--settle': 'settle', '--settle-quiet': 'settleQuietMs', '--timeout': 'timeoutMs' };
const PRESS = {
  '--count': 'count',
  '--interval-ms': 'intervalMs',
  '--hold-ms': 'holdMs',
  '--jitter-px': 'jitterPx',
  '--double-tap': 'doubleTap',
  '--verify': 'verify',
};
const REPAIR_RECORDING = { '--record': 'record' };

/** The commands a hosted iOS simulator or Android emulator client may run, all scoped to that one device. */
export const DEVICE_COMMAND_RULES: Readonly<Record<string, DeviceCommandRule>> = {
  open: {
    flags: {
      '--test-ime': 'testIme',
      '--no-test-ime': 'testIme',
      '--activity': 'activity',
      '--relaunch': 'relaunch',
      '--foreground': 'foreground',
      '--no-record': 'noRecord',
      '--timeout': 'timeoutMs',
      '--wait': 'waitMs',
    },
    refused: {
      '--force': 'force',
      '--surface': 'surface',
      '--metro-host': 'metroHost',
      '--metro-port': 'metroPort',
      '--bundle-url': 'bundleUrl',
      '--launch-url': 'launchUrl',
      '--launch-console': 'launchConsole',
      '--launch-args': 'launchArgs',
      '--save-script': 'saveScript',
    },
    positionals: openClose('Open'),
  },
  close: {
    refused: { '--force': 'force', '--save-script': 'saveScript', '--shutdown': 'shutdown' },
    positionals: openClose('Close'),
  },
  snapshot: {
    flags: {
      '-i': 'snapshotInteractiveOnly',
      ...SNAPSHOT_VIEW,
      '--diff': 'snapshotDiff',
      '--timeout': 'timeoutMs',
      '--actions': 'snapshotCustomActions',
      '--observe-only': 'snapshotObserveOnly',
      '--force-full': 'snapshotForceFull',
    },
    refused: REPAIR_RECORDING,
  },
  wait: { flags: SNAPSHOT_VIEW, keys: ['durationMs', 'timeoutMs'] },
  find: {
    flags: { '--depth': 'snapshotDepth', '--raw': 'snapshotRaw', '--first': 'findFirst', '--last': 'findLast' },
    refused: REPAIR_RECORDING,
    keys: ['timeoutMs'],
  },
  get: { flags: SNAPSHOT_VIEW, refused: REPAIR_RECORDING },
  is: { flags: SNAPSHOT_VIEW, refused: REPAIR_RECORDING },
  click: { flags: { ...PRESS, ...SETTLE, '--button': 'clickButton', ...SNAPSHOT_VIEW } },
  fill: {
    flags: { '--delay-ms': 'delayMs', '--text-stdin': 'textStdin', '--verify': 'verify', ...SETTLE, ...SNAPSHOT_VIEW },
    refused: { '--record-as': 'recordAs' },
  },
  press: { flags: { ...PRESS, ...SETTLE, ...SNAPSHOT_VIEW } },
  type: { flags: { '--delay-ms': 'delayMs' } },
  focus: {},
  scroll: {
    flags: {
      '--duration-ms': 'durationMs',
      '--pixels': 'pixels',
      '--until': 'until',
      '--max-passes': 'maxPasses',
      ...SETTLE,
    },
  },
  screenshot: {
    flags: {
      '--out': 'out',
      '--overlay-refs': 'overlayRefs',
      '--crop-on': 'screenshotCropOn',
      '--pixel-density': 'screenshotPixelDensity',
      '--scale': 'screenshotScale',
      '--no-stabilize': 'screenshotNoStabilize',
      '--normalize-status-bar': 'screenshotNormalizeStatusBar',
    },
    refused: { '--fullscreen': 'screenshotFullscreen' },
    positionals: (positionals) =>
      positionals.every(remoteScreenshot)
        ? undefined
        : {
            rule: 'host-path',
            message: 'Screenshots use only agent-device remote artifacts.',
          },
  },
  batch: {
    flags: { '--steps': 'batchSteps', '--on-error': 'batchOnError', '--max-steps': 'batchMaxSteps' },
    refused: { '--steps-file': 'stepsFile', '--out': 'out' },
  },
  devices: {},
  diff: {
    flags: {
      '-i': 'snapshotInteractiveOnly',
      ...SNAPSHOT_VIEW,
      '--overlay-refs': 'overlayRefs',
      '--threshold': 'threshold',
    },
    refused: { '--out': 'out', '--baseline': 'baseline' },
    keys: ['kind'],
  },
  longpress: { flags: { ...SETTLE, ...SNAPSHOT_VIEW }, keys: ['durationMs'] },
  swipe: { flags: { '--count': 'count', '--pause-ms': 'pauseMs', '--pattern': 'pattern' }, keys: ['from', 'to'] },
  back: { flags: { ...SETTLE, '--in-app': 'backMode', '--system': 'backMode' } },
  home: {},
  orientation: {},
  appstate: {},
  alert: { keys: ['timeoutMs'] },
  record: {
    flags: {
      '--fps': 'fps',
      '--quality': 'quality',
      '--hide-touches': 'hideTouches',
      '--scope': 'recordingScope',
      '--out': 'out',
    },
    positionals: (positionals, params) => {
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
  },
  'action-button': {},
  'app-switcher': {},
  apps: { flags: { '--all': 'appsFilter' } },
  capabilities: {},
  events: {},
  fold: { flags: { '--keyframes': 'keyframes' } },
  gesture: {
    flags: { '--count': 'count', '--pointer-count': 'pointerCount', '--hold-ms': 'holdMs', '--pause-ms': 'pauseMs' },
    keys: [
      'kind',
      'deviceTarget',
      'origin',
      'delta',
      'durationMs',
      'direction',
      'distance',
      'preset',
      'scale',
      'degrees',
      'points',
      'source',
      'destination',
      'sourceHoldMs',
      'moveMs',
      'destinationHoldMs',
    ],
  },
  'hardware-button': {},
  keyboard: {},
  'react-native': {},
  telephony: {},
  'trigger-app-event': {},
  network: { flags: { '--include': 'networkInclude' } },
  push: {
    positionals: (positionals) =>
      positionals.length === 2 && appId(positionals[0]) && inlineJsonObject(positionals[1])
        ? undefined
        : {
            rule: 'host-path',
            message:
              'Refused push: a hosted device takes push <bundle id> <inline JSON object>; a payload file on the hosting Mac is refused.',
          },
  },
  perf: {
    refused: { '--kind': 'kind', '--template': 'perfTemplate', '--out': 'out' },
    positionals: (positionals) =>
      (positionals.length === 1 && positionals[0] === 'frames') ||
      (positionals.length === 2 && positionals[0] === 'memory' && positionals[1] === 'sample')
        ? undefined
        : {
            rule: 'host-path',
            message:
              'Refused perf: a hosted device allows only perf frames and perf memory sample; snapshots, profiles and traces write files on the hosting Mac.',
          },
  },
  artifacts: {
    refused: { '--provider': 'provider', '--provider-session': 'providerSessionId' },
    positionals: (positionals) =>
      positionals.length === 0
        ? undefined
        : {
            rule: 'request',
            message: 'Refused artifacts: a hosted device lists only its own session artifacts.',
          },
  },
  settings: {
    flags: { '--app': 'app' },
    positionals: (positionals, params) => {
      if (
        positionals[0] === 'permission' &&
        ['accessibility', 'screen-recording', 'input-monitoring'].includes(String(positionals[2]))
      )
        return {
          rule: 'command',
          message: `Refused settings permission ${String(positionals[2])}: it is a macOS permission of the hosting Mac.`,
        };
      const app = isJsonObject(params.input) ? params.input.app : undefined;
      if (
        (positionals[0] === 'clear-app-state' && positionals[1] !== undefined && !appId(positionals[1])) ||
        (app !== undefined && !appId(app))
      )
        return {
          rule: 'host-path',
          message: 'Settings on a hosted device accept only installed app names or bundle ids, never paths.',
        };
      return undefined;
    },
  },
};

const CLIENT_SIDE = 'it runs in the agent-device client on your Mac, not on the hosted device.';
const STIM_INSTALLS = 'Stim installs the hosted app; an install reads app files on the hosting Mac.';

/** Every other agent-device command, with the reason a hosted client cannot run it. */
export const REFUSED_DEVICE_COMMANDS: Readonly<Record<string, string>> = {
  logs: 'its log files live on the hosting Mac; read the hosted app logs with stim logs.',
  trace: 'trace capture writes files on the hosting Mac.',
  audio: 'it samples the hosting Mac audio, not only the hosted device.',
  doctor: 'it inspects the hosting Mac tools and projects.',
  prepare: 'it builds and installs helpers on the hosting Mac; Stim prepares the hosted device.',
  boot: 'Stim boots the hosted device; boot can start other devices on the hosting Mac.',
  shutdown: 'Stim shuts the hosted device down; use stim stop.',
  install: STIM_INSTALLS,
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
