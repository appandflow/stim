import { availableParallelism, loadavg } from 'node:os';

export function maxWorkersFor({ cores, load1 }) {
  const available = Math.max(1, cores - 1);
  const ceiling = Math.min(available, Math.ceil(cores / 2));
  return Math.min(ceiling, Math.max(2, available - Math.round(load1)));
}

export function localMaxWorkers(env = process.env) {
  if (env.CI || env.VITEST_MAX_WORKERS) return undefined;
  return maxWorkersFor({ cores: availableParallelism(), load1: loadavg()[0] });
}
