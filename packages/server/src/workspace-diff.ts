import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceDiff, WorkspaceFile, WorkspaceFiles, WorkspacePatch } from './protocol.ts';
import { runFileCommand } from './stim-command.ts';

const MAX_FILES = 200;
const PATCH_BYTES = 256 * 1024;
const LIST_BYTES = 1024 * 1024;

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function parseWorkspaceFiles(status: string): WorkspaceFile[] {
  return status
    .split('\0')
    .filter(Boolean)
    .map((row) => ({
      path: row.slice(3),
      staged: row[0] !== ' ' && row[0] !== '?',
      unstaged: row[1] !== ' ' && row[1] !== '?',
      untracked: row.startsWith('??'),
      status: row.slice(0, 2),
    }));
}

export async function readWorkspaceDiff(
  workspace: string,
  path: string | undefined,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  group?: 'changed' | 'untracked',
): Promise<WorkspaceFiles | WorkspaceDiff> {
  const gitEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnv, { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' });
  let cwd = await realpath(workspace);
  const git = async (args: string[], maxOutputBytes = LIST_BYTES, emptyConfig = false): Promise<string | null> => {
    signal.throwIfAborted();
    const run = runFileCommand(
      'git',
      gitEnv,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
      cwd,
      { timeoutMs: 5000, maxOutputBytes },
      'Workspace diff',
    );
    let rejectAbort!: (reason: unknown) => void;
    const abort = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      void run.cancel().then(() => rejectAbort(signal.reason));
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const outcome = await Promise.race([run.outcome, abort]);
      if (!outcome.ok) {
        if (emptyConfig && outcome.exitCode === 1) return '';
        if (outcome.message.includes('printed more than')) return null;
        throw new Error(outcome.message);
      }
      return outcome.stdout;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
  const top = await git(['rev-parse', '--show-toplevel']);
  if (!top) throw new Error('The workspace has no readable Git worktree.');
  const root = await realpath(top.replace(/\r?\n$/, ''));
  if (!within(root, cwd)) throw new Error('The registered workspace is outside its Git worktree.');
  cwd = root;
  const configured = await git(
    ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
    LIST_BYTES,
    true,
  );
  if (configured === null) throw new Error('The Git filter configuration is too large to check.');
  const drivers = new Set(
    configured.split('\0').flatMap((entry) => {
      const match = /^filter\.(.+)\.(?:clean|process)\n([\s\S]+)$/.exec(entry);
      return match?.[2]?.trim() ? [match[1]!] : [];
    }),
  );
  if (drivers.size) {
    const tracked = await git(['ls-files', '-z']);
    if (tracked === null) throw new Error('The tracked file list is too large to check for Git filters.');
    const paths = tracked.split('\0').filter(Boolean);
    let cursor = 0;
    while (cursor < paths.length) {
      const batch: string[] = [];
      let bytes = 0;
      while (cursor < paths.length && (bytes === 0 || bytes + Buffer.byteLength(paths[cursor]!) + 1 <= 16 * 1024)) {
        const next = paths[cursor++]!;
        bytes += Buffer.byteLength(next) + 1;
        batch.push(next);
      }
      const attributes = await git(['check-attr', '-z', '--all', '--', ...batch]);
      if (attributes === null) throw new Error('The Git filter attributes are too large to check.');
      const fields = attributes.split('\0');
      for (let i = 0; i + 2 < fields.length; i += 3) {
        if (fields[i + 1] === 'filter' && drivers.has(fields[i + 2]!)) {
          throw new Error(
            'Workspace diffs are unavailable because tracked files use a Git clean/process filter. Review on the Mac.',
          );
        }
      }
    }
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (status === null) throw new Error('The file list is too large to view.');
  const files = parseWorkspaceFiles(status);
  if (path === undefined) {
    const selected = files.filter((entry) => (group === 'untracked' ? entry.untracked : !entry.untracked));
    const shown: WorkspaceFile[] = [];
    for (const entry of selected.slice(0, MAX_FILES)) {
      if (Buffer.byteLength(JSON.stringify({ files: [...shown, entry], truncated: true })) > PATCH_BYTES) break;
      shown.push(entry);
    }
    return { files: shown, truncated: selected.length > shown.length };
  }
  const file = files.find((entry) => entry.path === path);
  if (!file || isAbsolute(path) || !within(root, resolve(root, path))) {
    throw new Error('This file is no longer a changed file in the selected workspace. Refresh the file list.');
  }
  const patches: WorkspacePatch[] = [];
  let remaining = PATCH_BYTES;
  if (file.status.includes('U') || file.status === 'AA' || file.status === 'DD') {
    return {
      path,
      patches: [{ section: 'unstaged', kind: 'unavailable', text: 'Unmerged file: resolve the conflict on the Mac.' }],
    };
  }
  if (file.untracked) {
    const target = resolve(root, path);
    const stat = await lstat(target);
    if (!stat.isFile())
      return {
        path,
        patches: [{ section: 'untracked', kind: 'unavailable', text: 'Only regular new files can be viewed.' }],
      };
    const canonical = await realpath(target);
    if (!within(root, canonical)) throw new Error('The new file resolves outside the selected Git worktree.');
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('The selected new file is not a regular file.');
      if (info.size > remaining) patches.push({ section: 'untracked', kind: 'too-large', text: '' });
      else {
        const bytes = Buffer.alloc(remaining + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const content = bytes.subarray(0, bytesRead);
        let text: string | null = null;
        if (bytesRead <= remaining && !content.includes(0)) {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(content);
          } catch {}
        }
        patches.push({
          section: 'untracked',
          kind: bytesRead > remaining ? 'too-large' : text === null ? 'binary' : 'text',
          text: text ?? '',
        });
      }
    } finally {
      await handle.close();
    }
  } else {
    const mode = await git(['ls-files', '--stage', '-z', '--', path]);
    if (mode?.startsWith('160000 '))
      return {
        path,
        patches: [
          {
            section: file.staged ? 'staged' : 'unstaged',
            kind: 'unavailable',
            text: 'Submodule changes: review the nested repository on the Mac.',
          },
        ],
      };
    for (const section of ['staged', 'unstaged'] as const) {
      if (!file[section]) continue;
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        ...(section === 'staged' ? ['--cached'] : []),
      ];
      const numstat = await git([...args, '--numstat', '-z', '--', path]);
      if (numstat === null) throw new Error('The selected file statistics are too large to view.');
      if (numstat.startsWith('-\t-\t')) patches.push({ section, kind: 'binary', text: '' });
      else {
        const text = remaining > 0 ? await git([...args, '--unified=3', '--', path], remaining) : null;
        patches.push({ section, kind: text === null ? 'too-large' : 'text', text: text ?? '' });
        if (text !== null) remaining -= Buffer.byteLength(text);
      }
    }
  }
  signal.throwIfAborted();
  const result = { path, patches };
  if (Buffer.byteLength(JSON.stringify(result)) > PATCH_BYTES) {
    return { path, patches: patches.map((patch) => ({ section: patch.section, kind: 'too-large', text: '' })) };
  }
  return result;
}
