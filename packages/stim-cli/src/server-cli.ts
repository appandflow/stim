export function loadServerCli(): Promise<typeof import('@stim-cli/server/cli')> {
  return import('@stim-cli/server/cli');
}
