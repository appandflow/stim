import {
  AGENT_DRIVER_API_VERSION,
  AGENT_DRIVER_UNAVAILABLE,
  agentClientConfigFile,
  agentRoute,
  newAgentToken,
  type AgentDriverInput,
  type HostedAgentApp,
  type HostedAgentIssuedGrant,
} from '@stim-cli/agent-driver';
import { kindError, projectPlugin } from '@stim-cli/core/plugin-loader';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startKitWorker, type KitWorker } from './kit-host.ts';

export interface AgentDriverContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface AgentDriverContractOptions {
  /** The module as a project names it: a package name or a path, resolved from `baseDir`. */
  reference: string;
  baseDir: string;
  /** The module's `id`. */
  id: string;
  /** Factory input for a host whose driving tool is not installed. */
  unavailableInput: AgentDriverInput;
  /** An app the driver would scope a grant to. */
  app: HostedAgentApp;
  /** A grant this driver issues, for the client checks. Required when the module has a client capability. */
  clientGrant?: HostedAgentIssuedGrant;
  checkTimeoutMs?: number;
}

const CHECK_TIMEOUT_MS = 10_000;

const UNKNOWN_SESSION = '00000000-0000-4000-8000-000000000000';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('the call resolved');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccess(value: unknown): value is { config: string; command: string } {
  return isRecord(value) && typeof value.config === 'string' && typeof value.command === 'string';
}

function checks(worker: KitWorker, options: AgentDriverContractOptions): { name: string; run(): Promise<void> }[] {
  const list: { name: string; run(): Promise<void> }[] = [
    {
      name: 'the driver carries the module id',
      run: async () => assert(worker.id === options.id, `the driver is named ${JSON.stringify(worker.id)}`),
    },
    {
      name: 'stop before start resolves',
      run: async () => {
        await worker.call('stop');
      },
    },
    {
      name: 'revoking an unknown session resolves',
      run: async () => {
        await worker.call('revoke', UNKNOWN_SESSION);
      },
    },
    {
      name: 'issuing before start refuses',
      run: async () => {
        await rejects(() => worker.call('issue', options.app));
      },
    },
    {
      name: 'a session without a grant has no target',
      run: async () => {
        const target = await worker.call('target', UNKNOWN_SESSION);
        assert(target === null, `target() answered ${JSON.stringify(target)}`);
      },
    },
    {
      name: 'onExit delivers events and stops',
      run: async () => {
        const stop = await worker.subscribe('onExit', () => undefined);
        await stop();
      },
    },
    {
      name: `start refuses with ${AGENT_DRIVER_UNAVAILABLE} when the tool is missing, then stops`,
      run: async () => {
        const error = await rejects(() => worker.call('start'));
        assert(isRecord(error) && error.code === AGENT_DRIVER_UNAVAILABLE, `start failed with ${String(error)}`);
        await worker.call('stop');
      },
    },
  ];
  if (worker.moduleMembers.includes('client.access')) {
    const grant = options.clientGrant;
    const input = (granted: HostedAgentIssuedGrant) => ({
      grant: granted,
      baseUrl: `https://host.example.ts.net${granted.path}`,
      file: `/tmp/stim-contract/${agentClientConfigFile(options.id)}`,
      platform: options.app.udid !== undefined ? 'ios' : options.app.serial !== undefined ? 'android' : 'macos',
    });
    list.push(
      {
        name: 'client access names its file and keeps the token out of the command',
        run: async () => {
          assert(grant, 'clientGrant is required for a module with a client capability');
          const access = await worker.callModule('client.access', input(grant));
          assert(isAccess(access), 'the client refused its own grant');
          assert(access.command.includes(input(grant).file), 'the command does not name the config file');
          assert(!access.command.includes(grant.token), 'the command carries the token');
        },
      },
      {
        name: 'client access refuses a grant for another driver',
        run: async () => {
          assert(grant, 'clientGrant is required for a module with a client capability');
          const other = { ...grant, driver: `${options.id}-other`, path: agentRoute(UNKNOWN_SESSION) };
          const access = await worker.callModule('client.access', input({ ...other, token: newAgentToken() }));
          assert(access === null, 'accepted');
        },
      },
    );
  }
  return list;
}

/**
 * Loads a driver module in a worker thread, as a plugin host runs it, and runs the host-independent checks every
 * driver must pass: the manifest's kind integer, idempotent stop and revoke, refusals before start and without a
 * grant, an `onExit` that stops, `agent-driver-unavailable` when its tool is missing, and, with a client capability,
 * a client file that keeps the token out of the command. A module that imports `stim` at runtime fails to load.
 */
export async function runAgentDriverContract(
  options: AgentDriverContractOptions,
): Promise<AgentDriverContractResult[]> {
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let worker: KitWorker | { unavailable: string };
  try {
    const mismatch = await kindError(
      projectPlugin(options.reference, options.baseDir),
      options.reference,
      'agent-driver',
      AGENT_DRIVER_API_VERSION,
    );
    if (mismatch) return [{ name: 'the module loads', passed: false, error: mismatch }];
    const path = createRequire(join(options.baseDir, 'package.json')).resolve(options.reference);
    worker = await startKitWorker({
      href: pathToFileURL(path).href,
      factory: 'createAgentDriver',
      input: options.unavailableInput,
      capabilities: ['start', 'stop', 'issue', 'revoke', 'target', 'onExit'],
      moduleCapabilities: ['client.access'],
      idMember: 'name',
    });
  } catch (error) {
    return [{ name: 'the module loads', passed: false, error: error instanceof Error ? error.message : String(error) }];
  }
  if ('unavailable' in worker) return [{ name: 'the module loads', passed: false, error: worker.unavailable }];
  const results: AgentDriverContractResult[] = [{ name: 'the module loads', passed: true }];
  try {
    for (const check of checks(worker, options)) {
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
