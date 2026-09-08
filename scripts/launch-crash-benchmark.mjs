import { createHash } from 'node:crypto';
import {
  commandWithReportedStatus,
  shellCommandSegments,
  topLevelShellCommand,
} from './agent-benchmark/run-guards.mjs';

export function launchCrashToken(runId) {
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 12).toUpperCase();
  return `STIM_BENCH_LAUNCH_CRASH_${digest}`;
}

export function changedPathsFromGitOutputs(...outputs) {
  return [
    ...new Set(
      outputs.flatMap((output) =>
        String(output ?? '')
          .split('\0')
          .filter(Boolean),
      ),
    ),
  ].toSorted();
}

export function injectRootRenderCrash(source, token) {
  if (!/^STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}$/.test(token)) {
    throw new Error('launch-crash token has an unexpected format');
  }
  if (source.includes(token)) throw new Error('launch-crash token is already present');
  const rootLayout = 'export default function RootLayout() {\n';
  const at = source.indexOf(rootLayout);
  if (at === -1) throw new Error('RootLayout function was not found');
  const insertion = at + rootLayout.length;
  return `${source.slice(0, insertion)}  throw new Error('${token}');\n${source.slice(insertion)}`;
}

function successful(command) {
  return commandWithReportedStatus(command).exitCode === 0;
}

function completedStepCommand(command, arm) {
  const body = topLevelShellCommand(commandWithReportedStatus(command).command);
  if (arm !== 'stim') return body;
  return /[&|]\s*$/.test(body) ? '' : (shellCommandSegments(body).at(-1) ?? '');
}

function successfulLaunch(command, arm, platform) {
  if (!successful(command)) return false;
  const value = shellCommand(command.command);
  if (!/\|\s*tee\b/.test(value)) return launchCommand(completedStepCommand(command, arm), arm, platform);
  if (!launchCommand(command.command, arm, platform)) return false;
  const prefix = value.match(
    /^(?:cd\s+(?:[^\s'"$`\\;&|]+|'[^'\n]+'|"[^"$`\n]+")\s*&&\s*)?set -(?:o|eo|euo) pipefail\s*(?:&&|;|\n)\s*/,
  );
  if (!prefix) return false;
  if (/^cd\s/.test(prefix[0]) && !/&&\s*$/.test(prefix[0])) return false;
  let pipeline = value.slice(prefix[0].length);
  const report = /;\s*echo "PIPELINE_EXIT=\$\?"\s*$/.exec(pipeline);
  if (report) {
    const statuses = [...String(command.output ?? '').matchAll(/^PIPELINE_EXIT=(\d+)\s*$/gm)];
    if (statuses.length !== 1 || statuses[0][1] !== '0') return false;
    pipeline = pipeline.slice(0, report.index);
  }
  const [launch, ...filters] = pipeline.replace(/\s+2>&1(?=\s|$)/g, '').split(/\s*\|\s*/);
  const group = /^\{\s*([\s\S]*?);\s*\}$/.exec(launch);
  const launches = group ? shellCommandSegments(group[1]) : [launch];
  return (
    launches.length > 0 &&
    launches.every((entry) => launchCommand(entry, arm, platform) && !/[;&\n$`]/.test(entry)) &&
    filters.length > 0 &&
    filters.every((filter) => /^(?:tee(?: -a)? [\w/.-]+|(?:tail|head) -(?:\d+|n \d+))\s*$/.test(filter))
  );
}

function shellCommand(command) {
  return topLevelShellCommand(command).replace(
    /^"\$ANDROID_HOME\/(?:platform-tools\/(adb)|emulator\/(emulator)|cmdline-tools\/latest\/bin\/(avdmanager|sdkmanager))"(?=\s|$)/,
    (_, adb, emulator, sdkTool) => adb ?? emulator ?? sdkTool,
  );
}

function launchCommand(command, arm, platform) {
  command = shellCommand(command);
  if (arm === 'stim')
    return shellCommandSegments(command).some((segment) => new RegExp(`^stim\\s+${platform}(?:\\s|$)`).test(segment));
  if (platform === 'android') {
    return (
      /(?:\bexpo|expo\/bin\/cli|node_modules\/\.bin\/expo)\s+run:android\b/.test(command) ||
      /\bgradlew\b[^\n]*(?:install|connected)\w*|\badb\s+(?:-s\s+\S+\s+)?shell\s+am\s+start\b/.test(command)
    );
  }
  return (
    /(?:\bexpo|expo\/bin\/cli|node_modules\/\.bin\/expo)\s+run:ios\b/.test(command) ||
    /\bxcrun\s+simctl\s+(?:launch|openurl)\b/.test(command)
  );
}

function errorCaptureCommand(command, arm, platform) {
  command = shellCommand(command);
  if (arm === 'stim')
    return shellCommandSegments(command).some((segment) => /^stim\s+logs\s+--errors(?:\s|$)/.test(segment));
  const explicitLogFile =
    /\b(?:tail|rg|grep|sed|cat)\b[\s\S]*(?:\.log\b|(?:^|[\s'"])(?:\.?\/)?(?:tmp|logs?|\.expo\/dev\/logs)\/)/.test(
      command,
    );
  if (platform === 'android') return /\badb\s+(?:-s\s+\S+\s+)?logcat\b/.test(command) || explicitLogFile;
  return /\bxcrun\s+simctl\s+spawn\b|\blog\s+(?:show|stream)\b/.test(command) || explicitLogFile;
}

function timestamp(command, field) {
  const value = Date.parse(command[field] ?? command.endedAt);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function orderedCommands(commands) {
  return commands
    .map((command, originalIndex) => ({ ...command, originalIndex }))
    .toSorted(
      (left, right) =>
        timestamp(left, 'startedAt') - timestamp(right, 'startedAt') || left.originalIndex - right.originalIndex,
    );
}

function sourceInspectionBeforeCapture(command, arm, platform) {
  const value = shellCommand(command).replace(/\\([A-Za-z_.])/g, '$1');
  if (/(?:\/(?:skills|skill)\/[^\s]+\/|(?:^|\s)workspace\/)SKILL\.md\b/.test(value)) return false;
  if (
    shellCommandSegments(value).some(
      (segment) => /^(?:rg|grep)\b/.test(segment) && /\s(?:\.|app|src)\/?\s*$/.test(segment),
    )
  )
    return true;
  if (/(?:^|[;&|]\s*)git\s+(?:diff|show)(?!-ref)(?:\s|$)/.test(value)) return true;
  if (/(?:^|[;&|]\s*)(?:\/[^\s]+\/)?(?:node|python\d*|ruby|perl)\s+(?:-[^-\s]*[ec]|--eval)\b/.test(value)) {
    return true;
  }
  const namesSource = /(?:^|[\s'"`])(?:app|src)\/|\.(?:[cm]?[jt]sx?|swift|kt|java)(?:[\s'"`]|$)/.test(value);
  if (namesSource) return true;
  if (/RootLayout|STIM_BENCH_LAUNCH_CRASH_/.test(value) && !errorCaptureCommand(value, arm, platform)) return true;
  return false;
}

function scopedCopyLoop(value, setup) {
  const match = value.match(/^set -e\n([A-Za-z_]\w*)=([^\s;$`]+)\nfor ([A-Za-z_]\w*) in ([^;]+); do\n([\s\S]+)\ndone$/);
  if (!match || !setup.worktree || match[2] !== setup.worktree) return false;
  const [, destination, , item, paths, body] = match;
  const allowedPaths = new Set([
    'node_modules',
    'android/.gradle',
    'android/build',
    'android/.cxx',
    'android/app/build',
    'android/app/.cxx',
    'android/local.properties',
    'ios/Pods',
    'ios/build',
  ]);
  if (
    !paths
      .trim()
      .split(/\s+/)
      .every((path) => allowedPaths.has(path))
  )
    return false;
  const expected = [
    `if [ -e "$${item}" ]; then`,
    `mkdir -p "$${destination}/$(dirname "$${item}")"`,
    `rsync -a --exclude='generated/autolinking/' "$${item}" "$${destination}/$(dirname "$${item}")/"`,
    'fi',
  ];
  return (
    body
      .split('\n')
      .map((line) => line.trim())
      .join('\n') === expected.join('\n')
  );
}

function ownedAvdEdit(value, setup) {
  if (!setup.avdConfig) return false;
  const match = value.match(/^tool:(file_change|Edit|Write) ([\s\S]+)$/);
  if (!match) return false;
  try {
    const payload = JSON.parse(match[2]);
    const changes = match[1] === 'file_change' ? payload : [{ path: payload.file_path }];
    return Array.isArray(changes) && changes.length > 0 && changes.every((change) => change.path === setup.avdConfig);
  } catch {
    return false;
  }
}

function avdMetadataRead(value, setup) {
  const query = value.replace(/\s+\|\|\s+true$/, '');
  const match = query.match(
    /^(?:cat(?:\s+-n)?|(?:rg|grep)(?:\s+-[nEiFv]+)*\s+(?:'[^']*'|"[^"$`]*"|[A-Za-z0-9_.^=:-]+))\s+([^\s'";]+\.ini)$/,
  );
  if (!match || /`|\$\(/.test(query) || shellCommandSegments(query).length !== 1) return false;
  const target = match[1];
  return target === setup.avdConfig || /^\/[^\s;]+\/TemporaryItems\/avd\/running\/pid_\d+\.ini$/.test(target);
}

function allowedBeforeErrorCapture(command, arm, platform, setup = {}) {
  const value = shellCommand(command);
  if (/^(?:stim\s+(?:guide|doctor|worktree\s+warm)\b|rsync\b|pgrep\b|sed\b|cat\b)/.test(value)) {
    const segments = shellCommandSegments(value);
    if (segments.length > 1)
      return segments.every((segment) => allowedBeforeErrorCapture(segment, arm, platform, setup));
  }
  if (/^tool:todo_list\b/.test(value)) return true;
  if (/^(?:env\s+)?(?:[^\s=]+=[^\s]+\s+)*agent-device\s+/.test(value)) return true;
  if (
    platform === 'ios' &&
    /xcrun\s+simctl\s+get_app_container\b/.test(value) &&
    /plutil\s+-p\s+[^;&|]*Info\.plist\b/.test(value) &&
    /CFBundleURLSchemes/.test(value)
  ) {
    return true;
  }
  if (sourceInspectionBeforeCapture(value, arm, platform)) return false;
  if (arm === 'control') {
    const pipefail = value.replace(/^set -(?:o|eo|euo) pipefail\s*(?:;|\n)\s*/, '');
    if (pipefail !== value) return allowedBeforeErrorCapture(pipefail, arm, platform, setup);
    if (scopedCopyLoop(value, setup)) return true;
    const architecture = value.replace(/^ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a\s+/, '');
    if (architecture !== value) return allowedBeforeErrorCapture(architecture, arm, platform, setup);
    const logged = value.match(/^([\s\S]+)\s+\|\s+tee(?:\s+-a)?\s+\/(?:private\/)?tmp\/[A-Za-z0-9_.-]+\.log$/);
    if (logged) return allowedBeforeErrorCapture(logged[1], arm, platform, setup);
    if (platform === 'android') {
      if (
        /^printenv(?:\s+(?:ANDROID_AVD_HOME|ANDROID_HOME|GRADLE_USER_HOME|ANDROID_EMU_CRASH_REPORTING_DATABASE))+$/.test(
          value,
        )
      )
        return true;
      if (ownedAvdEdit(value, setup)) return true;
      if (/^(?:rg|grep|cat)\s+[\s\S]*\.ini(?:\s+\|\|\s+true)?$/.test(value)) return avdMetadataRead(value, setup);
      if (
        /^adb\s+-s\s+[A-Za-z0-9_-]+\s+wait-for-device\s+shell\s+'until \[ "\$\(getprop sys\.boot_completed\)" = "1" \]; do sleep 1; done; getprop sys\.boot_completed'$/.test(
          value,
        )
      )
        return true;
    }
  }
  if (
    arm === 'control' &&
    /^(?:\.\/)?node_modules\/\.bin\/expo\s+start(?:\s|$)/.test(value) &&
    shellCommandSegments(value).length === 1 &&
    !/`|\$\(/.test(value)
  )
    return true;
  if (/^(?:\.\/)?node_modules\/\.bin\/expo\s+--version$/.test(value)) return true;
  if (/^node\s+-p\s+(?:process\.execPath|(["'])process\.execPath\1)$/.test(value)) return true;
  if (/^print\s+-r\s+--\s+\d+\s*\|\s*tee\s+\/(?:private\/)?tmp\/[A-Za-z0-9_./-]+\.pid$/.test(value)) return true;
  if (
    /^node\s+-p\s+(["'])require\.resolve\((["'])(?:expo|react-native)\/package\.json\2\)\1(?:\s*&&\s*(?:\.\/)?node_modules\/\.bin\/expo\s+--version)?$/.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /(?:\/(?:skills|skill)\/[^\s]+\/|(?:^|\s)workspace\/)SKILL\.md\b/.test(value) &&
    /(?:^|\s)(?:cat|sed|head)(?:\s|$)/.test(value)
  ) {
    return true;
  }
  if (
    /^(?:pwd|ls(?:\s|$)|du(?:\s|$)|for\s|git\s+(?:rev-parse|show-ref|status|worktree\s+add)(?:\s|$)|mkdir(?:\s|$))/.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /^find\s+\.\s/.test(value) &&
    /-type\s+d(?:\s|$)/.test(value) &&
    /(?:node_modules|Pods|DerivedData|\.gradle)/.test(value) &&
    !/\.(?:[cm]?[jt]sx?|swift|kt|java)(?:\s|$)/.test(value)
  ) {
    return true;
  }
  if (
    /^find\s+ios\s+-maxdepth\s+1(?:\s|$)/.test(value) &&
    /\*\.(?:xcworkspace|xcodeproj)/.test(value) &&
    !/\.(?:[cm]?[jt]sx?|swift|kt|java)(?:\s|$)/.test(value)
  ) {
    return true;
  }
  if (
    /^(?:cp|rsync)\b/.test(value) &&
    /(?:node_modules|ios\/Pods|ios\/build|android\/(?:\.gradle|\.cxx|build|app\/build|local\.properties))/.test(value)
  ) {
    return true;
  }
  if (arm === 'stim') {
    return new RegExp(
      `^stim\\s+(?:guide|doctor|worktree\\s+(?:warm|create)|start|${platform}|logs\\s+--errors)(?:\\s|$)`,
    ).test(value);
  }
  if (platform === 'android') {
    if (
      /^(?:echo\s+["']?\$!["']?|printf\s+['"]%s\\n['"]\s+["']?\$!["']?)\s*>\s*\/(?:private\/)?tmp\/[A-Za-z0-9_./-]+\.pid$/.test(
        value,
      )
    )
      return true;
    if (/^cd\s+(?:"[^"$`]+"|'[^']+'|[^\s;&|$`]+)$/.test(value)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"$`]*"|'[^']*'|[^\s;&|$`]+)$/.test(value)) return true;
    const pipeline = value.split(/\s+\|\s+/);
    if (
      pipeline.length > 1 &&
      /^adb\s+(?:-s\s+\S+\s+)?logcat\b[^|;&]*$/.test(pipeline[0]) &&
      pipeline
        .slice(1)
        .every((filter) => /^(?:rg|grep)(?:\s+-[EinFv]+)*\s+(?:"[^"$`]*"|'[^']*'|[A-Za-z0-9_:.-]+)$/.test(filter))
    )
      return true;
    const segments = shellCommandSegments(value);
    if (segments.length > 1)
      return segments.every((segment) => allowedBeforeErrorCapture(segment, arm, platform, setup));
    if (/^(?:avdmanager|emulator|sdkmanager)\b/.test(value)) return true;
    if (/^(?:printf|echo)\s+['"]?(?:no|n)(?:\\{1,2}n)?['"]?$/.test(value)) return true;
    if (
      /^(?:printf|echo)\s+['"]disk\.dataPartition\.size=8589934592(?:\\n)?['"]\s*>>?\s*[^;&|]+\/config\.ini['"]?$/.test(
        value,
      )
    )
      return true;
  }
  return (
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:\S+|\$\([^)]*\))[;\s]+)*)(?:open\s+-a\s+Simulator|xcrun\s+simctl\s+|npx\s+expo\s+|xcodebuild\b|\.\/gradlew\b|adb\b|nohup\b|launchctl\b|ps\b|pgrep\b|sleep\b|tail\b|cat\s+\/?tmp\/|wc\b|lsof\b|command\s+-v\b|test\b|kill\b)/.test(
      value,
    ) ||
    launchCommand(value, arm, platform) ||
    errorCaptureCommand(value, arm, platform)
  );
}

export function launchCrashDiagnosis(
  commands,
  { dispatchAt, token, arm = 'stim', platform = 'ios', activities = [], setup = {} },
) {
  const ordered = orderedCommands(commands);
  const sourceMarkers = ['app/_layout.tsx', 'RootLayout'];
  const initialLaunchIndex = ordered.findIndex((command) => successfulLaunch(command, arm, platform));
  if (initialLaunchIndex === -1) {
    return { valid: false, reason: 'launch-crash-initial-launch-evidence-missing' };
  }
  const errorCaptureIndex = ordered.findIndex(
    (command, index) =>
      index > initialLaunchIndex &&
      successful(command) &&
      errorCaptureCommand(completedStepCommand(command, arm), arm, platform) &&
      typeof command.output === 'string' &&
      command.output.includes(token),
  );
  if (errorCaptureIndex === -1) {
    return { valid: false, reason: 'launch-crash-error-capture-missing' };
  }
  const captureEndedAt = timestamp(ordered[errorCaptureIndex], 'endedAt');
  const preCaptureActivity = [...ordered, ...activities].toSorted(
    (left, right) => timestamp(left, 'startedAt') - timestamp(right, 'startedAt'),
  );
  const unrecognizedBeforeCapture = preCaptureActivity.filter(
    (command) =>
      timestamp(command, 'startedAt') < captureEndedAt &&
      !allowedBeforeErrorCapture(command.command, arm, platform, setup),
  );
  const disallowedBeforeCapture = unrecognizedBeforeCapture.filter((command) =>
    sourceInspectionBeforeCapture(command.command, arm, platform),
  );
  if (disallowedBeforeCapture.length) {
    return {
      valid: false,
      reason: 'launch-crash-pre-capture-command-not-allowed',
      commandId: disallowedBeforeCapture[0].id,
      violations: disallowedBeforeCapture.map(({ id, command }) => ({ commandId: id, command })),
    };
  }
  const capture = ordered[errorCaptureIndex];
  const captureIsActionable =
    typeof capture.output === 'string' &&
    capture.output.includes(token) &&
    sourceMarkers.some((marker) => capture.output.includes(marker));
  const index = captureIsActionable
    ? errorCaptureIndex
    : ordered.findIndex(
        (command) =>
          timestamp(command, 'startedAt') >= captureEndedAt &&
          successful(command) &&
          typeof command.output === 'string' &&
          command.output.includes(token) &&
          sourceMarkers.some((marker) => command.output.includes(marker)),
      );
  if (index === -1) {
    return { valid: false, reason: 'actionable-launch-crash-diagnosis-missing' };
  }
  const command = ordered[index];
  const observedAt = command.endedAt;
  const dispatchToDiagnosisSeconds = (Date.parse(observedAt) - Date.parse(dispatchAt)) / 1000;
  if (!Number.isFinite(dispatchToDiagnosisSeconds) || dispatchToDiagnosisSeconds < 0) {
    return { valid: false, reason: 'launch-crash-diagnosis-time-invalid' };
  }
  return {
    valid: true,
    ...(unrecognizedBeforeCapture.length
      ? { setupWarnings: unrecognizedBeforeCapture.map((entry) => ({ commandId: entry.id, command: entry.command })) }
      : {}),
    observedAt,
    dispatchToDiagnosisSeconds,
    commandCount: ordered.filter((candidate) => timestamp(candidate, 'endedAt') <= Date.parse(observedAt)).length,
    commandId: command.id,
    command: command.command,
    initialLaunchCommandId: ordered[initialLaunchIndex].id,
    errorCaptureCommandId: ordered[errorCaptureIndex].id,
  };
}

export function launchCrashRepair(source, token, expectedSha256) {
  if (source.includes(token)) return { valid: false, reason: 'launch-crash-token-remains-in-source' };
  if (!source.trim()) return { valid: false, reason: 'launch-crash-repaired-source-empty' };
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (expectedSha256 && sourceSha256 !== expectedSha256) {
    return { valid: false, reason: 'launch-crash-source-not-restored', sourceSha256 };
  }
  return { valid: true, sourceSha256 };
}

function parsePodfileChecksums(source) {
  const parts = source.split('SPEC CHECKSUMS:\n');
  if (parts.length !== 2) return null;
  const end = parts[1].indexOf('\n\n');
  if (end < 0) return null;
  const rows = parts[1]
    .slice(0, end)
    .split('\n')
    .map((line) => line.match(/^  ([\w/.+-]+): ([0-9a-f]{40})$/));
  if (!rows.length || rows.some((row) => !row) || new Set(rows.map((row) => row[1])).size !== rows.length) return null;
  return { prefix: parts[0], suffix: parts[1].slice(end), rows };
}

export function podfileChecksumChanges(before, after) {
  const left = parsePodfileChecksums(before);
  const right = parsePodfileChecksums(after);
  if (
    !left ||
    !right ||
    left.prefix !== right.prefix ||
    left.suffix !== right.suffix ||
    left.rows.length !== right.rows.length
  )
    return null;
  if (left.rows.some((row, index) => row[1] !== right.rows[index][1])) return null;
  return left.rows.flatMap((row, index) =>
    row[2] === right.rows[index][2] ? [] : [{ pod: row[1], before: row[2], after: right.rows[index][2] }],
  );
}

export function launchCrashRecovery(commands, { diagnosis, screen }) {
  if (!diagnosis?.valid) return { valid: false, reason: 'launch-crash-diagnosis-missing' };
  const ordered = orderedCommands(commands);
  const diagnosisCommand = ordered.find((command) => command.id === diagnosis.commandId);
  const diagnosisEndedAt = timestamp(diagnosisCommand ?? {}, 'endedAt');
  if (!screen?.valid) return { valid: false, reason: 'launch-crash-settings-proof-missing' };
  if (!screen.screenshotCommandId) {
    return { valid: false, reason: 'launch-crash-settings-command-missing' };
  }
  const screenshot = ordered.find((command) => command.id === screen.screenshotCommandId);
  if (
    !screenshot ||
    !successful(screenshot) ||
    !/(?:^|\s)agent-device\s+screenshot(?:\s|$)/.test(shellCommand(screenshot.command))
  ) {
    return { valid: false, reason: 'launch-crash-settings-command-invalid' };
  }
  const screenshotStartedAt = timestamp(screenshot, 'startedAt');
  if (
    screenshotStartedAt < diagnosisEndedAt ||
    timestamp({ endedAt: screen.observedAt }, 'endedAt') !== timestamp(screenshot, 'endedAt')
  ) {
    return { valid: false, reason: 'launch-crash-settings-proof-before-diagnosis' };
  }
  return {
    valid: true,
    screenshotCommandId: screen.screenshotCommandId,
  };
}
