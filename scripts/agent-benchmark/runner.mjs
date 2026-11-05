import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const scriptRoot = dirname(fileURLToPath(import.meta.url));

export function makeRunnerHome({ runDir, arm, codexAuthPath, agentSkillsRoot, stimPackage }) {
  if (!codexAuthPath || !agentSkillsRoot) {
    throw new Error('STIM_BENCH_CODEX_AUTH and STIM_BENCH_SKILLS_ROOT are required');
  }
  const home = join(runDir, 'runner-home');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(codexAuthPath, join(codexHome, 'auth.json'));
  chmodSync(join(codexHome, 'auth.json'), 0o600);
  const selectedSkills = [
    {
      name: 'agent-device',
      source: join(agentSkillsRoot, 'agent-device'),
    },
  ];
  if (arm === 'stim') {
    selectedSkills.push({
      name: 'stim',
      source: join(stimPackage, 'skill'),
    });
  }
  for (const skill of selectedSkills) {
    const target = join(codexHome, 'skills', skill.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(skill.source, target, { recursive: true });
  }
  const skillRoot = agentSkillsRoot;
  const skillPaths = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        skillPaths.push(realpathSync(child));
      }
    }
  }
  visit(skillRoot);
  const config = [
    'service_tier = "priority"',
    'model_reasoning_effort = "high"',
    '',
    '[features]',
    'plugins = false',
    'multi_agent = false',
    '',
    '[skills]',
    'include_instructions = true',
    '',
    '[skills.bundled]',
    'enabled = false',
    ...skillPaths.flatMap((path) => ['', '[[skills.config]]', `path = ${JSON.stringify(path)}`, 'enabled = false']),
    '',
  ].join('\n');
  writeFileSync(join(codexHome, 'config.toml'), config);
  return { codexHome };
}

export function killProcessTree(child, processGroupId, signal) {
  try {
    if (process.platform !== 'win32' && processGroupId) process.kill(-processGroupId, signal);
    else if (child.exitCode == null && child.signalCode == null) child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function terminateProcessTree(child, processGroupId, graceMs) {
  killProcessTree(child, processGroupId, 'SIGTERM');
  const timer = setTimeout(() => killProcessTree(child, processGroupId, 'SIGKILL'), graceMs);
  timer.unref();
  return timer;
}

export function spawnStamped(
  command,
  args,
  output,
  options,
  input,
  timeoutMs = null,
  killGraceMs = 5000,
  onEvent = null,
) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
  const processGroupId = process.platform === 'win32' ? null : child.pid;
  let timedOut = false;
  let forceKill = null;
  const timeout = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        forceKill = terminateProcessTree(child, processGroupId, killGraceMs);
      }, timeoutMs)
    : null;
  const stampOut = spawn('node', [join(scriptRoot, 'stamp.mjs'), 'stdout'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const stampErr = spawn('node', [join(scriptRoot, 'stamp.mjs'), 'stderr'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const outChunks = [];
  const errChunks = [];
  stampOut.stdout.on('data', (chunk) => outChunks.push(chunk));
  stampErr.stdout.on('data', (chunk) => errChunks.push(chunk));
  child.stdout.pipe(stampOut.stdin);
  child.stderr.pipe(stampErr.stdin);
  if (onEvent) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      onEvent(event);
    });
  }
  child.stdin.end(input);
  const stampOutClosed = new Promise((done) => stampOut.on('close', done));
  const stampErrClosed = new Promise((done) => stampErr.on('close', done));
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) {
        clearTimeout(forceKill);
        killProcessTree(child, processGroupId, 'SIGKILL');
      }
      stampOut.stdin.end();
      stampErr.stdin.end();
      return Promise.all([stampOutClosed, stampErrClosed]).then(() => {
        const lines = [outChunks, errChunks]
          .flatMap((chunks) => Buffer.concat(chunks).toString('utf8').split('\n'))
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
        writeFileSync(output, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
        writeFileSync(
          join(dirname(output), 'runner-stream.jsonl'),
          lines
            .filter((line) => line.stream === 'stdout')
            .map((line) => line.line)
            .join('\n') + '\n',
        );
        return resolvePromise({ code, signal, timedOut });
      });
    });
  });
}
