import { request } from 'node:http';

const WARMUP_TIMEOUT_MS = 60_000;

async function requestLocal(url: URL, platform: string, prefetch: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(url, {
      headers: {
        accept: 'application/json',
        'expo-platform': platform,
        ...(prefetch ? { 'x-stim-metro-warmup': '1' } : {}),
      },
    });
    const timer = setTimeout(() => req.destroy(), WARMUP_TIMEOUT_MS);
    timer.unref();
    req.on('socket', (socket) => socket.unref());
    req.on('error', () => resolve(null));
    req.on('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (!prefetch) body += chunk;
      });
      res.on('error', () => resolve(null));
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.end();
  });
}

export async function warmMetro({
  port,
  platform,
  isExpo,
  appId,
  bundleUrl,
}: {
  port: number;
  platform: 'ios' | 'android';
  isExpo: boolean;
  appId?: string | null;
  bundleUrl?: string | null;
}): Promise<void> {
  try {
    const origin = `http://127.0.0.1:${port}`;
    const supported = await requestLocal(new URL('/_stim/metro-warmup', origin), platform, false);
    if (supported !== 'ready') return;
    // React Native entry-point and dev-menu overrides are runtime inputs; bare prefetch uses template defaults.
    const url = new URL('/index.bundle', origin);
    url.search = new URLSearchParams({
      platform,
      dev: 'true',
      lazy: 'true',
      minify: 'false',
      ...(platform === 'ios' ? { inlineSourceMap: 'false' } : {}),
      modulesOnly: 'false',
      runModule: 'true',
      excludeSource: 'true',
      sourcePaths: 'url-server',
      ...(appId ? { app: appId } : {}),
    }).toString();
    if (!bundleUrl && isExpo) {
      const body = await requestLocal(new URL(origin), platform, false);
      if (body === null) return;
      const manifest = JSON.parse(body);
      bundleUrl = manifest.launchAsset?.url ?? manifest.bundleUrl;
      if (typeof bundleUrl !== 'string') return;
    }
    if (bundleUrl) {
      const bundle = new URL(bundleUrl, origin);
      url.pathname = bundle.pathname;
      url.search = bundle.search;
    }
    await requestLocal(url, platform, true);
  } catch {}
}
