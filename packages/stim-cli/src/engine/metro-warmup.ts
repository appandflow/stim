import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { rotatedLogPath } from '@stim-cli/core';
import { acceptsShape, settingDefinition } from '@stim-cli/core/state';
import { tailLines } from '../devices/activity.ts';

const WARMUP_TIMEOUT_MS = 60_000;

async function requestLocal(url: URL, platform: string, prefetch: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const req = request(url, {
      headers: {
        accept: 'application/json',
        'expo-platform': platform,
        'x-stim-metro-warmup': '1',
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

const ENTRY_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx'];

// Metro resolves the URL path against its server root, which is the project root or one of its ancestors.
function entryExists(bundlePath: string, root: string): boolean {
  const entry = decodeURIComponent(bundlePath.replace(/\.bundle\/*$/, ''));
  if (entry.startsWith('/.expo/')) return true;
  for (let dir = resolvePath(root); ; dir = dirname(dir)) {
    const file = resolvePath(dir, `.${entry}`);
    if (file.startsWith(dir + sep) && ENTRY_EXTENSIONS.some((ext) => existsSync(file + ext))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function recordedBundleUrl(
  logsDir: string | null | undefined,
  root: string | null | undefined,
  platform: 'ios' | 'android',
): string | null {
  const setting = settingDefinition(`metro.warmupUrl.${platform}`);
  if (!logsDir || !root || !setting) return null;
  const log = join(logsDir, 'metro.ndjson');
  for (const file of [log, rotatedLogPath(log)]) {
    for (const line of (tailLines(file) ?? []).toReversed()) {
      try {
        const record = JSON.parse(line);
        if (
          record?.event === 'bundle_response_started' &&
          record.platform === platform &&
          acceptsShape(setting, record.url) &&
          entryExists(new URL(record.url, 'http://localhost').pathname, root)
        )
          return record.url;
      } catch {}
    }
  }
  return null;
}

export async function warmMetro({
  port,
  platform,
  isExpo,
  appId,
  bundleUrl,
  logsDir,
  root,
}: {
  port: number;
  platform: 'ios' | 'android';
  isExpo: boolean;
  appId?: string | null;
  bundleUrl?: string | null;
  logsDir?: string | null;
  root?: string | null;
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
    bundleUrl ||= recordedBundleUrl(logsDir, root, platform);
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
