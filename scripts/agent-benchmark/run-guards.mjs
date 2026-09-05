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

function topLevelShellCommand(command) {
  const trimmed = String(command ?? '').trim();
  const match = trimmed.match(/^\/bin\/(?:zsh|bash|sh) -lc (["'])([\s\S]*)\1$/);
  return (match?.[2] ?? trimmed).trim();
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

export function benchmarkSetupInvalidReasons(meta, commands) {
  const reasons = [];
  if (commands.some((command) => dependencyInstallCommand(command.command))) {
    reasons.push('dependencies-installed-inside-timer');
  }
  if (meta.arm !== 'stim') return reasons;
  if (!successfulCommand(commands, 'stim guide agent')) {
    reasons.push('stim-guide-agent-missing-or-failed');
  }
  if (!successfulCommand(commands, 'stim worktree warm')) {
    reasons.push('stim-worktree-warm-missing-or-failed');
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
  return [...String(output ?? '').matchAll(/compilation cache\s+(\d+) hits\s*\/\s*(\d+) misses\s*\([\d.]+%\)/g)].map(
    ([, hits, misses]) => {
      hits = Number(hits);
      misses = Number(misses);
      return { hits, misses, hitRatePercent: hits + misses > 0 ? (100 * hits) / (hits + misses) : null };
    },
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
    if (/build\s+compiling|compilation cache\s+unavailable/.test(entry.output) && measurements.length === 0) {
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
  const artifactHit = platformRuns.some(
    (entry) =>
      entry.exitCode === 0 &&
      /cache\s+hit\b|fingerprint\s+[0-9a-f]+\.\.\s+hit\b|compilation cache\s+not run; artifact cache supplied the app/.test(
        entry.output,
      ),
  );
  if (!result.builds.length && !artifactHit) result.invalidReasons.push('ccache-evidence-missing');
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
