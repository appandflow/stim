import type { PluginKind } from '@stim-cli/core/state';

export interface BuiltinPlugin {
  kind: PluginKind;
  /** Why `stim plugin test` does not run this one. */
  untested?: string;
}

/** The plugins this Stim bundles, named `builtin:<name>`. They speak this Stim's integer for their kind. */
export const BUILTIN_PLUGINS: Readonly<Record<string, BuiltinPlugin>> = {
  local: { kind: 'transport' },
  tailscale: {
    kind: 'transport',
    untested: "it reads and watches this Mac's Tailscale, so the kit does not run it",
  },
  'agent-device': { kind: 'agent-driver' },
};

export const BUILTIN_PREFIX = 'builtin:';

/** The built-in a `builtin:<name>` reference names; undefined for anything else. */
export function builtinPlugin(reference: string): BuiltinPlugin | undefined {
  const name = reference.startsWith(BUILTIN_PREFIX) ? reference.slice(BUILTIN_PREFIX.length) : '';
  return Object.hasOwn(BUILTIN_PLUGINS, name) ? BUILTIN_PLUGINS[name] : undefined;
}
