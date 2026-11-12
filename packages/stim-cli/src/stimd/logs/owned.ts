import { inspectProcessIdentity } from '../../process-identity.ts';
import { readWebRecord } from '../../web/state.ts';
import { loadConfig } from '../../workspace/config.ts';
import { observeBrowser } from './web.ts';

const WEB_RETRY_MS = 5000;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;

interface Stream {
  token: string;
  attached?: Promise<void>;
  ended: Promise<void>;
  close(): void | Promise<string | null>;
  failure?(): string | null;
  live?(): boolean;
}

/**
 * The streams stimd keeps for what a workspace's op launched through `spawnOwned`: one DevTools observer per owned
 * Chrome, found from workspace state and kept while that process runs, so a restarted stimd picks it up again.
 */
export interface OwnedStreams {
  /**
   * Starts the streams a workspace's state names and that no stream follows yet: of `root`, or of every registered
   * workspace. For `root` it resolves once the owned Chrome's page is attached, to null, or to why it could not be.
   */
  sync(root?: string): Promise<string | null>;
  running(): boolean;
  drain(root: string): Promise<string | null>;
  observeWeb(root: string, pid: number, token: string): Promise<string | null>;
  close(): Promise<string | null>;
}

// compat C27 until #5558
/** Whether a live supervisor an older Stim started still owns the process `pid`, and observes it itself. */
function legacy(owner: { pid: number; processToken: string } | undefined, pid: number): boolean {
  return owner !== undefined && owner.pid !== pid && inspectProcessIdentity(owner) === 'same';
}
// compat end

async function closeStream(stream: Stream): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return (
      (await Promise.race([
        stream.close(),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('the browser output drain timed out'), 20_000);
        }),
      ])) ?? null
    );
  } finally {
    clearTimeout(timer);
  }
}

export function createOwnedStreams(log: Log, changed: (running: boolean) => void = () => {}): OwnedStreams {
  const streams = new Map<string, Stream>();
  const ended = new Map<string, string>();
  const retries = new Map<string, NodeJS.Timeout>();
  const failures = new Map<string, string>();
  const draining = new Set<string>();
  const drainEpoch = new Map<string, number>();
  const running = () => streams.size > 0 || retries.size > 0;
  let closed = false;
  const keep = (key: string, stream: Stream, retry?: () => boolean) => {
    streams.set(key, stream);
    // @ref LLP 0019#owned-web-streams-and-the-worker -- a failed writer is reported once, then dropped
    failures.delete(key);
    changed(true);
    void stream.ended.then(() => {
      if (streams.get(key) !== stream) return undefined;
      const failure = stream.failure?.();
      streams.delete(key);
      if (failure) {
        log('error', 'web_observer_failed', `${key.slice('web:'.length)}: ${failure}`);
        failures.set(key, failure);
        ended.set(key, stream.token);
      } else if (!closed && !retry?.()) ended.set(key, stream.token);
      changed(running());
      return undefined;
    });
  };
  const workspace = async (root: string, asked: boolean): Promise<void> => {
    const web = readWebRecord(root);
    if (!web?.chromeProcess || inspectProcessIdentity(web.chromeProcess) !== 'same') return;
    // compat C27 until #5558
    if (legacy(web, web.chromeProcess.pid)) return;
    // compat end
    const key = `web:${root}`;
    if (closed || draining.has(key)) return;
    const epoch = drainEpoch.get(key) ?? 0;
    const previous = streams.get(key);
    if (previous?.token === web.chromeProcess.processToken) return previous.attached;
    if (previous) {
      const error = await closeStream(previous);
      if (error) throw new Error(error);
      if (closed || draining.has(key) || (drainEpoch.get(key) ?? 0) !== epoch) return;
      const replacement = streams.get(key);
      if (replacement && replacement !== previous) {
        if (replacement.token === web.chromeProcess.processToken) await replacement.attached;
        return;
      }
      streams.delete(key);
    }
    if (!asked && ended.get(key) === web.chromeProcess.processToken) return;
    if (!asked && retries.has(key)) return;
    clearTimeout(retries.get(key));
    retries.delete(key);
    const stream = observeBrowser(root, web, web.chromeProcess);
    keep(key, { token: web.chromeProcess.processToken, ...stream }, () => {
      const latest = readWebRecord(root)?.chromeProcess;
      if (
        !latest ||
        latest.processToken !== web.chromeProcess?.processToken ||
        inspectProcessIdentity(latest) !== 'same'
      )
        return false;
      clearTimeout(retries.get(key));
      const timer = setTimeout(() => {
        retries.delete(key);
        if (!closed) void workspace(root, false).catch(() => {});
        changed(running());
      }, WEB_RETRY_MS);
      timer.unref();
      retries.set(key, timer);
      return true;
    });
    return stream.attached;
  };
  return {
    async sync(root) {
      if (closed) return 'stimd is stopping';
      if (root !== undefined) {
        try {
          await workspace(root, true);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
      let paths: string[];
      try {
        paths = Object.keys(loadConfig()?.projects ?? {});
      } catch (error) {
        log('warn', 'owned_sync_failed', error instanceof Error ? error.message : String(error));
        paths = [];
      }
      for (const path of paths) {
        try {
          void workspace(path, false).catch(() => {});
        } catch (error) {
          log('warn', 'owned_sync_failed', `${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return null;
    },
    running,
    async observeWeb(root, pid, token) {
      if (closed) return 'stimd is stopping';
      try {
        const record = readWebRecord(root);
        if (record?.chromeProcess?.pid !== pid || record.chromeProcess.processToken !== token)
          return 'the browser record changed';
        if (inspectProcessIdentity(record.chromeProcess) !== 'same') return 'the browser identity is unavailable';
        // compat C27 until #5558
        if (legacy(record, pid)) return null;
        // compat end
        const attached = workspace(root, true);
        await attached;
        const latest = readWebRecord(root)?.chromeProcess;
        const stream = streams.get(`web:${root}`);
        if (latest?.pid !== pid || latest.processToken !== token || stream?.token !== token || !stream.live?.())
          return 'the browser observer changed';
        return null;
      } catch (error) {
        return (error instanceof Error ? error.message : String(error)) || 'the browser observer failed';
      }
    },
    async drain(root) {
      if (closed) return 'stimd is stopping';
      const webKey = `web:${root}`;
      if (draining.has(webKey)) return 'the browser output is already draining';
      const failed = failures.get(webKey);
      if (failed) {
        failures.delete(webKey);
        return failed;
      }
      draining.add(webKey);
      drainEpoch.set(webKey, (drainEpoch.get(webKey) ?? 0) + 1);
      try {
        const webRecord = readWebRecord(root);
        const webProcess = webRecord?.chromeProcess;
        const webToken = webProcess?.processToken;
        const webStream = streams.get(webKey);
        if (webProcess && !webStream && ended.get(webKey) !== webToken && !legacy(webRecord, webProcess.pid))
          return 'the browser output observer is unavailable';
        clearTimeout(retries.get(webKey));
        retries.delete(webKey);
        if (webStream) {
          if (webToken && webToken !== webStream.token)
            return 'the browser record changed before its output was drained';
          const result = await closeStream(webStream);
          if (result) {
            failures.delete(webKey);
            if (streams.get(webKey) === webStream) streams.delete(webKey);
            ended.set(webKey, webStream.token);
            changed(running());
            return result;
          }
          const latest = readWebRecord(root)?.chromeProcess?.processToken;
          if (latest && latest !== webToken) return 'the browser record changed while its output was draining';
          clearTimeout(retries.get(webKey));
          retries.delete(webKey);
          ended.set(webKey, webStream.token);
          streams.delete(webKey);
          changed(running());
          await webStream.ended;
        }
        const latest = readWebRecord(root)?.chromeProcess?.processToken;
        if (latest && latest !== webToken) return 'the browser record changed while its output was draining';
        if (webToken && (webStream || ended.get(webKey) === webToken)) ended.set(webKey, webToken);
        changed(running());
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        draining.delete(webKey);
      }
    },
    async close() {
      closed = true;
      for (const retry of retries.values()) clearTimeout(retry);
      retries.clear();
      const results = await Promise.all([...streams.values()].map(closeStream));
      const failure = results.find((result) => result !== null);
      if (failure) return failure;
      streams.clear();
      return null;
    },
  };
}
