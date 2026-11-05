import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { cases, commandState, websitePrompt } from './cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const model = process.env.STIM_PROMPT_MODEL ?? 'gpt-5.6-sol';
const timeoutMs = Number(process.env.STIM_PROMPT_TIMEOUT_MS ?? 180_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000)
  throw new Error('Timeout must be 100..180000 milliseconds');
const selected = process.argv.slice(2);
if (selected.some((id) => !cases.some((entry) => entry.id === id)))
  throw new Error(`Unknown case; choose ${cases.map((entry) => entry.id).join(', ')}`);
const authPath = resolve(
  process.env.STIM_PROMPT_CODEX_AUTH ?? join(process.env.CODEX_HOME ?? join(process.env.HOME, '.codex'), 'auth.json'),
);
if (!existsSync(authPath)) throw new Error('Existing Codex login not found; log in with codex login first.');
const outputRoot = mkdtempSync(join(tmpdir(), 'stim-prompt-eval-'));
const codexBin = process.env.STIM_PROMPT_CODEX_BIN ?? 'codex';
const version = execFileSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
const skill = readFileSync(join(root, 'packages/stim-cli/skill/SKILL.md'), 'utf8');
const cli = join(root, 'packages/stim-cli/dist/cli.mjs');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
const results = [];
console.error(`Evidence: ${outputRoot}`);

async function runCase(entry) {
  const directory = join(outputRoot, entry.id);
  const workspace = join(directory, 'app');
  mkdirSync(workspace, { recursive: true });
  const runnerHome = join(directory, 'codex-home');
  mkdirSync(runnerHome);
  symlinkSync(authPath, join(runnerHome, 'auth.json'));
  const config = {
    'features.shell_tool': false,
    'features.plugins': false,
    'features.apps': false,
    'features.multi_agent': false,
    'features.browser_use': false,
    'features.computer_use': false,
    'features.image_generation': false,
    'features.hooks': false,
    web_search: 'disabled',
    'skills.bundled.enabled': false,
  };
  const child = spawn(
    codexBin,
    [
      'app-server',
      '--stdio',
      ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    ],
    {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: runnerHome, TMPDIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const state = commandState(entry.id, workspace);
  const transcript = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 1_000_000) {
      finish({ passed: false, reason: 'Server stderr budget exceeded' });
      child.kill('SIGTERM');
    }
  });
  child.stdin.on('error', (error) => finish({ passed: false, reason: error.message }));
  let sequence = 0;
  const pending = new Map();
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      pending.set(id, { resolve: resolveRequest, reject });
      send({ id, method, params });
    });
  }
  let complete;
  let settled = false;
  const completion = new Promise((resolveCompletion) => {
    complete = resolveCompletion;
  });
  function finish(result) {
    if (settled) return;
    settled = true;
    complete(result);
    rejectPending(new Error(result.reason));
  }
  function rejectPending(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.on('error', (error) => {
    rejectPending(error);
    finish({ passed: false, reason: error.message });
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`App server exited: ${code}`));
    pending.clear();
    finish({ passed: false, reason: `App server exited before target: ${code}` });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      finish({ passed: false, reason: 'Invalid protocol JSON' });
      return;
    }
    transcript.push(message);
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      (message.id === undefined && typeof message.method !== 'string')
    ) {
      finish({ passed: false, reason: 'Malformed protocol envelope' });
      return;
    }
    if (
      message.method === 'item/tool/call' &&
      (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))
    ) {
      finish({ passed: false, reason: 'Malformed tool-call parameters' });
      return;
    }
    if (transcript.length > 2000) {
      finish({ passed: false, reason: 'Protocol event budget exceeded' });
      child.kill('SIGTERM');
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined) {
      if (message.method !== 'item/tool/call' || message.params.tool !== 'run_command' || settled) {
        send({ id: message.id, error: { code: -32601, message: 'Tool unavailable in command evaluation' } });
        if (!settled) finish({ passed: false, reason: `Unexpected tool request: ${message.method}` });
        return;
      }
      try {
        const decision = state.accept(message.params.arguments);
        if (decision.done) {
          finish({ passed: true, reason: 'Observed all target command attempts; no native commands executed' });
          return;
        }
        let output = decision.output;
        if (decision.guide)
          output = execFileSync(process.execPath, [cli, ...decision.guide], {
            cwd: root,
            env: { ...process.env, STIM_HOME: join(directory, 'stim-home') },
            encoding: 'utf8',
            timeout: 10_000,
          });
        send({
          id: message.id,
          result: { contentItems: [{ type: 'inputText', text: output }], success: !decision.failed },
        });
      } catch (error) {
        finish({ passed: false, reason: error.message });
      }
    }
    if (message.method === 'turn/completed')
      finish({ passed: false, reason: 'Agent finished before attempting all target commands' });
  });
  const timer = setTimeout(() => {
    const reason = `${timeoutMs} millisecond deadline exceeded`;
    finish({ passed: false, reason });
    rejectPending(new Error(reason));
    child.kill('SIGTERM');
  }, timeoutMs);
  let threadId;
  let turnId;
  const start = Date.now();
  try {
    await request('initialize', {
      clientInfo: { name: 'stim_prompt_eval', version: '1' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });
    const response = await request('thread/start', {
      model,
      cwd: workspace,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      environments: [],
      config: { model_reasoning_effort: 'low' },
      baseInstructions:
        'You are a coding agent working in a React Native/Expo project. Carry out the user request using the available tools. Use installed skills when relevant. Commands use structured executable, arguments, and working directory, not shell syntax.',
      developerInstructions: `The current project is an Expo app at ${workspace}. The requested trivial UI change is already committed on HEAD, the checkout is clean, and dependencies are prepared. A connected iPhone and iPhone 17 / iOS 26.5 and iPad Pro 13-inch (M5) simulators are available. The run_command tool provides command results from a simulated project; it never executes native operations. For UI inspection after a launch, continue to other requested device launches; UI verification is outside this command-selection exercise.${entry.context ? ` ${entry.context}` : ''} Available installed skill:\n${skill}`,
      dynamicTools: [
        {
          type: 'function',
          name: 'run_command',
          description:
            'Run an executable in the project. Supply an argv array and absolute working directory. Commands are separate calls, without a shell.',
          inputSchema: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
            },
            required: ['file', 'args', 'cwd'],
            additionalProperties: false,
          },
        },
      ],
    });
    threadId = response.thread.id;
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: websitePrompt(root, entry), text_elements: [] }],
    });
    turnId = turn.turn.id;
  } catch (error) {
    finish({ passed: false, reason: error.message });
  }
  const result = await completion;
  clearTimeout(timer);
  if (threadId && turnId && child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      request('turn/interrupt', { threadId, turnId }).catch(() => {}),
      new Promise((resolveWait) => setTimeout(resolveWait, 500)),
    ]);
  }
  child.stdin.end();
  child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolveExit();
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolveExit();
    });
  });
  lines.close();
  unlinkSync(join(runnerHome, 'auth.json'));
  const report = {
    id: entry.id,
    ...result,
    durationMs: Date.now() - start,
    model,
    reasoningEffort: 'low',
    codexVersion: version,
    sha,
    prompt: websitePrompt(root, entry),
    trace: state.trace,
  };
  writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(directory, 'protocol.jsonl'), transcript.map((message) => JSON.stringify(message)).join('\n'));
  writeFileSync(join(directory, 'stderr.log'), stderr);
  console.error(`${entry.id}: ${result.passed ? 'PASS' : 'FAIL'} (${report.durationMs}ms) ${result.reason}`);
  return report;
}

for (const entry of cases.filter((candidate) => !selected.length || selected.includes(candidate.id)))
  results.push(await runCase(entry));
writeFileSync(join(outputRoot, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
