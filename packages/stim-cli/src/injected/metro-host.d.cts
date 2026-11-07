import type { Server } from 'node:http';

type MetroModule = Record<string, (...args: never[]) => unknown>;

export interface BareDeps {
  metro: MetroModule;
  devMiddleware: MetroModule;
  serverApi: MetroModule;
}

export function resolveBareDeps(root: string, options?: { requireFrom?: (root: string) => NodeJS.Require }): BareDeps;
export function appendCacheStore(
  config: { cacheStores?: unknown },
  options: { storeRoot: string; FileStore: new (options: { root: string }) => object },
): { added: boolean; reason?: string };
export function normalizeMetroTransformerPaths(config: unknown, root: string): boolean;
export function symbolicationReporterMiddleware(reporter: {
  update(event: unknown): void;
}): (req: unknown, res: unknown, next: () => void) => void;
export function startHost(options: {
  root: string;
  port: number;
  logsDir: string;
  storeRoot?: string | null;
  resetCache?: boolean;
  deps?: unknown;
  reporterFactory?: (options: { dir: string }) => { update(event: unknown): void };
  fileStore?: (new (options: { root: string }) => object) | null;
}): Promise<Server>;
