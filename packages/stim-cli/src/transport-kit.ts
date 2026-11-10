import {
  runAgentDriverContract,
  type AgentDriverContractOptions,
  type AgentDriverContractResult,
} from '@stim-cli/agent-driver/contract';
import { runCacheProviderContract, type CacheContractModuleOptions, type CacheContractResult } from '@stim-cli/cache';
import { kindError, projectPlugin } from '@stim-cli/core/plugin-loader';
import { TRANSPORT_API_VERSION } from '@stim-cli/transport';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startKitWorker, type KitWorker } from './kit-host.ts';

export interface TransportContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface TransportContractOptions {
  /** The module as a project names it: a package name or a path, resolved from `baseDir`. */
  reference: string;
  baseDir: string;
  /** Passed to `createTransport` as `options`. */
  options?: Record<string, unknown>;
  /** Passed to `createTransport` as `env`. */
  env: NodeJS.ProcessEnv;
  checkTimeoutMs?: number;
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

function checks(worker: KitWorker): { name: string; run(): Promise<void> }[] {
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
 */
export async function runTransportContract(options: TransportContractOptions): Promise<TransportContractResult[]> {
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let worker: KitWorker | { unavailable: string };
  try {
    const mismatch = await kindError(
      projectPlugin(options.reference, options.baseDir),
      options.reference,
      'transport',
      TRANSPORT_API_VERSION,
    );
    if (mismatch) return [{ name: 'the module loads', passed: false, error: mismatch }];
    const path = createRequire(join(options.baseDir, 'package.json')).resolve(options.reference);
    worker = await startKitWorker({
      href: pathToFileURL(path).href,
      factory: 'createTransport',
      input: { env: { ...options.env }, options: options.options ?? {} },
      capabilities: ['bindAddresses', 'watch', 'identify', 'expose', 'unexpose', 'resolve', 'close'],
    });
  } catch (error) {
    return [{ name: 'the module loads', passed: false, error: error instanceof Error ? error.message : String(error) }];
  }
  if ('unavailable' in worker) return [{ name: 'the module loads', passed: false, error: worker.unavailable }];
  const results: TransportContractResult[] = [{ name: 'the module loads', passed: true }];
  try {
    for (const check of checks(worker)) {
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
