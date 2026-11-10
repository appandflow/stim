import type { StimContext } from '@stim-cli/core';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PEER } from '@stim-cli/core/protocol';
import { isJsonObject, readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import { FatalHostError, Upstream } from '@stim-cli/server/hosted-relay';
import { engineRoot } from '../engine-store/store.ts';
import { getExecutor } from '../exec.ts';
import { resolveEndpoint, type TailnetMachineIo } from '../offload/tailnet.ts';
import { pickUpdateVersion, type Packument } from '../offload/update-version.ts';

async function packument(ctx: StimContext): Promise<Packument> {
  const output = await getExecutor().runFileAsync(
    'npm',
    [
      'view',
      'stim',
      'versions',
      'dist-tags',
      '--json',
      '--registry=https://registry.npmjs.org/',
      '--cache',
      join(engineRoot(ctx.env), '.npm-cache'),
      '--prefer-online',
    ],
    { timeoutMs: 60_000, cwd: ctx.cwd, signal: ctx.signal },
  );
  const record: unknown = JSON.parse(output);
  const result: Packument = { 'dist-tags': {}, versions: {} };
  if (!isJsonObject(record)) return result;
  if (Array.isArray(record.versions))
    for (const version of record.versions) if (typeof version === 'string') result.versions[version] = {};
  if (isJsonObject(record['dist-tags'])) result['dist-tags'] = record['dist-tags'];
  return result;
}

export async function updateRemoteMachine(
  ctx: StimContext,
  machine: string,
  callerVersion: string,
  channel: 'latest' | 'next' | undefined,
  io: TailnetMachineIo,
): Promise<string> {
  const build = readBuildMachines().find((entry) => entry.machine === machine && entry.state === 'approved');
  const host = build
    ? null
    : readDeviceHostMachines().find((entry) => entry.machine === machine && entry.state === 'approved');
  const credential = build ?? host;
  if (!credential?.serverKey) throw new Error(`${machine} has not approved this machine for builds or device hosting.`);
  const serverKey = credential.serverKey;
  const target = await resolveEndpoint(credential, io.status);
  if (typeof target === 'string') throw new Error(target);
  const connect = async () => {
    const connection = new Upstream(target, serverKey);
    try {
      await connection.open(callerVersion, build ? 'build' : 'device-host');
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  };
  let connection: Upstream | null = await connect();
  try {
    const selected = channel ?? connection.channel;
    const version = pickUpdateVersion(await packument(ctx), selected, PEER);
    if (!version)
      throw new Error(
        selected === 'next'
          ? `${machine} follows next; nothing carries peer ${PEER}; build locally`
          : `${machine} follows ${selected}; peer ${PEER} exists only on next; run stim remote update ${machine} --channel next, or build locally`,
      );
    const started = await connection.request('engine.update', { version });
    if ('error' in started) throw new Error(started.error.message);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      ctx.signal.throwIfAborted();
      let status;
      try {
        connection ??= await connect();
        status = await connection.request('engine.update.status', {});
      } catch (error) {
        if (error instanceof FatalHostError) throw error;
        connection?.close();
        connection = null;
        await delay(250, undefined, { signal: ctx.signal });
        continue;
      }
      if ('error' in status) throw new Error(status.error.message);
      if (!isJsonObject(status.result)) throw new Error(`${machine} returned no update status.`);
      const { running, last } = status.result;
      if (
        !running &&
        isJsonObject(last) &&
        typeof last.message === 'string' &&
        last.message !== 'The update is running.'
      ) {
        if (!last.ok) throw new Error(last.message);
        return `${machine}: stim ${version}. ${last.message}`;
      }
      await delay(250, undefined, { signal: ctx.signal });
    }
    throw new Error(`${machine} has not reported the result of updating to ${version}.`);
  } finally {
    connection?.close();
  }
}
