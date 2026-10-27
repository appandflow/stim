import { createServer, request as httpRequest } from 'node:http';
import type { HostedAgentIssuedGrant } from '@stim-cli/core/state';
import {
  AgentDriverUnavailable,
  agentRoute,
  loadAgentDriverModule,
  newAgentToken,
  type AgentDriverInput,
  type AgentDriverModule,
  type HostedAgentApp,
  type HostedAgentDriver,
} from './driver.ts';

export interface AgentDriverContractResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface AgentDriverContractOptions {
  /** Imports the driver module, for example `() => import('@stim-cli/agent-driver-x')`. */
  load: () => Promise<unknown>;
  id: string;
  /** Factory input for a host whose driving tool is not installed. */
  unavailableInput: AgentDriverInput;
  /** An app the driver would scope a grant to. */
  app: HostedAgentApp;
  /** A grant this driver issues, for the client checks. Required when the module has a client capability. */
  clientGrant?: HostedAgentIssuedGrant;
  checkTimeoutMs?: number;
}

export const AGENT_DRIVER_CONTRACT_CHECK_TIMEOUT_MS = 10_000;

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

function forwardStatus(driver: HostedAgentDriver, session: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        driver.forward(session, request, response);
      } catch (error) {
        finish(() => reject(error));
      }
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error(`forward() did not answer within ${timeoutMs}ms`))),
      timeoutMs,
    );
    let done = false;
    function finish(settle: () => void): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.closeAllConnections();
      server.close(() => settle());
    }
    server.once('error', (error) => finish(() => reject(error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const request = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: `${agentRoute(session)}rpc` },
        (response) => {
          response.resume();
          response.once('end', () => finish(() => resolve(response.statusCode ?? 0)));
        },
      );
      request.once('error', (error) => finish(() => reject(error)));
      request.end('{}');
    });
  });
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

function checks(module: AgentDriverModule, options: AgentDriverContractOptions) {
  const fresh = () => module.createAgentDriver(options.unavailableInput);
  const list: { name: string; run(): Promise<void> }[] = [
    {
      name: 'the driver carries the module id',
      run: async () => {
        assert(fresh().name === options.id, `the driver is named ${JSON.stringify(fresh().name)}`);
      },
    },
    {
      name: 'stop before start resolves',
      run: async () => {
        await fresh().stop();
      },
    },
    {
      name: 'revoking an unknown session resolves',
      run: async () => {
        await fresh().revoke(UNKNOWN_SESSION);
      },
    },
    {
      name: 'issuing before start refuses',
      run: async () => {
        await rejects(() => fresh().issue(options.app));
      },
    },
    {
      name: 'forwarding without a grant answers with an error status',
      run: async () => {
        const status = await forwardStatus(
          fresh(),
          UNKNOWN_SESSION,
          options.checkTimeoutMs ?? AGENT_DRIVER_CONTRACT_CHECK_TIMEOUT_MS,
        );
        assert(status >= 400, `the forward answered ${status}`);
      },
    },
    {
      name: 'start refuses with AgentDriverUnavailable when the tool is missing, then stops',
      run: async () => {
        const driver = fresh();
        const error = await rejects(() => driver.start());
        assert(error instanceof AgentDriverUnavailable, `start failed with ${String(error)}`);
        await driver.stop();
      },
    },
  ];
  const client = module.client;
  if (client) {
    const grant = options.clientGrant;
    const input = (granted: HostedAgentIssuedGrant) =>
      ({
        grant: granted,
        baseUrl: `https://host.example.ts.net${granted.path}`,
        file: `/tmp/stim-contract/${client.configFile}`,
        platform: options.app.udid !== undefined ? 'ios' : options.app.serial !== undefined ? 'android' : 'macos',
      }) as const;
    list.push(
      {
        name: 'client access names its file and keeps the token out of the command',
        run: async () => {
          assert(grant, 'clientGrant is required for a module with a client capability');
          const access = client.access(input(grant));
          assert(access, 'the client refused its own grant');
          assert(access.command.includes(input(grant).file), 'the command does not name the config file');
          assert(!access.command.includes(grant.token), 'the command carries the token');
        },
      },
      {
        name: 'client access refuses a grant for another driver',
        run: async () => {
          assert(grant, 'clientGrant is required for a module with a client capability');
          const other = { ...grant, driver: `${options.id}-other`, token: newAgentToken() };
          assert(client.access(input(other)) === null, 'accepted');
        },
      },
    );
  }
  return list;
}

/**
 * Loads a driver module the way stim-server does and runs the host-independent checks every driver must pass:
 * shape, idempotent stop and revoke, refusals before start and without a grant, `AgentDriverUnavailable` when
 * its tool is missing, and, with a client capability, a client file that keeps the token out of the command.
 */
export async function runAgentDriverContract(
  options: AgentDriverContractOptions,
): Promise<AgentDriverContractResult[]> {
  const loaded = await loadAgentDriverModule(options.id, options.load);
  if ('unavailable' in loaded) return [{ name: 'the module loads', passed: false, error: loaded.unavailable }];
  const results: AgentDriverContractResult[] = [{ name: 'the module loads', passed: true }];
  for (const check of checks(loaded.module, options)) {
    try {
      await withDeadline(check.run(), options.checkTimeoutMs ?? AGENT_DRIVER_CONTRACT_CHECK_TIMEOUT_MS);
      results.push({ name: check.name, passed: true });
    } catch (error) {
      results.push({ name: check.name, passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
