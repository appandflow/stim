import { runCacheProviderContract, type CacheContractModuleOptions, type CacheContractResult } from '@stim-cli/cache';
import {
  runAgentDriverContract,
  type AgentDriverContractOptions,
  type AgentDriverContractResult,
} from './agent-driver-kit.ts';
import { runProjectContract, type ProjectContractOptions, type ProjectContractResult } from './project-plugin.ts';
import { runTransportContract, type TransportContractOptions, type TransportContractResult } from './transport-kit.ts';

interface ContractOptions {
  'cache-provider': CacheContractModuleOptions;
  'agent-driver': AgentDriverContractOptions;
  transport: TransportContractOptions;
  project: ProjectContractOptions;
}

interface ContractResults {
  'cache-provider': CacheContractResult[];
  'agent-driver': AgentDriverContractResult[];
  transport: TransportContractResult[];
  project: ProjectContractResult[];
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
    project: runProjectContract,
  } as { [K in keyof ContractOptions]: (options: ContractOptions[K]) => Promise<ContractResults[K]> };
  return runners[kind](options);
}
