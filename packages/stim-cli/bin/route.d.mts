export type InstallKind = 'store' | 'development' | 'npx' | 'machine' | 'project';

export function compareVersions(left: string, right: string): number | null;
export function installKind(dir: string, root: string): InstallKind;

export interface RouteInput {
  args: readonly string[];
  copy: { version: string; kind: InstallKind };
  current:
    | {
        format: unknown;
        version: string;
        node: { path: string; version: string }[];
        engines: string;
        channel: string;
        pinned: boolean;
        pinReason: string | null;
      }
    | null
    | undefined;
  staged: { version: string } | null;
  node: string;
}

export interface Route {
  run: 'own' | 'engine' | 'node' | 'refuse';
  node?: string;
  note?: string | null;
  fallback?: boolean;
  promote?: 'inline' | 'detached';
}

export function route(input: RouteInput): Route;
