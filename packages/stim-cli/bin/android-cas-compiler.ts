#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../src/exec.ts';
import { waitForChild } from '../src/process-output.ts';

const config = JSON.parse(readFileSync(process.env.STIM_ANDROID_CAS_CONTEXT!, 'utf8')) as {
  clang: string;
  clangxx: string;
  lld: string;
  ndk: string;
  resourceDir: string;
  source: string;
  state: string;
  cache: string;
};
const args = process.argv.slice(2);
const cxx = process.argv[1]!.endsWith('++');
const compiler = cxx ? config.clangxx : config.clang;
const extra = ['-resource-dir', config.resourceDir];
if (cxx) {
  extra.push(
    '-nostdinc++',
    '-isystem',
    join(config.ndk, 'toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/include/c++/v1'),
  );
}
if (!args.some((arg) => ['-c', '-E', '-S'].includes(arg))) extra.push(`--ld-path=${config.lld}`);
if (args.includes('-c')) {
  const cwd = process.cwd();
  const overlays = join(config.state, 'vfs');
  mkdirSync(overlays, { recursive: true });
  const overlay = join(overlays, `${createHash('sha256').update(cwd).digest('hex')}.json`);
  if (!existsSync(overlay)) {
    const temporary = `${overlay}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({
        version: 0,
        'use-external-names': false,
        roots: [
          { type: 'directory-remap', name: '/^src', 'external-contents': config.source },
          { type: 'directory-remap', name: '/^build', 'external-contents': cwd },
        ],
      }),
    );
    renameSync(temporary, overlay);
  }
  extra.push(
    '-ivfsoverlay',
    overlay,
    '-fdepscan=inline',
    '-fdepscan-include-tree',
    '-Xclang',
    '-fcas-path',
    '-Xclang',
    config.cache,
    '-Rcompile-job-cache',
    `-fdepscan-prefix-map=${config.source}=/^src`,
    `-fdepscan-prefix-map=${cwd}=/^build`,
    `-fdepscan-prefix-map=${config.state}=/^state`,
  );
}
const started = performance.now();
const child = getExecutor().spawn(compiler, [...extra, ...args], { stdio: ['inherit', 'pipe', 'pipe'] });
let stderr = '';
child.stdout!.on('data', (chunk: Buffer) => process.stdout.write(chunk));
child.stderr!.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});
const result = await waitForChild(child);
appendFileSync(
  join(config.state, 'compiler.jsonl'),
  `${JSON.stringify({
    argv: [compiler, ...extra, ...args],
    cwd: process.cwd(),
    code: result.code,
    seconds: (performance.now() - started) / 1000,
    stderr,
  })}\n`,
);
if (result.error) throw result.error;
process.exitCode = result.code ?? 1;
