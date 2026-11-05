import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it.skipIf(process.platform === 'win32')(
  'records attempted commands, interrupts a passing run, and fails a seeded wrong command without launching it (skipped on Windows: the fake Codex servers are shebang scripts and the harness redirects TMPDIR)',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'stim-prompt-protocol-'));
    try {
      mkdirSync(join(directory, 'tmp'));
      const auth = join(directory, 'auth.json');
      writeFileSync(auth, '{}');
      const fake = join(directory, 'codex');
      writeFileSync(
        fake,
        `#!${process.execPath}\n
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fake-protocol-server'); process.exit(); }
writeFileSync(process.env.TMPDIR + '/server-pid', String(process.pid));
let cwd;
const send = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (process.argv.includes('hang')) return;
  if (process.argv.includes('null') && request.method === 'initialize') { send(null); return; }
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'thread/start') { cwd = request.params.cwd; send({ id: request.id, result: { thread: { id: 'thread' } } }); }
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn' } } });
    if (process.argv.includes('malformed')) { send({ id: 100, method: 'item/tool/call' }); return; }
    send({ id: 100, method: 'item/tool/call', params: { tool: 'run_command', arguments: { file: 'stim', args: ['guide', 'agent'], cwd } } });
  }
  if (request.id === 100) send({ id: 101, method: 'item/tool/call', params: { tool: 'run_command', arguments: { file: 'stim', args: ['logs', '--errors', '--since', process.argv.includes('wrong') ? '1m' : '10m'], cwd } } });
  if (request.method === 'turn/interrupt') writeFileSync(cwd + '/interrupted', 'yes');
});
`,
      );
      chmodSync(fake, 0o755);
      const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
      function run(bin, timeout = 10_000) {
        let stderr;
        try {
          execFileSync(process.execPath, [runner, 'logs'], {
            env: {
              ...process.env,
              TMPDIR: join(directory, 'tmp'),
              STIM_PROMPT_CODEX_BIN: bin,
              STIM_PROMPT_CODEX_AUTH: auth,
              STIM_PROMPT_TIMEOUT_MS: String(timeout),
            },
            timeout: 15_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          stderr = error.stderr.toString();
        }
        return stderr;
      }
      expect(run(fake)).toBeUndefined();
      const wrong = join(directory, 'wrong');
      writeFileSync(wrong, `#!/bin/sh\nexec '${fake}' "$@" wrong\n`);
      chmodSync(wrong, 0o755);
      expect(run(wrong)).toContain('Expected errors from the last 10 minutes');
      const hang = join(directory, 'hang');
      writeFileSync(hang, `#!/bin/sh\nexec '${fake}' "$@" hang\n`);
      chmodSync(hang, 0o755);
      expect(run(hang, 1000)).toContain('deadline exceeded');
      for (const mode of ['null', 'malformed']) {
        const peer = join(directory, mode);
        writeFileSync(peer, `#!/bin/sh\nexec '${fake}' "$@" ${mode}\n`);
        chmodSync(peer, 0o755);
        expect(run(peer)).toContain('Malformed');
      }
      expect(readFileSync(auth, 'utf8')).toBe('{}');
      for (const runName of readdirSync(join(directory, 'tmp')).filter((name) =>
        name.startsWith('stim-prompt-eval-'),
      )) {
        const evidence = join(directory, 'tmp', runName, 'logs');
        const result = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'));
        const timedOut = result.reason.includes('deadline exceeded') || result.reason === 'Malformed protocol envelope';
        const interrupt = timedOut ? null : readFileSync(join(evidence, 'app/interrupted'), 'utf8');
        expect(interrupt).toBe(timedOut ? null : 'yes');
        expect(result.trace.map((command) => command.args[0])).toEqual(
          timedOut || result.reason === 'Malformed tool-call parameters' ? [] : ['guide', 'logs'],
        );
        const pid = Number(readFileSync(join(evidence, 'server-pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow('ESRCH');
        expect(readdirSync(join(evidence, 'codex-home'))).not.toContain('auth.json');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
