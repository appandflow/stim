import { join } from "node:path";
import {
  deviceHostArea,
  hostedMacosLogsDir,
  readHostedMacosApp,
  readHostedSessions,
  readMacosRecord,
  type MacosAppRecord,
} from "@stim-cli/core/state";
import { inspectProcessIdentity } from "../../process-identity.ts";
import { readWebRecord } from "../../web/state.ts";
import { workspaceLogsDir } from "../../workspace/paths.ts";
import { loadConfig } from "../../workspace/config.ts";
import { drained, tailMacosApp } from "./macos-tail.ts";
import { observeBrowser } from "./web.ts";

const MACOS_SCAN_MS = 2000;
const MACOS_DRAIN_MS = 5000;
const MACOS_DRAIN_POLL_MS = 250;
const WEB_RETRY_MS = 5000;

type Log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  msg: string,
) => void;

interface Stream {
  token: string;
  attached?: Promise<void>;
  ended: Promise<void>;
  close(): void | Promise<string | null>;
  failure?(): string | null;
  live?(): boolean;
  ready?(): string | null;
  drain?(): Promise<boolean>;
  blocked?(): string | null;
}

/**
 * The streams stimd keeps for what a workspace's op launched through `spawnOwned`: one DevTools observer per owned
 * Chrome and one output tail per macOS app, each found from workspace state or a hosted session and kept while that
 * process runs, so a restarted stimd picks them up again.
 */
export interface OwnedStreams {
  /**
   * Starts the streams a workspace's state names and that no stream follows yet: of `root`, or of every registered
   * workspace and hosted macOS session. For `root` it resolves once the owned Chrome's page is attached, to null, or to
   * why it could not be.
   */
  sync(root?: string): Promise<string | null>;
  running(): boolean;
  drain(root: string, macosOnly?: boolean): Promise<string | null>;
  observeWeb(root: string, pid: number, token: string): Promise<string | null>;
  observeMacos(
    root: string,
    pid: number,
    token: string,
    launchId: string,
  ): Promise<string | null>;
  observeHosted(
    session: string,
    pid: number,
    token: string,
    launchId: string,
  ): Promise<string | null>;
  drainHosted(session: string): Promise<string | null>;
  close(): Promise<string | null>;
}

async function closeStream(stream: Stream): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return (
      (await Promise.race([
        stream.close(),
        new Promise<string>((resolve) => {
          timer = setTimeout(
            () => resolve("the browser output drain timed out"),
            20_000,
          );
        }),
      ])) ?? null
    );
  } finally {
    clearTimeout(timer);
  }
}

export function createOwnedStreams(
  log: Log,
  changed: (running: boolean) => void = () => {},
): OwnedStreams {
  const streams = new Map<string, Stream>();
  const ended = new Map<string, string>();
  const retries = new Map<string, NodeJS.Timeout>();
  const draining = new Set<string>();
  const drainEpoch = new Map<string, number>();
  const running = () => streams.size > 0 || retries.size > 0;
  let closed = false;
  const keep = (key: string, stream: Stream, retry?: () => boolean) => {
    streams.set(key, stream);
    changed(true);
    void stream.ended.then(() => {
      if (streams.get(key) !== stream) return undefined;
      if (stream.failure?.()) return undefined;
      streams.delete(key);
      if (!closed && !retry?.()) ended.set(key, stream.token);
      changed(running());
      return undefined;
    });
  };
  const replaced = async (key: string, token: string): Promise<boolean> => {
    const stream = streams.get(key);
    if (stream?.token === token) return false;
    if (stream?.drain && !(await stream.drain()))
      throw new Error(
        `the previous macOS app output could not be drained: ${stream.blocked?.() ?? "its writers are not proven gone"}`,
      );
    stream?.close();
    return true;
  };
  const macos = async (
    dir: string | null,
    record: MacosAppRecord | null,
  ): Promise<void> => {
    if (closed || !dir || !record?.app) return;
    const identity = inspectProcessIdentity(record.app);
    if (identity === "unknown") return;
    if (identity !== "same" && drained(dir, record.app)) return;
    const key = `macos:${dir}`;
    if (
      streams.get(key)?.token === record.app.processToken ||
      ended.get(key) === record.app.processToken
    )
      return;
    await replaced(key, record.app.processToken);
    if (closed || streams.has(key)) return;
    const tail = tailMacosApp(
      dir,
      record.app,
      record.product,
      record.launchId,
      record.runId,
    );
    if (tail) keep(key, tail);
  };
  const observeMacos = async (
    dir: string | null,
    record: MacosAppRecord | null,
    pid: number,
    token: string,
    launchId: string,
  ): Promise<string | null> => {
    if (
      !dir ||
      !record?.app ||
      record.launchId !== launchId ||
      record.app.pid !== pid ||
      record.app.processToken !== token ||
      record.supervisor?.pid !== pid
    )
      return "the macOS app record changed";
    const identity = inspectProcessIdentity(record.app);
    if (identity === "unknown") return "the macOS app identity is unavailable";
    if (identity !== "same" && drained(dir, record.app)) return null;
    await macos(dir, record);
    const stream = streams.get(`macos:${dir}`);
    if (stream?.token !== token || !stream.ready)
      return "the macOS observer is unavailable";
    return stream.ready();
  };
  const drainMacos = async (
    dir: string | null,
    record: MacosAppRecord | null,
  ): Promise<string | null> => {
    if (!dir || !record?.app) return null;
    await macos(dir, record);
    const key = `macos:${dir}`;
    const deadline = Date.now() + MACOS_DRAIN_MS;
    for (let stream = streams.get(key); stream; stream = streams.get(key)) {
      if (stream.token !== record.app.processToken)
        return "the macOS app record changed while its output was draining";
      if (await stream.drain?.()) {
        await stream.ended;
        break;
      }
      if (Date.now() >= deadline)
        return `the macOS app output could not be drained: ${stream.blocked?.() ?? "its writers are not proven gone"}`;
      await new Promise((resolve) => setTimeout(resolve, MACOS_DRAIN_POLL_MS));
    }
    return drained(dir, record.app)
      ? null
      : "the macOS app output could not be drained";
  };
  const workspace = async (
    root: string,
    asked: boolean,
    webOnly = false,
  ): Promise<void> => {
    if (!webOnly) {
      const record = readMacosRecord(root);
      if (!record?.host) await macos(workspaceLogsDir(root), record);
    }
    const web = readWebRecord(root);
    if (
      !web?.chromeProcess ||
      inspectProcessIdentity(web.chromeProcess) !== "same"
    )
      return;
    const key = `web:${root}`;
    if (closed || draining.has(key)) return;
    const epoch = drainEpoch.get(key) ?? 0;
    const previous = streams.get(key);
    if (previous?.token === web.chromeProcess.processToken)
      return previous.attached;
    if (previous) {
      const error = await closeStream(previous);
      if (error) throw new Error(error);
      if (closed || draining.has(key) || (drainEpoch.get(key) ?? 0) !== epoch)
        return;
      const replacement = streams.get(key);
      if (replacement && replacement !== previous) {
        if (replacement.token === web.chromeProcess.processToken)
          await replacement.attached;
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
        inspectProcessIdentity(latest) !== "same"
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
  const scan = (local: boolean) => {
    if (closed) return;
    const follow = (
      what: string,
      dir: () => [string | null, MacosAppRecord | null],
    ) => {
      try {
        const [logs, record] = dir();
        void macos(logs, record).catch((error: unknown) =>
          log(
            "warn",
            "owned_macos_failed",
            `${what}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } catch (error) {
        log(
          "warn",
          "owned_macos_failed",
          `${what}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    if (local)
      try {
        for (const root of Object.keys(loadConfig()?.projects ?? {}))
          follow(root, () => {
            const record = readMacosRecord(root);
            return [record?.host ? null : workspaceLogsDir(root), record];
          });
      } catch (error) {
        log(
          "warn",
          "owned_sync_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    try {
      for (const session of readHostedSessions()) {
        if (session.platform !== "macos") continue;
        const home = join(deviceHostArea(session.id), "home");
        follow(session.id, () => [
          hostedMacosLogsDir(home),
          readHostedMacosApp(home),
        ]);
      }
    } catch (error) {
      log(
        "warn",
        "owned_hosted_scan_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const timer = setInterval(() => scan(true), MACOS_SCAN_MS);
  timer.unref();
  return {
    async sync(root) {
      if (closed) return "stimd is stopping";
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
        log(
          "warn",
          "owned_sync_failed",
          error instanceof Error ? error.message : String(error),
        );
        paths = [];
      }
      for (const path of paths) {
        try {
          void workspace(path, false).catch(() => {});
        } catch (error) {
          log(
            "warn",
            "owned_sync_failed",
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      scan(false);
      return null;
    },
    running,
    async observeWeb(root, pid, token) {
      if (closed) return "stimd is stopping";
      try {
        const record = readWebRecord(root);
        if (
          record?.chromeProcess?.pid !== pid ||
          record.chromeProcess.processToken !== token
        )
          return "the browser record changed";
        if (inspectProcessIdentity(record.chromeProcess) !== "same")
          return "the browser identity is unavailable";
        const attached = workspace(root, true, true);
        await attached;
        const latest = readWebRecord(root)?.chromeProcess;
        const stream = streams.get(`web:${root}`);
        if (
          latest?.pid !== pid ||
          latest.processToken !== token ||
          stream?.token !== token ||
          !stream.live?.()
        )
          return "the browser observer changed";
        return null;
      } catch (error) {
        return (
          (error instanceof Error ? error.message : String(error)) ||
          "the browser observer failed"
        );
      }
    },
    async observeMacos(root, pid, token, launchId) {
      if (closed) return "stimd is stopping";
      try {
        const record = readMacosRecord(root);
        if (record?.host) return "the macOS app is hosted elsewhere";
        return observeMacos(
          workspaceLogsDir(root),
          record,
          pid,
          token,
          launchId,
        );
      } catch (error) {
        return (
          (error instanceof Error ? error.message : String(error)) ||
          "the macOS observer failed"
        );
      }
    },
    async observeHosted(session, pid, token, launchId) {
      if (closed) return "stimd is stopping";
      try {
        const home = join(deviceHostArea(session), "home");
        return observeMacos(
          hostedMacosLogsDir(home),
          readHostedMacosApp(home),
          pid,
          token,
          launchId,
        );
      } catch (error) {
        return (
          (error instanceof Error ? error.message : String(error)) ||
          "the hosted observer failed"
        );
      }
    },
    async drainHosted(session) {
      if (closed) return "stimd is stopping";
      try {
        const home = join(deviceHostArea(session), "home");
        const record = readHostedMacosApp(home);
        if (!record?.app) return "the hosted macOS app record is unavailable";
        return await drainMacos(hostedMacosLogsDir(home), record);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async drain(root, macosOnly = false) {
      if (closed) return "stimd is stopping";
      const webKey = `web:${root}`;
      if (!macosOnly && draining.has(webKey))
        return "the browser output is already draining";
      if (!macosOnly) {
        draining.add(webKey);
        drainEpoch.set(webKey, (drainEpoch.get(webKey) ?? 0) + 1);
      }
      try {
        const record = readMacosRecord(root);
        if (!record?.host) {
          const failure = await drainMacos(workspaceLogsDir(root), record);
          if (failure) return failure;
        }
        const webRecord = !macosOnly ? readWebRecord(root) : null;
        const webProcess = webRecord?.chromeProcess;
        const webToken = webProcess?.processToken;
        const webStream = streams.get(webKey);
        if (webProcess && !webStream && ended.get(webKey) !== webToken)
          return "the browser output observer is unavailable";
        if (!macosOnly) {
          clearTimeout(retries.get(webKey));
          retries.delete(webKey);
        }
        if (webStream && !macosOnly) {
          if (webToken && webToken !== webStream.token)
            return "the browser record changed before its output was drained";
          const result = await closeStream(webStream);
          if (result) return result;
          const latest = readWebRecord(root)?.chromeProcess?.processToken;
          if (latest && latest !== webToken)
            return "the browser record changed while its output was draining";
          clearTimeout(retries.get(webKey));
          retries.delete(webKey);
          ended.set(webKey, webStream.token);
          streams.delete(webKey);
          changed(running());
          await webStream.ended;
        }
        if (!macosOnly) {
          const latest = readWebRecord(root)?.chromeProcess?.processToken;
          if (latest && latest !== webToken)
            return "the browser record changed while its output was draining";
          if (webToken && (webStream || ended.get(webKey) === webToken))
            ended.set(webKey, webToken);
        }
        changed(running());
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        if (!macosOnly) draining.delete(webKey);
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
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
