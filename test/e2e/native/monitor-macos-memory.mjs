import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

while (true) {
  const sample = { time: new Date().toISOString() };
  for (const [name, file, args] of [
    ['host', '/usr/sbin/sysctl', ['hw.memsize', 'vm.swapusage', 'vm.loadavg', 'kern.memorystatus_vm_pressure_level']],
    ['pages', '/usr/bin/vm_stat', []],
  ]) {
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    sample[name] = {
      output: result.stdout ?? '',
      error: result.error?.message ?? result.stderr ?? '',
      status: result.status,
    };
  }
  process.stdout.write(`${JSON.stringify(sample)}\n`);
  await sleep(15000);
}
