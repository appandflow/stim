import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';

export function relocatePchArguments(args: readonly string[]): string[] {
  if (!args.includes('-relocatable-pch')) return [...args];
  const preprocessing = args.includes('-E');
  const consumingPch = !preprocessing && args.includes('-include-pch');
  const result = args.flatMap((arg) => {
    const macro = /^(-D__STIM_PCH_HEADER_\d+=)(.*)$/.exec(arg);
    if (!macro) return [arg];
    if (consumingPch) return [];
    return [`${macro[1]}${JSON.stringify(realpathSync(JSON.parse(macro[2]!)))}`];
  });
  for (let i = 0; i < result.length - 3; i += 1) {
    if (result[i] === '-Xclang' && result[i + 1] === '-isysroot' && result[i + 2] === '-Xclang') {
      // Clang 18 serializes absolute paths when its PCH relocation root is relative.
      result[i + 3] = realpathSync(result[i + 3]!);
    }
  }
  // ccache manifests need relative preprocessor paths; Clang 18 PCHs need canonical compiler paths.
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
  const defines: string[] = [];
  const headerBytes = Buffer.from(
    '#pragma once\n' +
      readFileSync(header, 'utf8').replace(/^#include ("(?:[^"\\]|\\.)*")$/gm, (line, quoted: string) => {
        const path: unknown = JSON.parse(quoted);
        if (typeof path !== 'string' || !isAbsolute(path)) return line;
        if (join(path) !== realpathSync(path)) throw new Error('Stim PCH header became a symlink; reconfigure CMake');
        const macro = `__STIM_PCH_HEADER_${defines.length}`;
        defines.push(`-D${macro}=${JSON.stringify(relative(process.cwd(), realpathSync(path)))}`);
        return `#include ${macro}\n#undef ${macro}`;
      }),
  );
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
  return [...defines, ...args.map((arg) => (arg === header ? stagedHeader : arg === source ? stagedSource : arg))];
}

function relocatePreprocessorOutput(bytes: Buffer, root: string): Buffer {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return bytes;
  // Clang's system-header linemarkers retain absolute paths in ccache 4 manifests.
  return Buffer.from(
    text.replace(/^(#[ \t]+\d+[ \t]+)("(?:[^"\\]|\\.)*")((?:[ \t]+[1-4])*[ \t]*)$/gm, (line, before, quoted, after) => {
      try {
        const filename: unknown = JSON.parse(quoted);
        if (typeof filename !== 'string' || !filename.startsWith(root + sep)) return line;
        return before + JSON.stringify(relative(process.cwd(), filename)) + after;
      } catch {
        return line;
      }
    }),
  );
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
    const normalized = cacheMode ? args : relocatePchArguments(args);
    const preprocessing = !cacheMode && normalized.includes('-E') && normalized.includes('-relocatable-pch');
    const rootIndex = normalized.findIndex(
      (arg, i) => arg === '-Xclang' && normalized[i + 1] === '-isysroot' && normalized[i + 2] === '-Xclang',
    );
    const root = rootIndex < 0 ? undefined : normalized[rootIndex + 3];
    const outputIndex = normalized.indexOf('-o');
    const outputPath = outputIndex < 0 ? undefined : normalized[outputIndex + 1];
    const child =
      cacheMode && cache && ccache
        ? getExecutor().spawn(ccache, [compiler, ...stagePchArguments(args, cache)], {
            stdio: 'inherit',
            env: { ...process.env, CCACHE_PREFIX: prefix, CCACHE_PREFIX_CPP: prefix },
          })
        : getExecutor().spawn(compiler, normalized, {
            stdio: preprocessing && root ? ['inherit', 'pipe', 'inherit'] : 'inherit',
          });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on('close', (code, signal) => {
      if (preprocessing && root) {
        if (code === 0 && outputPath && outputPath !== '-') {
          writeFileSync(outputPath, relocatePreprocessorOutput(readFileSync(outputPath), root));
        }
        const stdout = Buffer.concat(chunks);
        process.stdout.write(code === 0 ? relocatePreprocessorOutput(stdout, root) : stdout);
      }
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }
}
