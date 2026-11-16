import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isBlanked, matchRule, relativeCwd, unscriptedMessage } from './stim-script.ts';
import type { Invocation, StimEvalConfig } from './types.ts';

const [configPath, ...argv] = process.argv.slice(2);
if (!configPath) throw new Error('scripted stim needs its config path');
const config: StimEvalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const cwd = process.cwd();
const cwdRelative = relativeCwd(config.workspace, cwd);
const startedAt = Date.now();

function answer(): Pick<Invocation, 'kind' | 'exitCode'> & { stdout: Buffer; stderr: Buffer } {
  if (isBlanked(config.blank, argv))
    return { kind: 'blanked', exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  if (argv[0] === 'guide') {
    const child = spawnSync(process.execPath, [config.guideCli, ...argv], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', STIM_HOME: config.guideHome },
      timeout: 30_000,
    });
    return { kind: 'guide', exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
  }
  const rule = matchRule(config.rules, argv, cwdRelative);
  if (!rule)
    return { kind: 'unscripted', exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(unscriptedMessage(argv)) };
  return {
    kind: 'scripted',
    exitCode: rule.exit ?? 0,
    stdout: Buffer.from(rule.stdout ?? ''),
    stderr: Buffer.from(rule.stderr ?? ''),
  };
}

const result = answer();
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
const record: Invocation = {
  argv,
  cwd,
  cwdRelative,
  kind: result.kind,
  startedAt,
  endedAt: Date.now(),
  exitCode: result.exitCode,
  stdoutBytes: result.stdout.length,
  stderrBytes: result.stderr.length,
  path: process.env.PATH ?? '',
  self: process.argv[1] ?? '',
};
appendFileSync(config.log, `${JSON.stringify(record)}\n`);
process.exitCode = result.exitCode;
