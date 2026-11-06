import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface PluginSource {
  manifest(): unknown | Promise<unknown>;
  load(): Promise<unknown>;
}

export function projectPlugin(reference: string, baseDir: string): PluginSource {
  const resolve = () => createRequire(join(baseDir, 'package.json')).resolve(reference);
  return {
    manifest() {
      let dir = dirname(resolve());
      for (;;) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          if (isRecord(manifest) && ('name' in manifest || 'stimPlugin' in manifest)) return manifest;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`${reference} has no package.json`);
        dir = parent;
      }
    },
    load: () => import(pathToFileURL(resolve()).href),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'unknown error';
}

// compat C15 permanent
async function kindError(
  source: PluginSource,
  reference: string,
  kind: string,
  version: number,
): Promise<string | null> {
  const manifest = await source.manifest();
  const plugin = isRecord(manifest) ? manifest.stimPlugin : undefined;
  const kinds = isRecord(plugin) ? plugin.kinds : undefined;
  const found = isRecord(kinds) ? kinds[kind] : undefined;
  if (Number.isInteger(found) && found === version) return null;
  return `plugin ${reference} speaks ${kind} ${String(found)}, this stim speaks ${version}: stim engine update`;
}
// compat end

export async function loadKind<T>({
  reference,
  kind,
  version,
  source,
  factory,
  input,
  instantiate = true,
  validateModule,
  accept,
  dispose,
  timeoutMs,
}: {
  reference: string;
  kind: string;
  version: number;
  source: PluginSource;
  factory: string;
  input?: unknown;
  instantiate?: boolean;
  validateModule?(module: Record<string, unknown>): string | null;
  accept(value: unknown): T;
  dispose?(value: T): void | Promise<void>;
  timeoutMs: number;
}): Promise<{ value: T } | { unavailable: string }> {
  const loading = Promise.resolve()
    .then(async (): Promise<{ value: T } | { unavailable: string }> => {
      const mismatch = await kindError(source, reference, kind, version);
      if (mismatch) return { unavailable: mismatch };
      const namespace = await source.load();
      const module =
        isRecord(namespace) && !(factory in namespace) && 'default' in namespace ? namespace.default : namespace;
      if (!isRecord(module) || typeof module[factory] !== 'function')
        return { unavailable: `the module does not export ${factory}()` };
      const moduleError = validateModule?.(module);
      if (moduleError) return { unavailable: moduleError };
      let value: unknown = module;
      if (instantiate) {
        try {
          value = await module[factory](input);
        } catch (error) {
          return { unavailable: `${factory}() failed: ${reason(error)}` };
        }
      }
      return { value: accept(value) };
    })
    .catch((error: unknown) => ({ unavailable: reason(error) }));
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      loading,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (result !== 'timeout') return result;
    void loading.then((late) => ('value' in late ? dispose?.(late.value) : undefined)).catch(() => undefined);
    return { unavailable: `the module did not load within ${timeoutMs}ms` };
  } finally {
    clearTimeout(timer);
  }
}
