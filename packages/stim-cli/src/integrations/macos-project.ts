import type { StimContext } from '@stim-cli/core';
import type { NdjsonWriter } from '../ndjson.ts';
import type { chooseBuildMachine, offloadBuild } from '../offload/client.ts';
import type { SettingsObject } from '../workspace/settings.ts';
import type { MacosArtifactCache } from '../macos/artifact-cache.ts';

export interface MacosArtifactRecipe {
  product: string;
  arguments: string[];
  bundleId: string;
  cache?: MacosArtifactCache;
  compile(context: {
    scratch: string;
    temporary: string;
    writer: NdjsonWriter;
    note: (line: string) => void;
  }): Promise<string>;
  stage(bin: string, bundle: string, bundleId: string, displayName?: string): Promise<void>;
  validateFetched(bundle: string, bundleId: string, displayName?: string): Promise<void>;
  offload: {
    target(
      runsOnWorker?: boolean,
    ): Parameters<typeof chooseBuildMachine>[0]['target'] | Promise<Parameters<typeof chooseBuildMachine>[0]['target']>;
    request(bundleId: string): Extract<Parameters<typeof offloadBuild>[0]['request'], { platform: 'macos' }>;
  };
}

export interface MacosProject {
  prepare(context: StimContext, settings: SettingsObject): Promise<MacosArtifactRecipe>;
}
