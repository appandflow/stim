import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { assembleFixtures, type FixtureFiles, type Fixtures } from '../src/demo.ts';

const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url);
const json = <T>(name: string): T => JSON.parse(readFileSync(fixture(name), 'utf8')) as T;

/** The fixtures `src/fixtures.ts` bundles, read from disk: `frame-<key>-tapped.jpg` is a key's second screen. */
export function loadFixtures(): Fixtures {
  const frames: FixtureFiles['frames'] = {};
  for (const name of readdirSync(fixture(''))) {
    const key = /^frame-(.+)\.json$/.exec(name)?.[1];
    if (!key) continue;
    const images = [`frame-${key}.jpg`, `frame-${key}-tapped.jpg`].filter((image) => existsSync(fixture(image)));
    frames[key] = { meta: json(name), images: images.map((image) => readFileSync(fixture(image))) };
  }
  return assembleFixtures({
    status: json('status.json'),
    logs: readFileSync(fixture('logs.ndjson'), 'utf8'),
    plans: json('plans.json'),
    frames,
  });
}
