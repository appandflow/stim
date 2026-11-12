import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { recoverShareRoute, ShareRoute, type FunnelTool } from '../src/share-route.ts';

const HOST = 'mac.tail.ts.net';
const STATUS = {
  Self: {
    DNSName: `${HOST}.`,
    CapMap: { funnel: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null },
  },
};

function served(port: number, target: number) {
  return {
    TCP: { [port]: { HTTPS: true } },
    Web: { [`${HOST}:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${target}` } } } },
    AllowFunnel: { [`${HOST}:${port}`]: true },
  };
}

function tool(initial: Record<string, unknown>): FunnelTool & { config: Record<string, unknown>; removed: number[] } {
  const fake = {
    config: initial,
    removed: [] as number[],
    status: async () => STATUS,
    serveConfig: async () => fake.config,
    add: async ({ port, target }: { port: number; target: number }) => {
      const added = served(port, target);
      const merged = (field: 'TCP' | 'Web' | 'AllowFunnel') => ({
        ...(fake.config[field] as Record<string, unknown> | undefined),
        ...added[field],
      });
      fake.config = { TCP: merged('TCP'), Web: merged('Web'), AllowFunnel: merged('AllowFunnel') };
    },
    remove: async ({ port }: { port: number }) => {
      fake.removed.push(port);
      const without = (field: unknown, key: (name: string) => boolean) =>
        Object.fromEntries(Object.entries((field ?? {}) as Record<string, unknown>).filter(([name]) => !key(name)));
      fake.config = {
        TCP: without(fake.config.TCP, (name) => name === String(port)),
        Web: without(fake.config.Web, (name) => name.endsWith(`:${port}`)),
        AllowFunnel: without(fake.config.AllowFunnel, (name) => name.endsWith(`:${port}`)),
      };
    },
  };
  return fake;
}

/** A claim whose holder has exited, as a crashed stim-server leaves it. */
function crashedClaim(root: string, details: Record<string, unknown>): void {
  const script = `import { tryAcquireClaim } from '@stim-cli/core/ownership-claim';
tryAcquireClaim({ root: ${JSON.stringify(root)}, mode: 'exclusive', details: ${JSON.stringify(details)} });`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr);
}

describe('the share Funnel route claim', () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-route-'));
    root = join(home, 'share-route');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('removes the route a crashed server left and clears its claim', async () => {
    crashedClaim(root, { funnelPort: 10000, target: 51234, dnsName: HOST });
    const funnel = tool(served(10000, 51234));
    await recoverShareRoute(root, funnel);
    expect(funnel.removed).toEqual([10000]);
    expect(existsSync(root)).toBe(false);
  });

  it('leaves a route on that port that is not the recorded one, and still clears the claim', async () => {
    crashedClaim(root, { funnelPort: 10000, target: 51234, dnsName: HOST });
    const funnel = tool(served(10000, 4321));
    await recoverShareRoute(root, funnel);
    expect(funnel.removed).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('keeps the claim when the serve config cannot be read, so a later start retries', async () => {
    crashedClaim(root, { funnelPort: 10000, target: 51234, dnsName: HOST });
    const funnel = tool({});
    funnel.serveConfig = async () => {
      throw new Error('tailscale timed out');
    };
    await expect(recoverShareRoute(root, funnel)).rejects.toThrow('tailscale timed out');
    expect(readClaimSet(root).dead).toHaveLength(1);
  });

  it('opens on a free Funnel port under a claim and removes only its own route on close', async () => {
    const funnel = tool(served(443, 8788));
    const route = new ShareRoute(root, funnel);
    expect(await route.open(51234)).toEqual({ url: `https://${HOST}:8443`, port: 8443 });
    expect(readClaimSet(root).live[0]!.details).toEqual({ funnelPort: 8443, target: 51234, dnsName: HOST });
    await route.close();
    expect(funnel.removed).toEqual([8443]);
    expect(funnel.config).toEqual(served(443, 8788));
    expect(existsSync(root)).toBe(false);
  });

  it('takes only the Funnel port it is asked for, and opens nothing when that port is busy', async () => {
    const funnel = tool(served(443, 8788));
    const route = new ShareRoute(root, funnel);
    await expect(route.open(51234, 443)).rejects.toThrow(/Funnel port 443.*not free/);
    expect(funnel.config).toEqual(served(443, 8788));
    expect(await route.open(51234, 10000)).toEqual({ url: `https://${HOST}:10000`, port: 10000 });
    await route.close();
  });

  it('keeps a route it could not remove after a failed open, and removes it before the next open', async () => {
    const funnel = tool({});
    let unreadable = false;
    const read = funnel.serveConfig;
    funnel.serveConfig = async () => {
      if (unreadable) throw new Error('tailscale timed out');
      return read();
    };
    const add = funnel.add;
    funnel.add = async (route) => {
      await add(route);
      unreadable = true;
      throw new Error('funnel --bg timed out');
    };
    const route = new ShareRoute(root, funnel);
    await expect(route.open(51234)).rejects.toThrow('funnel --bg timed out');
    expect(route.stranded()).toBe(51234);

    unreadable = false;
    funnel.add = add;
    expect(await route.open(51235)).toMatchObject({ port: 443 });
    expect(funnel.removed).toEqual([443]);
    expect(route.stranded()).toBeNull();
  });

  it('keeps tracking a new stranded route when an earlier removal finishes after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const funnel = tool({});
    let unreadable = false;
    const read = funnel.serveConfig;
    funnel.serveConfig = async () => {
      if (unreadable) throw new Error('tailscale timed out');
      return read();
    };
    const add = funnel.add;
    const failingAdd = async (target: { port: number; target: number }) => {
      await add(target);
      unreadable = true;
      throw new Error('funnel --bg timed out');
    };
    funnel.add = failingAdd;
    const route = new ShareRoute(root, funnel);
    await expect(route.open(51234)).rejects.toThrow('funnel --bg timed out');
    unreadable = false;

    let release = () => {};
    const remove = funnel.remove;
    funnel.remove = async (target) => {
      await new Promise<void>((resolve) => (release = resolve));
      await remove(target);
    };
    const retry = route.removeStranded();
    const reopen = route.open(51236).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    funnel.remove = remove;
    release();
    await Promise.all([retry, reopen]);
    expect(route.stranded()).toBe(51236);
  });

  it('refuses without the Funnel capability and never touches the serve config', async () => {
    const funnel = tool({});
    funnel.status = async () => ({ Self: { DNSName: `${HOST}.`, CapMap: { https: null } } });
    funnel.add = async () => {
      throw new Error('must not add');
    };
    await expect(new ShareRoute(root, funnel).open(51234)).rejects.toThrow(/Funnel is not enabled/);
  });
});
