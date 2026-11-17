import { main } from './main.ts';
import { productionRoots } from './roots.ts';

try {
  process.exitCode = await main(process.argv.slice(2), productionRoots());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
