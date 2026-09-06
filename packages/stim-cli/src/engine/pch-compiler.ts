import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';

export function relocatePchArguments(args: readonly string[]): string[] {
  const result = [...args];
  if (!result.includes('-relocatable-pch')) return result;
  for (let i = 0; i < result.length - 3; i += 1) {
    if (result[i] === '-Xclang' && result[i + 1] === '-isysroot' && result[i + 2] === '-Xclang') {
      // Clang 18 serializes absolute paths when its PCH relocation root is relative.
      result[i + 3] = realpathSync(result[i + 3]!);
    }
  }
  // ccache manifests need relative preprocessor paths; Clang 18 PCHs need canonical compiler paths.
  const preprocessing = result.includes('-E');
  if (preprocessing) return result;
  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i]!;
    if (['-I', '-isystem', '-iquote', '-idirafter'].includes(arg) && result[i + 1]) {
      try {
        result[i + 1] = realpathSync(result[i + 1]!);
      } catch {}
      i += 1;
    } else if (arg.startsWith('-I') && arg.length > 2) {
      try {
        result[i] = `-I${realpathSync(arg.slice(2))}`;
      } catch {}
    }
  }
  return result;
}

function stagePchArguments(args: string[], cache: string): string[] {
  const index = args.findIndex(
    (arg, i) => arg === '-include' && args[i + 1] === '-Xclang' && basename(args[i + 2] ?? '') === 'cmake_pch.hxx',
  );
  if (index < 0) return args;
  const header = args[index + 2]!;
  const source = `${header}.cxx`;
  const headerBytes = readFileSync(header);
  const sourceBytes = readFileSync(source);
  const key = createHash('sha256')
    .update(`${headerBytes.length}\0`)
    .update(headerBytes)
    .update(sourceBytes)
    .digest('hex');
  const directory = join(cache, key);
  const stagedHeader = join(directory, 'cmake_pch.hxx');
  const stagedSource = join(directory, 'cmake_pch.hxx.cxx');
  if (!existsSync(directory)) {
    mkdirSync(cache, { recursive: true });
    const temporary = join(cache, `.tmp-${randomUUID()}`);
    mkdirSync(temporary);
    try {
      writeFileSync(join(temporary, 'cmake_pch.hxx'), headerBytes);
      writeFileSync(join(temporary, 'cmake_pch.hxx.cxx'), sourceBytes);
      try {
        renameSync(temporary, directory);
      } catch (error) {
        if (!existsSync(directory)) throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (!readFileSync(stagedHeader).equals(headerBytes) || !readFileSync(stagedSource).equals(sourceBytes)) {
    throw new Error('Stim PCH header cache content does not match its identity');
  }
  return args.map((arg) => (arg === header ? stagedHeader : arg === source ? stagedSource : arg));
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = process.argv.slice(2);
  const cacheMode = input[0] === '--cache';
  const [cache, ccache] = cacheMode ? input.splice(0, 3).slice(1) : [];
  const [compiler, ...args] = input;
  if (!compiler) process.exitCode = 1;
  else {
    const prefix = `${process.execPath} ${fileURLToPath(import.meta.url)}`;
    const child =
      cacheMode && cache && ccache
        ? getExecutor().spawn(ccache, [compiler, ...stagePchArguments(args, cache)], {
            stdio: 'inherit',
            env: { ...process.env, CCACHE_PREFIX: prefix, CCACHE_PREFIX_CPP: prefix },
          })
        : getExecutor().spawn(compiler, relocatePchArguments(args), { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }
}
