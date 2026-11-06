import type { Command } from 'commander';

export default function ciCommand(program: Command): void {
  program
    .command('ci')
    .description('Build and run apps in CI')
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const { main } = await import('@stim-cli/ci/cli');
      await main(process.argv.slice(3));
    });
}
