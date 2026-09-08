const platforms = new Set(['ios', 'android']);
const variants = new Set(['javascript', 'native', 'launch-crash']);
const arms = new Set(['stim', 'control']);

function positiveSeconds(value, field, key) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`benchmark target ${key}.${field} must be a positive number`);
  }
  return value;
}

function targetKey({ platform, variant, arm }) {
  return `${platform}.${variant}.${arm}`;
}

export function parseBenchmarkTargets(contents) {
  const config = typeof contents === 'string' ? JSON.parse(contents) : contents;
  if (config?.schemaVersion !== 1) throw new Error('benchmark targets schemaVersion must be 1');
  if (typeof config.machine !== 'string' || !config.machine.trim()) {
    throw new Error('benchmark targets machine must be a non-empty string');
  }
  if (!config.targets || typeof config.targets !== 'object' || Array.isArray(config.targets)) {
    throw new Error('benchmark targets must be an object');
  }
  for (const [key, target] of Object.entries(config.targets)) {
    const [platform, variant, arm, extra] = key.split('.');
    if (extra || !platforms.has(platform) || !variants.has(variant) || !arms.has(arm)) {
      throw new Error(`unsupported benchmark target key: ${key}`);
    }
    positiveSeconds(target?.screenReadySeconds, 'screenReadySeconds', key);
    positiveSeconds(target?.runTimeoutSeconds, 'runTimeoutSeconds', key);
    if (target.runTimeoutSeconds < target.screenReadySeconds) {
      throw new Error(`benchmark target ${key}.runTimeoutSeconds must be at least screenReadySeconds`);
    }
    if (target.platformCommandSeconds != null) {
      positiveSeconds(target.platformCommandSeconds, 'platformCommandSeconds', key);
      if (target.runTimeoutSeconds < target.platformCommandSeconds) {
        throw new Error(`benchmark target ${key}.runTimeoutSeconds must be at least platformCommandSeconds`);
      }
    }
    if (target.ccacheMinHitRatePercent != null) {
      if (
        platform !== 'android' ||
        arm !== 'stim' ||
        !Number.isFinite(target.ccacheMinHitRatePercent) ||
        target.ccacheMinHitRatePercent <= 0 ||
        target.ccacheMinHitRatePercent > 100
      ) {
        throw new Error(`benchmark target ${key}.ccacheMinHitRatePercent must be in (0, 100] for Android Stim`);
      }
    }
  }
  return config;
}

export function benchmarkTarget(config, selection) {
  const key = targetKey(selection);
  const value = config.targets[key];
  if (!value) throw new Error(`benchmark target missing for ${key}`);
  return { key, machine: config.machine, ...value };
}

export function topLevelShellCommand(command) {
  const trimmed = String(command ?? '').trim();
  const match = trimmed.match(/^\/bin\/(?:zsh|bash|sh) -lc\s+([\s\S]+)$/);
  if (!match) return trimmed;
  const input = match[1];
  let source = '';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else source += char;
    } else if (char === '\\') {
      const next = input[index + 1];
      if (next === undefined) return trimmed;
      if (!quote || /["\\$`\n]/.test(next)) {
        if (next !== '\n') source += next;
        index += 1;
      } else source += char;
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else if (!quote && /\s|[;&|<>]/.test(char)) {
      return trimmed;
    } else source += char;
  }
  return quote ? trimmed : source.trim();
}

export function shellCommandSegments(command) {
  const source = topLevelShellCommand(command);
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    const next = source[index + 1];
    if (char === '&' && (source[index - 1] === '>' || source[index - 1] === '<' || next === '>')) continue;
    const separator = char === '\n' || char === ';' || char === '|' || char === '&';
    if (!separator) continue;
    const segment = source.slice(start, index).trim();
    if (segment) segments.push(segment);
    if ((char === '|' || char === '&') && next === char) index += 1;
    start = index + 1;
  }
  const tail = source.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

export function agentDeviceAuxiliarySessions(commands, expectedPrefix, target) {
  if (!target?.device || !['ios', 'android'].includes(target.platform)) return [];
  const prefix = expectedPrefix.match(
    /^(env AGENT_DEVICE_STATE_DIR=\S+ AGENT_DEVICE_SESSION=)([\w.-]+)( agent-device )$/,
  );
  if (!prefix) return [];
  const groups = new Map();
  const proofOpen = commands.findIndex((entry) =>
    topLevelShellCommand(entry.command).startsWith(`${expectedPrefix}open `),
  );
  if (proofOpen < 0) return [];
  commands.forEach((entry, index) => {
    const command = topLevelShellCommand(entry.command);
    if (!command.startsWith(`${prefix[1]}${prefix[2]}-`)) return;
    const match = command.slice(prefix[1].length).match(/^([\w.-]+) agent-device ([\s\S]+)$/);
    if (!match || !new RegExp(`^${prefix[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z][a-z0-9-]*$`).test(match[1]))
      return;
    const group = groups.get(match[1]) ?? [];
    group.push({ ...entry, command, body: match[2], index });
    groups.set(match[1], group);
  });
  const open = `open com.appandflow.trailhead --foreground --platform ${target.platform} ${target.platform === 'ios' ? '--udid' : '--serial'} ${target.device}`;
  return [...groups.entries()].flatMap(([session, entries]) => {
    if (
      entries.length < 2 ||
      entries[0].body !== open ||
      entries[0].exitCode !== 0 ||
      entries.at(-1).body !== 'close' ||
      entries.at(-1).exitCode !== 0 ||
      entries.at(-1).index >= proofOpen ||
      entries.some((entry) => shellCommandSegments(entry.command).length !== 1 || /[$`]/.test(entry.command)) ||
      entries
        .slice(1, -1)
        .some(
          (entry) =>
            !/^(?:click|press|fill|snapshot|wait|screenshot|back|scroll)(?:\s|$)/.test(entry.body) ||
            /--(?:session|state-dir|udid|serial|platform|device)(?:[=\s]|$)/.test(entry.body),
        )
    )
      return [];
    return [{ session, commands: entries.map(({ id, command }) => ({ commandId: id, command })) }];
  });
}

export function agentDeviceIsolationInvalidReasons(commands, expectedPrefix, target) {
  const segments = commands.flatMap((command) => shellCommandSegments(command.command));
  const auxiliary = new Set(
    agentDeviceAuxiliarySessions(commands, expectedPrefix, target).flatMap((session) =>
      session.commands.map((entry) => entry.command),
    ),
  );
  const reasons = [];
  const lookup =
    /^(?:command\s+-[vV]|which|type|whence)\s+(?:[\w./-]+\s+)*agent-device(?:\s+[\w./-]+)*(?:\s+(?:\d*>|&>)\s*(?:&\d+|[\w./-]+))?$/;
  const help = /^agent-device(?:\s+--help|\s+help(?:\s+[\w-]+)*)(?:\s+(?:\d*>|&>)\s*(?:&\d+|[\w./-]+))?$/;
  const deviceCommands = segments.filter(
    (command) => /(?:^|[\s(`])agent-device(?:\s|[)`]|$)/.test(command) && !lookup.test(command) && !help.test(command),
  );
  if (deviceCommands.some((command) => /(?:^|[\s(`])agent-device\s+daemon\s+stop(?:\s|[)`]|$)/.test(command))) {
    reasons.push('agent-device-daemon-recovery-inside-timer');
  }
  if (deviceCommands.some((command) => !command.startsWith(expectedPrefix) && !auxiliary.has(command))) {
    reasons.push('agent-device-run-session-not-applied');
  }
  return reasons;
}

function commandSegmentsStartingWith(command, expected) {
  return shellCommandSegments(command).filter((segment) => segment === expected || segment.startsWith(`${expected} `));
}

function successfulCommand(commands, expected) {
  return commands.some((command) => {
    if (command.exitCode !== 0) return false;
    const segments = shellCommandSegments(command.command);
    const final = segments.at(-1);
    return final === expected || final?.startsWith(`${expected} `);
  });
}

function dependencyInstallCommand(command) {
  return shellCommandSegments(command).some((segment) =>
    /^(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn(?:\s+install)?|bun\s+install)(?:\s|$)/.test(segment),
  );
}

function commandCompletedBefore(first, second) {
  if (first.parallelTimingAmbiguous || second.parallelTimingAmbiguous) return false;
  if (Number.isInteger(first.endEventOffset) && Number.isInteger(second.startEventOffset)) {
    return first.endEventOffset < second.startEventOffset;
  }
  const end = Date.parse(first.endedAt);
  const start = Date.parse(second.startedAt);
  return Number.isFinite(end) && Number.isFinite(start) && end <= start;
}

export function benchmarkSetupInvalidReasons(meta, commands) {
  const reasons = [];
  if (commands.some((command) => dependencyInstallCommand(command.command))) {
    reasons.push('dependencies-installed-inside-timer');
  }
  if (meta.arm !== 'stim') return reasons;
  if (!successfulCommand(commands, 'stim guide agent')) {
    reasons.push('stim-guide-agent-missing-or-failed');
  }
  const warmRuns = commands.filter(
    (command) => commandSegmentsStartingWith(command.command, 'stim worktree warm').length > 0,
  );
  const successfulWarms = warmRuns.filter((warm) => successfulCommand([warm], 'stim worktree warm'));
  if (!successfulWarms.length) {
    reasons.push('stim-worktree-warm-missing-or-failed');
  }
  const dependentRuns = commands.filter(
    (command) =>
      ['stim start', 'stim ios', 'stim android'].some(
        (prefix) => commandSegmentsStartingWith(command.command, prefix).length > 0,
      ) || dependencyInstallCommand(command.command),
  );
  if (
    successfulWarms.length &&
    dependentRuns.some(
      (command) =>
        !successfulWarms.some((warm) => commandCompletedBefore(warm, command)) ||
        warmRuns.some((warm) => !commandCompletedBefore(warm, command) && !commandCompletedBefore(command, warm)),
    )
  ) {
    reasons.push('stim-worktree-warm-not-complete-before-use');
  }
  const platformCommand = `stim ${meta.platform ?? 'ios'}`;
  const platformRuns = commands.filter(
    (command) => commandSegmentsStartingWith(command.command, platformCommand).length > 0,
  );
  const builtRun = platformRuns.find(
    (command) => command.exitCode === 0 && /fingerprint\s+[0-9a-f]{6}\.\.\s+miss\b/.test(command.output),
  );
  if (
    builtRun &&
    meta.platform === 'android' &&
    !/cache\s+gradle build cache on\s+\(--build-cache/.test(builtRun.output)
  ) {
    reasons.push('stim-gradle-build-cache-missing');
  }
  return reasons;
}

export function benchmarkTiming(target, commands, screenReadySeconds, timedOut) {
  if (!target) {
    return {
      target: null,
      screenReadySeconds: Number.isFinite(screenReadySeconds) ? screenReadySeconds : null,
      screenReadyTargetMet: null,
      platformCommandSeconds: null,
      platformCommandTargetMet: null,
      timedOut: Boolean(timedOut),
      invalidReasons: ['benchmark-target-missing'],
    };
  }
  const platformPrefix = `stim ${target.key.split('.').at(0)}`;
  const platformCommands = commands.filter(
    (command) => commandSegmentsStartingWith(command.command, platformPrefix).length > 0,
  );
  const platformCommandSeconds = platformCommands.reduce(
    (maximum, command) => Math.max(maximum, command.elapsedSeconds ?? 0),
    0,
  );
  const screenReadyTargetMet = Number.isFinite(screenReadySeconds) && screenReadySeconds <= target.screenReadySeconds;
  const invalidReasons = [];
  if (timedOut) invalidReasons.push('benchmark-run-timeout');
  if (target.platformCommandSeconds != null && platformCommandSeconds > target.platformCommandSeconds) {
    invalidReasons.push('platform-command-target-exceeded');
  }
  return {
    target,
    screenReadySeconds: Number.isFinite(screenReadySeconds) ? screenReadySeconds : null,
    screenReadyTargetMet,
    platformCommandSeconds: platformCommandSeconds || null,
    platformCommandTargetMet:
      target.platformCommandSeconds == null
        ? null
        : platformCommandSeconds > 0 && platformCommandSeconds <= target.platformCommandSeconds,
    timedOut: Boolean(timedOut),
    invalidReasons,
  };
}

export function stimShellProvenanceInvalidReasons(meta) {
  if (meta.arm !== 'stim') return [];
  const probe = meta.stimShellProvenance;
  if (!probe) return ['stim-shell-provenance-missing'];
  const expected = meta.expectedStimShellProvenance;
  if (!expected) return ['stim-shell-provenance-expectation-missing'];
  return probe.resolvedPath === expected.resolvedPath &&
    probe.version === expected.version &&
    probe.executableSha256 === expected.executableSha256 &&
    probe.cliSha256 === expected.cliSha256
    ? []
    : ['stim-shell-provenance-mismatch'];
}

export function ccacheMeasurements(output) {
  const structured = structuredCcaches(output)
    .filter(
      ({ status, hits, misses }) =>
        status === 'reported' && Number.isSafeInteger(hits) && Number.isSafeInteger(misses) && hits >= 0 && misses >= 0,
    )
    .map(({ hits, misses }) => ({
      hits,
      misses,
      hitRatePercent: hits + misses > 0 ? (100 * hits) / (hits + misses) : null,
    }));
  const human = [
    ...String(output ?? '').matchAll(/compilation cache\s+(\d+) hits\s*\/\s*(\d+) misses\s*\([\d.]+%\)/g),
  ].map(([, hits, misses]) => {
    hits = Number(hits);
    misses = Number(misses);
    return { hits, misses, hitRatePercent: hits + misses > 0 ? (100 * hits) / (hits + misses) : null };
  });
  return [...structured, ...human];
}

function structuredCcaches(output) {
  return [...String(output ?? '').matchAll(/"ccache"\s*:\s*(\{[^{}]*\})/g)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])];
    } catch {
      return [];
    }
  });
}

function artifactCacheHit(entry) {
  return (
    entry.exitCode === 0 &&
    (structuredCcaches(entry.output).some((cache) => cache.status === 'not-run') ||
      /cache\s+hit\b|fingerprint\s+[0-9a-f]+\.\.\s+hit\b|compilation cache\s+not run; artifact cache supplied the app/.test(
        entry.output,
      ))
  );
}

export function benchmarkCcache(meta, commands) {
  const minimum = meta.timingTarget?.ccacheMinHitRatePercent ?? null;
  const result = { minimumHitRatePercent: minimum, status: 'not-applicable', builds: [], invalidReasons: [] };
  if (meta.arm !== 'stim' || meta.platform !== 'android') return result;
  if (meta.variant === 'native' && minimum == null) result.invalidReasons.push('ccache-target-missing');
  const platformRuns = commands.filter(
    (entry) => commandSegmentsStartingWith(entry.command, 'stim android').length > 0,
  );
  for (const entry of platformRuns) {
    const measurements = ccacheMeasurements(entry.output);
    result.builds.push(...measurements.map((measurement) => ({ commandId: entry.id ?? null, ...measurement })));
    if (
      /compilation cache\s+unavailable/.test(entry.output) ||
      structuredCcaches(entry.output).some((cache) => cache.status !== 'reported' && cache.status !== 'not-run')
    ) {
      result.invalidReasons.push('ccache-evidence-missing');
    }
    if (
      measurements.length === 0 &&
      (!artifactCacheHit(entry) || /build\s+compiling|compilation cache\s+unavailable/.test(entry.output))
    ) {
      result.invalidReasons.push('ccache-evidence-missing');
    }
  }
  for (const measurement of result.builds) {
    if (measurement.hitRatePercent == null) result.invalidReasons.push('ccache-evidence-missing');
    else if (minimum != null && measurement.hitRatePercent < minimum)
      result.invalidReasons.push('ccache-hit-rate-below-target');
  }
  if (
    commands.some(
      (entry) =>
        commandSegmentsStartingWith(entry.command, 'stim doctor').length > 0 &&
        /configured CMake cache|CMake launcher state could not be inspected/.test(entry.output),
    )
  ) {
    result.invalidReasons.push('stale-cmake-launcher-state');
  }
  result.invalidReasons = [...new Set(result.invalidReasons)];
  if (!platformRuns.length) result.invalidReasons.push('ccache-evidence-missing');
  result.invalidReasons = [...new Set(result.invalidReasons)];
  result.status = result.invalidReasons.length ? 'investigate' : result.builds.length ? 'measured' : 'artifact-hit';
  return result;
}

export function assertAndroidDoctorClean(report) {
  if (report?.platform !== 'android' || !Array.isArray(report.findings))
    throw new Error('invalid Android doctor report');
  const failures = report.findings.filter((finding) => finding.level === 'cost');
  if (failures.length)
    throw new Error(`Android fixture is not ready: ${failures.map((finding) => finding.title).join('; ')}`);
  return { checkedAt: new Date().toISOString(), platform: report.platform, findings: report.findings };
}

export function runnerToolOutput(event) {
  if (event?.type === 'item.completed' && event.item?.type === 'command_execution')
    return event.item.aggregated_output ?? '';
  if (event?.type === 'user' && Array.isArray(event.message?.content)) {
    return event.message.content
      .filter((part) => part.type === 'tool_result')
      .map((part) =>
        typeof part.content === 'string'
          ? part.content
          : (part.content ?? []).map((block) => block.text ?? '').join('\n'),
      )
      .join('\n');
  }
  return '';
}
