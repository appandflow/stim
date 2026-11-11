import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineOp, type Op } from '../cli/define-op.ts';
import { BUILTIN_PLUGINS, builtinPlugin } from '../plugin-builtins.ts';
import { readSettingsContext } from '../workspace/settings-payload.ts';

interface PluginRefusal {
  code: string;
  message: string;
  remedy: string;
}

class Refusal extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(message);
    this.code = code;
    this.remedy = remedy;
  }
}

interface PluginCheck {
  kind: string;
  name: string;
  passed: boolean;
  error?: string;
}

/** The payload `stim plugin test --json` prints. */
interface PluginTestPayload {
  reference: string;
  kinds: Record<string, unknown>;
  /** Declared kinds the command does not run, with the reason. */
  skipped: Array<{ kind: string; reason: string }>;
  checks: PluginCheck[];
  passed: boolean;
}

const TESTED_KINDS = new Set(['transport', 'agent-driver']);

const CACHE_PROVIDER_SKIP =
  'a cache provider runs in the calling process; test it with runCacheProviderContract from stim/plugin in its own tests';

async function run(json: boolean, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const refusal: PluginRefusal = { code: error.code, message: error.message, remedy: error.remedy };
    console.error(chalk.red(`${refusal.code}: ${refusal.message}`));
    console.error(chalk.dim(refusal.remedy));
    if (json) console.log(JSON.stringify(refusal));
    process.exitCode = 1;
  }
}

async function declaredKinds(reference: string, cwd: string): Promise<Record<string, unknown>> {
  const builtin = builtinPlugin(reference);
  if (reference.startsWith('builtin:')) {
    if (!builtin)
      throw new Refusal(
        'STIM_BAD_ARG',
        `This Stim bundles no plugin named ${reference}.`,
        `The built-in plugins are ${Object.keys(BUILTIN_PLUGINS)
          .map((name) => `builtin:${name}`)
          .join(', ')}.`,
      );
    if (builtin.untested)
      throw new Refusal('STIM_BAD_ARG', `${reference} is not tested: ${builtin.untested}.`, 'Test another plugin.');
    const { PLUGIN_API } = await import('../plugin-refs.ts');
    return { [builtin.kind]: PLUGIN_API[builtin.kind] };
  }
  const { manifestKinds } = await import('../plugin-refs.ts');
  try {
    return await manifestKinds(reference, cwd);
  } catch (error) {
    throw new Refusal(
      'STIM_BAD_ARG',
      `${reference} does not resolve from ${cwd}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      'Name a path that starts with ./ or /, a package installed here, or builtin:<name>.',
    );
  }
}

async function testPlugin(reference: string, cwd: string): Promise<PluginTestPayload> {
  const kinds = await declaredKinds(reference, cwd);
  const skipped = Object.keys(kinds)
    .filter((kind) => !TESTED_KINDS.has(kind))
    .map((kind) => ({
      kind,
      reason: kind === 'cache-provider' ? CACHE_PROVIDER_SKIP : `stim plugin test has no kit for ${kind}`,
    }));
  const tested = Object.keys(kinds).filter((kind) => TESTED_KINDS.has(kind));
  if (tested.length === 0)
    throw new Refusal(
      'STIM_BAD_ARG',
      `${reference} declares no plugin kind this command tests (${Object.keys(kinds).join(', ') || 'stimPlugin.kinds is empty'}).`,
      skipped.length
        ? skipped.map(({ kind, reason }) => `${kind}: ${reason}.`).join(' ')
        : 'Declare stimPlugin.kinds in its package.json, such as {"transport": 1} or {"agent-driver": 1}.',
    );
  const { runContract } = await import('../transport-kit.ts');
  const checks: PluginCheck[] = [];
  for (const kind of tested) {
    if (kind === 'transport') {
      const results = await runContract('transport', { reference, baseDir: cwd, env: {}, options: {} });
      for (const result of results) checks.push({ kind, ...result });
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), 'stim-plugin-test-'));
    try {
      const builtin = builtinPlugin(reference);
      const results = await runContract('agent-driver', {
        reference,
        baseDir: cwd,
        ...(builtin ? { id: reference.slice('builtin:'.length) } : {}),
        unavailableInput: {
          env: { HOME: scratch, PATH: join(scratch, 'bin'), STIM_AGENT_DEVICE_BIN: join(scratch, 'missing') },
          stateDir: join(scratch, 'driver'),
          claimRoot: join(scratch, 'driver.claims'),
        },
        app: { client: 'stim-plugin-test', session: randomUUID(), bundleId: 'dev.stim.plugin-test', pid: 1 },
      });
      for (const result of results) checks.push({ kind, ...result });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { reference, kinds, skipped, checks, passed: checks.every((check) => check.passed) };
}

const list = defineOp({
  name: 'list',
  description: 'List the plugins this Stim bundles and the ones the settings name, with the kind integer each speaks',
  options: { json: { flags: '--json', description: 'print the plugins as JSON' } },
  run: ({ options }) =>
    run(Boolean(options.json), async () => {
      const { listPlugins, PLUGIN_API } = await import('../plugin-refs.ts');
      const plugins = await listPlugins(await readSettingsContext(process.cwd(), process.env));
      if (options.json) {
        console.log(JSON.stringify({ api: PLUGIN_API, plugins }));
        return;
      }
      const width = Math.max(...plugins.map((plugin) => plugin.name.length));
      for (const plugin of plugins) {
        const kinds = Object.entries(plugin.kinds)
          .map(([kind, version]) => `${kind} ${String(version)}`)
          .join(', ');
        const selected = plugin.selectedBy.length ? `  selected by ${plugin.selectedBy.join(', ')}` : '';
        console.log(`${plugin.name.padEnd(width)}  ${kinds || 'no stimPlugin.kinds'}${selected}`);
        if (!plugin.accepted) console.log(chalk.yellow(`  not loadable: ${plugin.reason}`));
      }
      const speaks = Object.entries(PLUGIN_API)
        .map(([kind, version]) => `${kind} ${version}`)
        .join(', ');
      console.error(chalk.dim(`This Stim speaks ${speaks}.`));
    }),
});

const test = defineOp({
  name: 'test',
  arguments: '<plugin>',
  argumentDescriptions: {
    plugin: 'a plugin directory or module path, a package installed here, or builtin:<name>',
  },
  description:
    'Run the contract kit of each kind the plugin declares, with the module loaded in a worker thread as Stim runs it',
  options: { json: { flags: '--json', description: 'print the checks as JSON' } },
  run: ({ args: [reference], options }) =>
    run(Boolean(options.json), async () => {
      const payload = await testPlugin(reference, process.cwd());
      if (!payload.passed) process.exitCode = 1;
      if (options.json) {
        console.log(JSON.stringify(payload));
        return;
      }
      for (const { kind, reason } of payload.skipped) console.error(chalk.dim(`${kind} not tested: ${reason}`));
      for (const check of payload.checks) {
        const mark = check.passed ? chalk.green('pass') : chalk.red('FAIL');
        console.log(`${mark}  ${check.kind}: ${check.name}${check.error ? ` (${check.error})` : ''}`);
      }
      const passed = payload.checks.filter((check) => check.passed).length;
      console.log(`${passed} of ${payload.checks.length} checks passed`);
    }),
});

const plugin: Op = defineOp({
  name: 'plugin',
  description: 'List plugins and test one against the plugin contract',
  commands: [list, test],
});

export default plugin;
