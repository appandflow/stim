import { main } from '../main.ts';
import type { Roots } from '../types.ts';

const roots = JSON.parse(process.env.TEST_ROOTS ?? '') as Roots;
process.exitCode = await main(process.argv.slice(2), roots);
