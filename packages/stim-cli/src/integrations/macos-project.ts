import type { NdjsonWriter } from '../ndjson.ts';
import type { chooseBuildMachine, offloadBuild } from '../offload/client.ts';
import type { SettingsObject } from '../workspace/settings.ts';

export interface MacosArtifactRecipe {
  product: string;
  arguments: string[];
  bundleId: string;
  compile(context: { scratch: string; writer: NdjsonWriter; note: (line: string) => void }): Promise<string>;
  stage(bin: string, bundle: string, bundleId: string, displayName?: string): void;
  validateFetched(bundle: string, bundleId: string, displayName?: string): void;
  offload: {
    target(): Parameters<typeof chooseBuildMachine>[0]['target'];
    request(bundleId: string): Extract<Parameters<typeof offloadBuild>[0]['request'], { platform: 'macos' }>;
  };
}

export interface MacosProject {
  prepare(settings: SettingsObject): MacosArtifactRecipe;
}
