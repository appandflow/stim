import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { spawn, spawnSync } = childProcess;
const starter = /(^|[\\/])(launchctl|systemd-run)$/;

childProcess.spawn = function (file, args = [], options = {}) {
  if (Array.isArray(args) && args.includes('__stimd')) {
    if (options?.detached) {
      if (new URL(import.meta.url).searchParams.has('throw-detached'))
        throw Object.assign(new Error('detached spawn denied'), { code: 'EPERM' });
      if (args.includes('--service')) {
        writeFileSync(join(process.env.STIM_HOME, 'successor-args.json'), JSON.stringify(args));
        return spawn.call(this, file, args, options);
      }
      return spawn.call(this, process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
    }
    return spawn.call(this, file, ['--import', import.meta.url, ...args], options);
  }
  return spawn.call(this, file, args, options);
};

childProcess.spawnSync = function (file, args = [], options = {}) {
  if (starter.test(String(file)) && Array.isArray(args) && (args[0] === 'bootstrap' || args.includes('__stimd')))
    return spawnSync.call(this, process.execPath, ['-e', 'process.exit(1)'], options);
  return spawnSync.call(this, file, args, options);
};

syncBuiltinESMExports();

const release = process.env.STIM_E2E_HOLD_UNTIL;
if (release) {
  const { existsSync } = await import('node:fs');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (...args) => {
      if (String(args[0]).includes('STIM_NO_PROJECT') && !existsSync(release)) {
        writeFileSync(`${release}.reached`, '');
        while (!existsSync(release)) Atomics.wait(pause, 0, 0, 50);
      }
      return write(...args);
    };
  }
}

if (new URL(import.meta.url).searchParams.has('deny-socket')) {
  const { Server } = await import('node:net');
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    if (typeof args[0] !== 'string' || !args[0].endsWith('.sock')) return listen.apply(this, args);
    const error = Object.assign(new Error(`listen EPERM: operation not permitted ${args[0]}`), { code: 'EPERM' });
    process.nextTick(() => this.emit('error', error));
    return this;
  };
}

if (new URL(import.meta.url).searchParams.has('deny-connect')) {
  const { Socket } = await import('node:net');
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const target = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof target === 'string' ? target : target?.path;
    if (typeof path !== 'string' || !path.endsWith('.sock')) return connect.apply(this, args);
    const error = Object.assign(new Error(`connect EACCES: ${path}`), { code: 'EACCES' });
    process.nextTick(() => this.emit('error', error));
    return this;
  };
}
