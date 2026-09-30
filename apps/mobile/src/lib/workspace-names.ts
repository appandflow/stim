import type { EnvironmentState, StatusPayload } from '@/protocol/types';

export interface WorkspaceNames {
  title: string;
  subtitle: string;
}

/** Same naming as apps/desktop PathNames: a worktree is named after its folder under `.worktrees`/`worktrees`. */
function workspaceNames(path: string): WorkspaceNames {
  const parts = path.split('/').filter(Boolean);
  for (const marker of ['.worktrees', 'worktrees']) {
    const i = parts.lastIndexOf(marker);
    if (i >= 0 && i + 1 < parts.length) {
      const name = parts[i + 1];
      const last = parts[parts.length - 1];
      return { title: name, subtitle: last === name ? (i > 0 ? parts[i - 1] : '') : last };
    }
  }
  return { title: parts[parts.length - 1] ?? path, subtitle: parts.length > 1 ? parts[parts.length - 2] : '' };
}

export interface ProjectRef {
  /** The repository root, like apps/desktop, which asks git for the common directory. */
  key: string;
  name: string;
}

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** The repository a `.worktrees/<name>` or `.claude/worktrees/<name>` checkout belongs to. */
function worktreeRoot(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees') return parts.slice(0, i).join('/');
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude') return parts.slice(0, i - 1).join('/');
  }
  return null;
}

/** The parents of the payload's worktrees, and every other checkout, which can hold a nested app. */
export function repositoryRoots(payload: Pick<StatusPayload, 'environments' | 'unprovisionedWorktrees'>): string[] {
  const roots = new Set<string>();
  for (const { path, worktree } of payload.environments) {
    roots.add(worktreeRoot(path) ?? worktree?.repository ?? path);
  }
  for (const { path, repository } of payload.unprovisionedWorktrees ?? []) {
    const root = worktreeRoot(path) ?? repository;
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * The phone cannot run git, so a checkout joins the outermost known root that contains it, and is its
 * own project otherwise.
 */
export function projectOf(env: Pick<EnvironmentState, 'path' | 'worktree'>, roots: string[]): ProjectRef {
  const own = worktreeRoot(env.path) ?? env.worktree?.repository;
  const root =
    own ??
    roots
      .filter((r) => env.path === r || env.path.startsWith(`${r}/`))
      .reduce<string | null>((best, r) => (best === null || r.length < best.length ? r : best), null) ??
    env.path;
  return { key: root, name: basename(root) };
}

/** The `.worktrees/<name>` or `.claude/worktrees/<name>` folder holding `path`. */
function markedCheckout(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees' || (parts[i] === 'worktrees' && parts[i - 1] === '.claude')) {
      return parts.slice(0, i + 2).join('/');
    }
  }
  return null;
}

/** Where the workspace sits inside its checkout, such as `apps/tlon-mobile`; null at the checkout root. */
export function pathInCheckout(env: Pick<EnvironmentState, 'path' | 'worktree'>, roots: string[]): string | null {
  const checkout = markedCheckout(env.path) ?? env.worktree?.path ?? projectOf(env, roots).key;
  return env.path.startsWith(`${checkout}/`) ? env.path.slice(checkout.length + 1) : null;
}

/**
 * A workspace's name: its worktree's branch, else the worktree's folder, else the project for a main checkout.
 * `stim status` reports worktree facts only for linked worktrees, so a nested app in a repository with no known
 * worktree is its own project and is named after its folder.
 */
export function workspaceTitle(env: Pick<EnvironmentState, 'path' | 'worktree'>, roots: string[]): string {
  if (env.worktree?.branch) return env.worktree.branch;
  const checkout = env.worktree?.path ?? markedCheckout(env.path);
  return checkout ? basename(checkout) : projectOf(env, roots).name;
}

/** `workspaceTitle` of the workspace at `path` in `status`, or a name from the path alone when status lacks it. */
export function workspaceTitleAt(
  path: string,
  status: Pick<StatusPayload, 'environments' | 'unprovisionedWorktrees'> | null | undefined,
): string {
  const env = status?.environments.find((e) => e.path === path);
  return env && status ? workspaceTitle(env, repositoryRoots(status)) : workspaceNames(path).title;
}
