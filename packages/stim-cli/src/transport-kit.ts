import { runCacheProviderContract, type CacheContractModuleOptions, type CacheContractResult } from '@stim-cli/cache';
import { TRANSPORT_API_VERSION } from '@stim-cli/transport';
import {
  runAgentDriverContract,
  type AgentDriverContractOptions,
  type AgentDriverContractResult,
} from './agent-driver-kit.ts';
import { kitModuleHref, startKitWorker, type KitWorker } from './kit-host.ts';

export interface TransportContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface TransportContractOptions {
  /** The module as a project names it: a package name or a path, resolved from `baseDir`, or `builtin:<name>`. */
  reference: string;
  baseDir: string;
  /** Passed to `createTransport` as `options`. */
  options?: Record<string, unknown>;
  /** Passed to `createTransport` as `env`. */
  env: NodeJS.ProcessEnv;
  checkTimeoutMs?: number;
  /**
   * Checks `expose` and then `unexpose` on this port. They change which of the machine's ports are reachable, so the
   * kit calls them only when the caller passes this, for a module it knows is safe to expose from: a fixture, or a
   * transport whose `options` point it at a test environment.
   */
  expose?: { port: number };
}

const CHECK_TIMEOUT_MS = 10_000;

const UNKNOWN_PEER = { address: '192.0.2.1', headers: {} };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the check did not finish within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const EXPOSURE_STATES = new Set(['routed', 'funneled', 'missing', 'unknown']);

function checks(worker: KitWorker, expose: { port: number } | undefined): { name: string; run(): Promise<void> }[] {
  const has = (member: string) => worker.members.includes(member);
  const list: { name: string; run(): Promise<void> }[] = [];
  if (has('bindAddresses'))
    list.push({
      name: 'bindAddresses returns a list of address strings',
      run: async () => assert(isStrings(await worker.call('bindAddresses')), 'it did not return a list of strings'),
    });
  if (has('watch'))
    list.push({
      name: 'watch delivers { addresses } events and stops',
      run: async () => {
        const events: unknown[] = [];
        const stop = await worker.subscribe('watch', (event) => events.push(event));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await stop();
        assert(worker.failures.length === 0, `an event could not cross the thread boundary: ${worker.failures[0]}`);
        for (const event of events)
          assert(isRecord(event) && isStrings(event.addresses), 'an event is not { addresses: string[] }');
      },
    });
  if (has('identify'))
    list.push({
      name: 'identify answers null or an identity for a peer it does not know',
      run: async () => {
        const identity = await worker.call('identify', UNKNOWN_PEER);
        assert(
          identity === null ||
            (isRecord(identity) &&
              [identity.id, identity.name, identity.user].every((field) => typeof field === 'string')),
          'it did not return null or { id, name, user }',
        );
      },
    });
  if (has('resolve'))
    list.push({
      name: 'resolve answers an endpoint or a reason',
      run: async () => {
        const found = await worker.call('resolve', {
          name: 'stim-contract-check',
          credential: { machine: 'stim-contract-check' },
        });
        assert(
          isRecord(found) &&
            (typeof found.unresolved === 'string' ||
              [found.url, found.servername, found.host].every((field) => typeof field === 'string')),
          'it did not return { url, servername, host } or { unresolved }',
        );
      },
    });
  if (expose && has('expose'))
    list.push({
      name: 'expose answers the port and whether it is reachable, and unexpose settles',
      run: async () => {
        const exposure = await worker.call('expose', expose);
        assert(
          isRecord(exposure) && EXPOSURE_STATES.has(String(exposure.state)) && typeof exposure.port === 'number',
          'expose did not return { state, port }',
        );
        if (has('unexpose')) await worker.call('unexpose', expose);
      },
    });
  if (has('close'))
    list.push({
      name: 'close settles',
      run: async () => {
        await worker.call('close');
      },
    });
  return list;
}

/**
 * Loads a transport module in a worker thread, as it will run, and runs the host-independent checks every transport
 * must pass: the manifest's kind integer, a factory that returns an object with an `id`, and each member the module
 * has answers with data that crosses the thread boundary. A module that imports `stim` at runtime fails to load.
 * `expose` and `unexpose` run only with `options.expose`, since on a real transport they change the machine's routes.
 */
export async function runTransportContract(options: TransportContractOptions): Promise<TransportContractResult[]> {
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let worker: KitWorker | { unavailable: string };
  try {
    const module = await kitModuleHref(options.reference, options.baseDir, 'transport', TRANSPORT_API_VERSION);
    if ('unavailable' in module) return [{ name: 'the module loads', passed: false, error: module.unavailable }];
    worker = await startKitWorker({
      href: module.href,
      factory: 'createTransport',
      input: { env: { ...options.env }, options: options.options ?? {} },
      env: options.env,
      capabilities: ['bindAddresses', 'watch', 'identify', 'expose', 'unexpose', 'resolve', 'close'],
    });
  } catch (error) {
    return [{ name: 'the module loads', passed: false, error: error instanceof Error ? error.message : String(error) }];
  }
  if ('unavailable' in worker) return [{ name: 'the module loads', passed: false, error: worker.unavailable }];
  const results: TransportContractResult[] = [{ name: 'the module loads', passed: true }];
  try {
    for (const check of checks(worker, options.expose)) {
      try {
        await withDeadline(check.run(), timeoutMs);
        results.push({ name: check.name, passed: true });
      } catch (error) {
        results.push({
          name: check.name,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await worker.terminate();
  }
  return results;
}

interface ContractOptions {
  'cache-provider': CacheContractModuleOptions;
  'agent-driver': AgentDriverContractOptions;
  transport: TransportContractOptions;
}

interface ContractResults {
  'cache-provider': CacheContractResult[];
  'agent-driver': AgentDriverContractResult[];
  transport: TransportContractResult[];
}

/** Runs the kit of a plugin kind against a module: the one entry `stim plugin test` calls. */
export function runContract<Kind extends keyof ContractOptions>(
  kind: Kind,
  options: ContractOptions[Kind],
): Promise<ContractResults[Kind]> {
  const runners = {
    'cache-provider': runCacheProviderContract,
    'agent-driver': runAgentDriverContract,
    transport: runTransportContract,
  } as { [K in keyof ContractOptions]: (options: ContractOptions[K]) => Promise<ContractResults[K]> };
  return runners[kind](options);
}
