import { pathToFileURL } from 'node:url';

const [baselineModule, adapterModule, project, platform] = process.argv.slice(2);
const original = await import(pathToFileURL(baselineModule).href);
const adapter = await import(pathToFileURL(adapterModule).href);
const target = { platform };
const before = await original.fingerprintProject(project, target);
const after = await adapter.fingerprintProject(project, target);
if (!before || !after || JSON.stringify(before) !== JSON.stringify(after))
  throw new Error('legacy oracle hash or sources differ from the unchanged committed implementation');
console.log(JSON.stringify({ platform, hash: before.hash, sources: before.sources.length }));
