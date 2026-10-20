import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRootDirectories } from '@stim-cli/core/state';
import type { AndroidProject } from './android-project.ts';
import type { IosProject } from './ios-project.ts';
import type { MacosProject } from './macos-project.ts';
import type { WebProject } from './web-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';
import type { ResolvedProjectSettings, SettingsObject } from '../workspace/settings.ts';

export type ProjectPlatform = 'ios' | 'android' | 'macos' | 'web';
type ProjectOperation = 'ios' | 'android' | 'macos' | 'dev-server' | 'web';

interface ProjectProblem {
  kind: 'not-an-app' | 'unreadable' | 'ambiguous';
  message: string;
  remedy: string;
}

interface ProjectMatch {
  root: 'explicit' | 'candidate' | false;
  application: boolean;
  ownedRoots?: readonly string[];
  platforms(resolved: ResolvedProjectSettings): ProjectPlatform[];
  android?(resolved: ResolvedProjectSettings): Promise<AndroidProject>;
  ios?(settings: SettingsObject): Promise<IosProject>;
  macos?(): Promise<MacosProject>;
  web?(): Promise<WebProject>;
  doctor?(): Promise<ProjectDoctor>;
  validate?(operation: ProjectOperation): ProjectProblem | null | undefined;
}

export interface ProjectIntegration {
  id: string;
  inspect(root: string): ProjectMatch | null;
}

export interface ProjectRegistry {
  findProjectRoot(startDir: string): string | null;
  projectProblem(root: string, operation: ProjectOperation): ProjectProblem | null;
  selectAndroid(
    root: string,
  ): { id: string; load: (resolved: ResolvedProjectSettings) => Promise<AndroidProject> } | { problem: ProjectProblem };
  selectIos(
    root: string,
  ): { id: string; load: (settings: SettingsObject) => Promise<IosProject> } | { problem: ProjectProblem };
  selectMacos(root: string): { load: () => Promise<MacosProject> } | { problem: ProjectProblem };
  selectWeb(root: string): { load: () => Promise<WebProject> } | { problem: ProjectProblem };
  selectDoctor(
    root: string,
    platform?: 'ios' | 'android',
  ): {
    load: () => Promise<ProjectDoctor[]>;
    platforms: ('ios' | 'android')[];
    problem: ProjectProblem | null;
  };
  isMobileProject(root: string): boolean;
  keepsWorkspace(root: string): boolean;
  detectPlatforms(root: string, resolved: ResolvedProjectSettings): ProjectPlatform[];
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function operationSelection(
  root: string,
  matches: readonly (ProjectMatch & { id: string })[],
  operation: ProjectOperation,
): { match: ProjectMatch & { id: string } } | { problem: ProjectProblem } {
  const results = matches.flatMap((match) => {
    const problem = match.validate?.(operation);
    return problem === undefined ? [] : [{ match, problem }];
  });
  const unreadable = results.find(({ problem }) => problem?.kind === 'unreadable');
  if (unreadable?.problem) return { problem: unreadable.problem };
  const providers = results.filter(({ problem }) => problem === null);
  if (providers.length > 1)
    return {
      problem: {
        kind: 'ambiguous',
        message: `Multiple project integrations support ${operation} at ${root}: ${providers.map(({ match }) => match.id).join(', ')}.`,
        remedy: 'Run this from the directory of the app you intend to use, with one integration for this operation.',
      },
    };
  if (providers.length === 1) return { match: providers[0]!.match };
  return {
    problem: results[0]?.problem ?? {
      kind: 'not-an-app',
      message: `No project integration supports ${operation} at ${root}.`,
      remedy: 'Run this from the directory of a supported app.',
    },
  };
}

function operationProblem(
  root: string,
  matches: readonly (ProjectMatch & { id: string })[],
  operation: ProjectOperation,
): ProjectProblem | null {
  const selected = operationSelection(root, matches, operation);
  return 'problem' in selected ? selected.problem : null;
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

  function selectAndroid(root: string): ReturnType<ProjectRegistry['selectAndroid']> {
    root = canonicalPath(root);
    const matches = inspect(root);
    const problem = ownedRootProblem(root, matches);
    if (problem) return { problem };
    const selected = operationSelection(root, matches, 'android');
    if ('problem' in selected) return selected;
    if (selected.match.android) return { id: selected.match.id, load: selected.match.android };
    return {
      problem: {
        kind: 'not-an-app',
        message: `The ${selected.match.id} integration does not provide an Android operation.`,
        remedy: 'Use an integration with an Android build and runtime recipe.',
      },
    };
  }

  function selectMacos(root: string): ReturnType<ProjectRegistry['selectMacos']> {
    root = canonicalPath(root);
    const matches = inspect(root);
    const problem = ownedRootProblem(root, matches);
    if (problem) return { problem };
    const selected = operationSelection(root, matches, 'macos');
    if ('problem' in selected) return selected;
    if (selected.match.macos) return { load: selected.match.macos };
    return {
      problem: {
        kind: 'not-an-app',
        message: `The ${selected.match.id} integration does not provide a macOS operation.`,
        remedy: 'Use an integration with a macOS build recipe.',
      },
    };
  }

  function selectWeb(root: string): ReturnType<ProjectRegistry['selectWeb']> {
    root = canonicalPath(root);
    const matches = inspect(root);
    const problem = ownedRootProblem(root, matches);
    if (problem) return { problem };
    const selected = operationSelection(root, matches, 'web');
    if ('problem' in selected) return selected;
    if (selected.match.web) return { load: selected.match.web };
    return {
      problem: {
        kind: 'not-an-app',
        message: `The ${selected.match.id} integration does not provide a web operation.`,
        remedy: 'Use an integration with a web runtime recipe.',
      },
    };
  }

  function selectIos(root: string): ReturnType<ProjectRegistry['selectIos']> {
    root = canonicalPath(root);
    const matches = inspect(root);
    const problem = ownedRootProblem(root, matches);
    if (problem) return { problem };
    const selected = operationSelection(root, matches, 'ios');
    if ('problem' in selected) return selected;
    if (selected.match.ios) return { id: selected.match.id, load: selected.match.ios };
    return {
      problem: {
        kind: 'not-an-app',
        message: `The ${selected.match.id} integration does not provide an iOS operation.`,
        remedy: 'Use an integration with an iOS build and runtime recipe.',
      },
    };
  }

  function isMobileProject(root: string): boolean {
    root = canonicalPath(root);
    const matches = inspect(root);
    return (
      ownedRootProblem(root, matches) === null &&
      (operationProblem(root, matches, 'ios') === null || operationProblem(root, matches, 'android') === null)
    );
  }

  function selectDoctor(root: string, platform?: 'ios' | 'android'): ReturnType<ProjectRegistry['selectDoctor']> {
    root = canonicalPath(root);
    const matches = inspect(root);
    const operations: ProjectOperation[] = platform ? [platform] : ['ios', 'android', 'macos', 'dev-server'];
    const selected = operations.map((operation) => ({
      operation,
      result: operationSelection(root, matches, operation),
    }));
    const accepted = selected.flatMap(({ operation, result }) =>
      'match' in result && result.match.application ? [{ operation, match: result.match }] : [],
    );
    const invalid = selected.flatMap(({ result }) => ('problem' in result ? [result.problem] : []));
    const problem =
      ownedRootProblem(root, matches) ??
      invalid.find((value) => value.kind === 'unreadable' || value.kind === 'ambiguous') ??
      (accepted.length
        ? null
        : (invalid[0] ?? {
            kind: 'not-an-app' as const,
            message: `No project integration recognizes an application at ${root}.`,
            remedy: 'Run this from the directory of a supported app.',
          }));
    const providers = [...new Map(accepted.map(({ match }) => [match.id, match])).values()];
    return {
      problem,
      platforms: problem
        ? []
        : accepted.flatMap(({ operation }) => (operation === 'ios' || operation === 'android' ? [operation] : [])),
      load: async () =>
        problem ? [] : Promise.all(providers.flatMap((match) => (match.doctor ? [match.doctor()] : []))),
    };
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

  function detectPlatforms(root: string, resolved: ResolvedProjectSettings): ProjectPlatform[] {
    const platforms = new Set(inspect(root).flatMap((match) => match.platforms(resolved)));
    const ordered: ProjectPlatform[] = ['ios', 'android', 'macos', 'web'];
    return ordered.filter((platform) => platforms.has(platform));
  }

  return {
    findProjectRoot,
    projectProblem,
    selectAndroid,
    selectIos,
    selectMacos,
    selectWeb,
    selectDoctor,
    isMobileProject,
    keepsWorkspace,
    detectPlatforms,
  };
}
