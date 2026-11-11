import {
  AGENT_DRIVER_API_VERSION,
  AGENT_DRIVER_UNAVAILABLE,
  agentClientConfigFile,
  agentRoute,
  createAgentDriverHost,
  newAgentToken,
  type AgentDriverInput,
  type HostedAgentApp,
  type HostedAgentIssuedGrant,
} from '@stim-cli/agent-driver';
import { randomBytes } from 'node:crypto';
import { kitModuleHref, startKitWorker, type KitWorker } from './kit-host.ts';

export interface AgentDriverContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface AgentDriverContractOptions {
  /** The module as a project names it: a package name or a path, resolved from `baseDir`, or `builtin:<name>`. */
  reference: string;
  baseDir: string;
  /** The module's `id`; without it, the kit checks the driver against the module's own `id` export. */
  id?: string;
  /**
   * Factory input for a host whose driving tool is not installed; the kit supplies `host`. Its `env` is also the
   * worker's whole `process.env`, so `{}` runs the module without `PATH`.
   */
  unavailableInput: Omit<AgentDriverInput, 'host'>;
  /** An app the driver would scope a grant to. */
  app: HostedAgentApp;
  /** A grant this driver issues, for the client checks; without it, the kit makes one for `app`. */
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

function issuedGrant(id: string, app: HostedAgentApp): HostedAgentIssuedGrant {
  return {
    driver: id,
    path: agentRoute(app.session),
    token: newAgentToken(),
    scope: randomBytes(16).toString('hex'),
    lease: {
      tenant: `stim.${app.session}`,
      runId: app.session,
      clientId: 'agent',
      deviceKey: `${app.bundleId}@${app.pid ?? app.udid ?? app.serial ?? app.avdName}`,
    },
  };
}

function checks(worker: KitWorker, options: AgentDriverContractOptions): { name: string; run(): Promise<void> }[] {
  const id = options.id ?? worker.moduleId ?? '';
  const list: { name: string; run(): Promise<void> }[] = [
    {
      name: 'the driver carries the module id',
      run: async () => {
        assert(id !== '', 'the module exports no string id');
        assert(worker.id === id, `the driver is named ${JSON.stringify(worker.id)}, not ${JSON.stringify(id)}`);
      },
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
    const grant = options.clientGrant ?? issuedGrant(id, options.app);
    const input = (granted: HostedAgentIssuedGrant) => ({
      grant: granted,
      baseUrl: `https://host.example.ts.net${granted.path}`,
      file: `/tmp/stim-contract/${agentClientConfigFile(id)}`,
      platform: options.app.udid !== undefined ? 'ios' : options.app.serial !== undefined ? 'android' : 'macos',
    });
    list.push(
      {
        name: 'client access names its file and keeps the token out of the command',
        run: async () => {
          const access = await worker.callModule('client.access', input(grant));
          assert(isAccess(access), 'the client refused its own grant');
          assert(access.command.includes(input(grant).file), 'the command does not name the config file');
          assert(!access.command.includes(grant.token), 'the command carries the token');
        },
      },
      {
        name: 'client access refuses a grant for another driver',
        run: async () => {
          const other = { ...grant, driver: `${id}-other`, path: agentRoute(UNKNOWN_SESSION) };
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
    const module = await kitModuleHref(options.reference, options.baseDir, 'agent-driver', AGENT_DRIVER_API_VERSION);
    if ('unavailable' in module) return [{ name: 'the module loads', passed: false, error: module.unavailable }];
    const { dispose, ...members } = createAgentDriverHost(options.unavailableInput);
    worker = await startKitWorker({
      href: module.href,
      factory: 'createAgentDriver',
      input: options.unavailableInput,
      env: options.unavailableInput.env,
      capabilities: ['start', 'stop', 'issue', 'revoke', 'target', 'onExit'],
      moduleCapabilities: ['client.access'],
      idMember: 'name',
      host: members,
      disposeHost: dispose,
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
