import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expoMetroConfigPath } from '../supervisor/metro-store.ts';

let project: string;
let adapter: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'stim-expo-config-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'adapter-test' }));

  const expo = join(project, 'node_modules', 'expo');
  mkdirSync(expo, { recursive: true });
  writeFileSync(join(expo, 'package.json'), JSON.stringify({ name: 'expo', version: '54.0.0' }));
  writeFileSync(
    join(expo, 'metro-config.js'),
    `class DefaultStore { constructor() { this._root = '/expo/default/store'; } }
     exports.getDefaultConfig = () => ({ cacheStores: [new DefaultStore()], resolver: { sourceExts: ['js'] } });\n`,
  );

  const found = expoMetroConfigPath();
  if (!found) throw new Error('the Expo Metro config adapter is missing from this checkout');
  adapter = found;
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('the Expo Metro config adapter', () => {
  test.each(['/cache/adapter-test'])(
    'observes delivery without replacing project settings (shared store: %s)',
    (storeRoot) => {
      writeFileSync(
        join(project, 'metro.config.cjs'),
        `module.exports = { cacheStores: [{ _root: '/project/store' }], server: {
      port: 8123,
      enhanceMiddleware(middleware) { return (req, res, next) => {
        res.setHeader('x-project', 'kept'); return middleware(req, res, next);
      }; }
    } };`,
      );
      const script = `
      const http = require('node:http');
      Promise.resolve(require(process.env.ADAPTER)).then(config => {
        if (!process.env.STIM_METRO_STORE && config.cacheStores[0]._root !== '/project/store') throw new Error('project cache changed');
        const middleware = config.server.enhanceMiddleware((req, res) => res.end('bundle'), {});
        const server = http.createServer((req, res) => middleware(req, res, () => {}));
        server.listen(0, '127.0.0.1', () => {
          http.get('http://127.0.0.1:' + server.address().port + '/index.bundle?platform=android', res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => {
              console.log(JSON.stringify({ body, project: res.headers['x-project'], port: config.server.port }));
              server.close();
            });
          });
        });
      });
    `;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: project,
        encoding: 'utf-8',
        env: { ...process.env, ADAPTER: adapter, STIM_PROJECT_ROOT: project, STIM_METRO_STORE: storeRoot },
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ body: 'bundle', project: 'kept', port: 8123 });
      const records = result.stderr
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line.slice('stim-bundle-response: '.length)));
      expect(records.map((record) => record.event)).toEqual(['bundle_response_started', 'bundle_response_finished']);
      expect(records[1]).toMatchObject({ platform: 'android', requestId: records[0].requestId });
    },
  );

  test.each(['ios'])('routes throwing project middleware to the HTTP error handler (%s)', (platform) => {
    writeFileSync(
      join(project, 'metro.config.cjs'),
      `module.exports = { server: { enhanceMiddleware() { return () => { throw new Error('project middleware failed'); }; } } };`,
    );
    const script = `
      const http = require('node:http');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      require('node:child_process').execFile = (file, args, options, callback) => setImmediate(() => callback(null, ''));
      Promise.resolve(require(process.env.ADAPTER)).then(config => {
        const middleware = config.server.enhanceMiddleware((req, res) => res.end('unexpected'), {});
        const server = http.createServer((req, res) => {
          const next = error => { res.statusCode = 500; res.end(error?.message ?? 'missing error'); };
          try { middleware(req, res, next); } catch (error) { next(error); }
        });
        server.listen(0, '127.0.0.1', () => {
          http.get('http://127.0.0.1:' + server.address().port + '/index.bundle?platform=' + process.env.PLATFORM, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => { console.log(JSON.stringify({ status: res.statusCode, body })); server.close(); });
          });
        });
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, ADAPTER: adapter, STIM_PROJECT_ROOT: project, PLATFORM: platform },
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 500, body: 'project middleware failed' });
  });

  test('a missing FileStore is a warning and leaves the project stores usable', () => {
    writeFileSync(
      join(project, 'metro.config.cjs'),
      `module.exports = { cacheStores: [{ _root: '/project/store' }] };\n`,
    );
    const script = `
      Promise.resolve(require(process.env.ADAPTER)).then((config) => {
        const stores = config.cacheStores({});
        console.log(JSON.stringify(stores.map((store) => store && store._root)));
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: project,
      encoding: 'utf-8',
      env: {
        ...process.env,
        ADAPTER: adapter,
        STIM_PROJECT_ROOT: project,
        STIM_METRO_STORE: '/cache/adapter-test',
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['/project/store']);
    expect(result.stderr).toContain('warning: Stim could not share');
    expect(result.stderr).not.toContain('stim-metro-store:');
  });
});
