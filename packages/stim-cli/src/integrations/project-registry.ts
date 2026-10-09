import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRootDirectories } from '@stim-cli/core/state';
import type { SettingsObject } from '../workspace/settings.ts';

export type ProjectPlatform = 'ios' | 'android' | 'macos' | 'web';
type ProjectOperation = 'ios' | 'android' | 'dev-server';

interface ProjectProblem {
  kind: 'not-an-app' | 'unreadable' | 'ambiguous';
  message: string;
  remedy: string;
}

interface ProjectMatch {
  root: 'explicit' | 'candidate' | false;
  application: boolean;
  ownedRoots?: readonly string[];
  platforms(settings: SettingsObject): ProjectPlatform[];
  validate?(operation: ProjectOperation): ProjectProblem | null | undefined;
}

export interface ProjectIntegration {
  id: string;
  inspect(root: string): ProjectMatch | null;
}

export interface ProjectRegistry {
  findProjectRoot(startDir: string): string | null;
  projectProblem(root: string, operation: ProjectOperation): ProjectProblem | null;
  isMobileProject(root: string): boolean;
  keepsWorkspace(root: string): boolean;
  detectPlatforms(root: string, settings: SettingsObject): ProjectPlatform[];
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function operationProblem(
  root: string,
  matches: readonly (ProjectMatch & { id: string })[],
  operation: ProjectOperation,
): ProjectProblem | null {
  const results = matches.flatMap((match) => {
    const problem = match.validate?.(operation);
    return problem === undefined ? [] : [{ id: match.id, problem }];
  });
  const unreadable = results.find(({ problem }) => problem?.kind === 'unreadable');
  if (unreadable?.problem) return unreadable.problem;
  const providers = results.filter(({ problem }) => problem === null);
  if (providers.length > 1)
    return {
      kind: 'ambiguous',
      message: `Multiple project integrations support ${operation} at ${root}: ${providers.map(({ id }) => id).join(', ')}.`,
      remedy: 'Run this from the directory of the app you intend to use, with one integration for this operation.',
    };
  if (providers.length === 1) return null;
  return (
    results[0]?.problem ?? {
      kind: 'not-an-app',
      message: `No project integration supports ${operation} at ${root}.`,
      remedy: 'Run this from the directory of a supported app.',
    }
  );
}

export function createProjectRegistry(integrations: readonly ProjectIntegration[]): ProjectRegistry {
  const inspect = (root: string) =>
    integrations.flatMap((integration) => {
      const match = integration.inspect(root);
      return match ? [{ id: integration.id, ...match }] : [];
    });

  function findProjectRoot(startDir: string, read = inspect): string | null {
    let candidates: string[] = [];
    for (const root of projectRootDirectories(startDir)) {
      const matches = read(root);
      const owned = new Set(matches.flatMap((match) => match.ownedRoots ?? []).map(canonicalPath));
      candidates = candidates.filter((candidate) => !owned.has(candidate));
      if (matches.some((match) => match.root === 'explicit')) return candidates[0] ?? root;
      if (matches.some((match) => match.root === 'candidate')) candidates.push(root);
    }
    return candidates[0] ?? null;
  }

  function ownedRootProblem(root: string, matches: ReturnType<typeof inspect>): ProjectProblem | null {
    if (matches.some((match) => match.root === 'candidate') && !matches.some((match) => match.root === 'explicit')) {
      const owner = findProjectRoot(root, (dir) => (dir === root ? matches : inspect(dir)));
      if (owner !== null && owner !== root)
        return {
          kind: 'not-an-app',
          message: `${root} belongs to the project at ${owner}.`,
          remedy: `Run this from ${owner}.`,
        };
    }
    return null;
  }

  function projectProblem(root: string, operation: ProjectOperation): ProjectProblem | null {
    root = canonicalPath(root);
    const matches = inspect(root);
    return ownedRootProblem(root, matches) ?? operationProblem(root, matches, operation);
  }

  function isMobileProject(root: string): boolean {
    root = canonicalPath(root);
    const matches = inspect(root);
    return (
      ownedRootProblem(root, matches) === null &&
      (operationProblem(root, matches, 'ios') === null || operationProblem(root, matches, 'android') === null)
    );
  }

  function keepsWorkspace(root: string): boolean {
    const matches = inspect(root);
    return (
      matches.some((match) => match.application) ||
      (['ios', 'android', 'dev-server'] as const).some(
        (operation) => operationProblem(root, matches, operation)?.kind === 'unreadable',
      )
    );
  }

  function detectPlatforms(root: string, settings: SettingsObject): ProjectPlatform[] {
    const platforms = new Set(inspect(root).flatMap((match) => match.platforms(settings)));
    const ordered: ProjectPlatform[] = ['ios', 'android', 'macos', 'web'];
    return ordered.filter((platform) => platforms.has(platform));
  }

  return { findProjectRoot, projectProblem, isMobileProject, keepsWorkspace, detectPlatforms };
}
