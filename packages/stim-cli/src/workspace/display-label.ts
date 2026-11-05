import { basename } from 'node:path';
import type { Config } from './config.ts';

interface LabeledWorkspace {
  root: string;
  label?: string;
}

function baseLabel({ root, label }: LabeledWorkspace): string {
  return label || basename(root);
}

function pathSegments(root: string): string[] {
  return root
    .split(/[\\/]+/)
    .filter(Boolean)
    .toReversed();
}

export function workspaceLabels(workspaces: readonly LabeledWorkspace[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, LabeledWorkspace[]>();
  for (const workspace of workspaces) {
    const base = baseLabel(workspace);
    const group = groups.get(base) ?? [];
    if (!group.some(({ root }) => root === workspace.root)) group.push(workspace);
    groups.set(base, group);
  }
  for (const [base, group] of groups) {
    const [only] = group;
    if (group.length === 1 && only) {
      labels.set(only.root, base);
      continue;
    }
    const segments = group.map(({ root }) => pathSegments(root));
    const longest = Math.max(...segments.map((parts) => parts.length));
    let depth = 0;
    while (depth < longest && segments.every((parts) => parts[depth] === segments[0]?.[depth])) depth++;
    const suffixes = segments.map((parts) => parts[depth]);
    const distinct = new Set(suffixes).size === group.length;
    group.forEach(({ root }, index) => {
      const suffix = distinct ? suffixes[index] : root;
      labels.set(root, suffix ? `${base} (${suffix})` : base);
    });
  }
  return labels;
}

export function workspaceDisplayLabel(root: string, config: Config | null): string {
  const registered = Object.entries(config?.projects ?? {}).map(([path, project]) => ({
    root: path,
    label: project.label,
  }));
  const own = registered.find((entry) => entry.root === root);
  return workspaceLabels([...registered, own ?? { root }]).get(root) ?? basename(root);
}
