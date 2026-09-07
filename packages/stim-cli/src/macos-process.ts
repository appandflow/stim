import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDir } from './config.ts';
import { getExecutor } from './exec.ts';

type MacosProcess = { args: string[]; startTime: Date; zombie: boolean };

function helperPath(): string {
  const source = ['../shim/macos-process.c', '../../shim/macos-process.c']
    .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    .find(existsSync);
  if (!source) throw new Error('macOS process helper source is missing');
  const hash = createHash('sha256').update(readFileSync(source)).update(process.arch).digest('hex');
  const directory = join(getConfigDir(), 'tools', `macos-process-${hash}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = join(directory, 'process');
  if (!existsSync(binary)) {
    const temporary = mkdtempSync(join(directory, 'compile-'));
    try {
      const output = join(temporary, 'process');
      getExecutor().runFile(
        '/usr/bin/clang',
        ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
        {
          timeoutMs: 5_000,
        },
      );
      chmodSync(output, 0o700);
      renameSync(output, binary);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('macOS process helper is not a private owned executable');
  }
  return binary;
}

export function readMacosProcess(pid: number): MacosProcess | null {
  if (process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  try {
    const output = getExecutor().runFile(helperPath(), [String(pid)], { timeoutMs: 1_000 });
    if (output.length > 66_000) return null;
    const value = JSON.parse(output);
    if (
      value.pid !== pid ||
      typeof value.zombie !== 'boolean' ||
      typeof value.startSeconds !== 'string' ||
      !/^[1-9]\d{0,10}$/.test(value.startSeconds) ||
      !Number.isInteger(value.startMicros) ||
      value.startMicros < 0 ||
      value.startMicros >= 1_000_000 ||
      !Number.isInteger(value.argc) ||
      value.argc < 0 ||
      value.argc > 32_768 ||
      typeof value.argvHex !== 'string' ||
      value.argvHex.length > 65_536 ||
      !/^(?:[a-f0-9]{2})*$/.test(value.argvHex)
    )
      return null;
    const bytes = Buffer.from(value.argvHex, 'hex');
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded).equals(bytes)) return null;
    const args = decoded.split('\0');
    if (args.pop() !== '' || args.length !== value.argc) return null;
    if (value.zombie ? args.length !== 0 : !args[0]) return null;
    while (args.length > 1 && args.at(-1) === '') args.pop();
    return {
      args,
      startTime: new Date(Number(value.startSeconds) * 1_000 + Math.floor(value.startMicros / 1_000)),
      zombie: value.zombie,
    };
  } catch {
    return null;
  }
}
