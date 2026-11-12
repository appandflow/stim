import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macosAppLogName, macosProcess } from "../macos/state.ts";
import { inspectProcessIdentity } from "../process-identity.ts";
import {
  MACOS_APP_SINK,
  drained,
  tailMacosApp,
} from "../stimd/logs/macos-tail.ts";

const messages = (dir: string): string[] =>
  existsSync(join(dir, MACOS_APP_SINK))
    ? readFileSync(join(dir, MACOS_APP_SINK), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { msg: string }).msg)
    : [];

describe.skipIf(process.platform !== "darwin")("macOS app output tail", () => {
  let dir: string;
  const pids: number[] = [];
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "stim-macos-tail-")));
  });
  afterEach(() => {
    for (const pid of pids.splice(0))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test("a helper that left the app group and holds its output keeps the run open until it exits", async () => {
    const out = join(dir, macosAppLogName("fixture", "out"));
    writeFileSync(out, "");
    writeFileSync(join(dir, macosAppLogName("fixture", "err")), "");
    const script = `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'console.log("helper line"); setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      console.log('app line ' + helper.pid);
      setTimeout(() => process.exit(0), 200);
    `;
    const fd = openSync(out, "a");
    const app = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    await once(app, "spawn");
    const record = macosProcess(app.pid!);
    const tail = tailMacosApp(dir, record, "Fixture", "fixture");
    if (!tail) throw new Error("the tail did not start");
    try {
      await once(app, "exit");
      await vi.waitFor(() =>
        expect(messages(dir).some((msg) => msg.startsWith("app line "))).toBe(
          true,
        ),
      );
      const helper = Number(
        messages(dir)
          .find((msg) => msg.startsWith("app line "))!
          .slice("app line ".length),
      );
      pids.push(helper);
      await vi.waitFor(() => expect(messages(dir)).toContain("helper line"));
      expect(await tail.drain()).toBe(false);
      expect(tail.blocked()).toContain(
        `pid ${helper} still holds its output open`,
      );
      expect(drained(dir, record)).toBe(false);
      expect(existsSync(out)).toBe(true);
      process.kill(helper, "SIGKILL");
      await vi.waitFor(async () => expect(await tail.drain()).toBe(true), {
        timeout: 5000,
      });
      expect(drained(dir, record)).toBe(true);
      expect(existsSync(out)).toBe(false);
      expect(messages(dir).filter((msg) => msg === "helper line")).toHaveLength(
        1,
      );
      expect(messages(dir).at(-1)).toBe("Exited Fixture.");
    } finally {
      tail.close();
      if (inspectProcessIdentity(record) === "same")
        process.kill(record.pid, "SIGKILL");
    }
  }, 20_000);

  test("a tail that resumes after an interrupted append neither repeats nor skips lines", async () => {
    const out = join(dir, macosAppLogName("fixture", "out"));
    writeFileSync(out, "one\ntwo\n");
    writeFileSync(join(dir, macosAppLogName("fixture", "err")), "");
    const app = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(app, "spawn");
    pids.push(app.pid!);
    const record = macosProcess(app.pid!);
    const first = tailMacosApp(dir, record, "Fixture", "fixture");
    if (!first) throw new Error("the tail did not start");
    expect(first.ready()).toBeNull();
    first.close();
    expect(messages(dir)).toEqual(["one", "two", "Observing Fixture output."]);
    const mark = join(dir, "macos-app.tail.json");
    const committed = JSON.parse(readFileSync(mark, "utf8")) as Record<
      string,
      unknown
    >;
    const sink = join(dir, MACOS_APP_SINK);
    const sinkSize = readFileSync(sink).length;
    const ino = statSync(sink, { bigint: true }).ino.toString();
    appendFileSync(out, "three\n");
    const next = {
      ...committed,
      out: Number(committed.out) + 6,
      processToken: undefined,
    };
    writeFileSync(
      mark,
      JSON.stringify({ ...committed, pending: { ino, size: sinkSize, next } }),
    );
    appendFileSync(
      sink,
      `${JSON.stringify({ src: "client", platform: "macos", level: "info", msg: "three" })}\n`,
    );
    const landed = tailMacosApp(dir, record, "Fixture", "fixture");
    if (!landed) throw new Error("the tail did not resume");
    expect(landed.ready()).toBeNull();
    landed.close();
    expect(messages(dir)).toEqual([
      "one",
      "two",
      "Observing Fixture output.",
      "three",
    ]);
    appendFileSync(out, "four\n");
    const position = JSON.parse(readFileSync(mark, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      mark,
      JSON.stringify({
        ...position,
        pending: {
          ino,
          size: readFileSync(sink).length,
          next: {
            ...position,
            out: Number(position.out) + 5,
            processToken: undefined,
          },
        },
      }),
    );
    const notLanded = tailMacosApp(dir, record, "Fixture", "fixture");
    if (!notLanded) throw new Error("the tail did not resume");
    expect(notLanded.ready()).toBeNull();
    notLanded.close();
    expect(messages(dir)).toEqual([
      "one",
      "two",
      "Observing Fixture output.",
      "three",
      "four",
    ]);
  });
});
