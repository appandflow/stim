import { spawn, type ChildProcess } from 'node:child_process';

export type KeepAwakeReason = 'off' | 'unsupported' | 'loopback-only' | 'not-listening' | 'failed';

export interface KeepAwakeStatus {
  /** `server.keepAwake` as the server last read it. */
  setting: boolean;
  held: boolean;
  /** The `caffeinate` process that owns the assertion, while held. */
  pid?: number;
  /** Why nothing is held; absent while held. */
  reason?: KeepAwakeReason;
}

export interface KeepAwakeOptions {
  setting: () => boolean;
  /** Calls `listener` when `setting` may have changed; returns a function that removes it. */
  onChange?: (listener: () => void) => () => void;
  platform?: NodeJS.Platform;
  /** Starts the process that holds the assertion for `serverPid`. */
  spawnHolder?: (serverPid: number) => ChildProcess;
}

function keepAwakeReason(input: {
  platform: NodeJS.Platform;
  setting: boolean;
  loopbackOnly: boolean;
  remoteListening: boolean;
}): KeepAwakeReason | null {
  if (!input.setting) return 'off';
  if (input.platform !== 'darwin') return 'unsupported';
  if (input.loopbackOnly) return 'loopback-only';
  if (!input.remoteListening) return 'not-listening';
  return null;
}

/** `caffeinate -s` prevents idle system sleep on AC power; `-w` ends it when the server's process ends, however it ends. */
function spawnCaffeinate(serverPid: number): ChildProcess {
  return spawn('/usr/bin/caffeinate', ['-s', '-w', String(serverPid)], { stdio: 'ignore' });
}

export interface KeepAwake {
  /** Takes or releases the assertion to match the setting and the listeners now. */
  sync(): void;
  status(): KeepAwakeStatus;
  close(): void;
}

export function createKeepAwake(
  options: KeepAwakeOptions & { loopbackOnly: boolean; remoteListening: () => boolean },
): KeepAwake {
  const platform = options.platform ?? process.platform;
  const spawnHolder = options.spawnHolder ?? spawnCaffeinate;
  let holder: ChildProcess | null = null;
  let failed = false;
  let closed = false;
  let reported: KeepAwakeReason | 'held' | null = null;

  const blocker = (): KeepAwakeReason | null =>
    closed
      ? 'off'
      : keepAwakeReason({
          platform,
          setting: options.setting(),
          loopbackOnly: options.loopbackOnly,
          remoteListening: options.remoteListening(),
        });

  const release = () => {
    const stopped = holder;
    holder = null;
    if (!stopped) return;
    stopped.removeAllListeners();
    stopped.on('error', () => {});
    stopped.kill();
  };

  const report = () => {
    const now = blocker() ?? (failed ? 'failed' : 'held');
    const was = reported;
    if (now === was) return;
    reported = now;
    if (now === 'held')
      console.log('stim-server: keeping this machine awake on AC power while it serves other machines.');
    else if (was === 'held') console.log(`stim-server: no longer keeping this machine awake (${now}).`);
    if (now === 'unsupported')
      console.error('stim-server: server.keepAwake is on, but only macOS supports it; nothing is held.');
    if (now === 'failed')
      console.error(
        'stim-server: could not hold the keep-awake assertion; caffeinate did not start or stopped. Restart stim-server to retry.',
      );
  };

  const sync = () => {
    if (blocker() !== null) {
      failed = false;
      release();
    } else if (!holder && !failed) {
      let started: ChildProcess;
      try {
        started = spawnHolder(process.pid);
      } catch {
        failed = true;
        report();
        return;
      }
      holder = started;
      const lost = () => {
        if (holder !== started) return;
        holder = null;
        failed = true;
        report();
      };
      started.once('error', lost);
      started.once('exit', lost);
      if (started.pid === undefined) lost();
    }
    report();
  };

  const stopWatching = options.onChange?.(sync);

  return {
    sync,
    status() {
      const setting = options.setting();
      if (holder?.pid !== undefined) return { setting, held: true, pid: holder.pid };
      return { setting, held: false, reason: blocker() ?? 'failed' };
    },
    close() {
      closed = true;
      stopWatching?.();
      release();
    },
  };
}
