import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) {
  throw new Error('Usage: node packaging/store/assemble.mjs <new absolute output directory>');
}

const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(await readFile(path.join(directory, 'en-US.json'), 'utf8'));
for (const [platform, fields] of Object.entries(metadata)) {
  if (!['ios', 'macos'].includes(platform)) continue;
  for (const [key, limit] of Object.entries({
    name: 30,
    subtitle: 30,
    promotionalText: 170,
    description: 4000,
  })) {
    if (fields[key] && Array.from(fields[key]).length > limit) {
      throw new Error(`${platform}.${key} exceeds ${limit} characters`);
    }
  }
  if (Buffer.byteLength(fields.keywords, 'utf8') > 100) {
    throw new Error(`${platform}.keywords exceeds 100 UTF-8 bytes`);
  }
}

for (const asset of manifest.assets) {
  const bytes = await readFile(path.join(root, asset.source));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Source changed: ${asset.source}; review the asset before updating its manifest hash`);
  }
  if (asset.source.endsWith('.png')) {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Invalid PNG signature: ${asset.source}`);
    }
    if (bytes.readUInt32BE(16) !== asset.width || bytes.readUInt32BE(20) !== asset.height) {
      throw new Error(`Wrong icon dimensions: ${asset.source}`);
    }
    if ([4, 6].includes(bytes[25])) throw new Error(`Icon has an alpha channel: ${asset.source}`);
    for (let offset = 8; offset < bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'tRNS') {
        throw new Error(`Icon has PNG transparency: ${asset.source}`);
      }
    }
  }
}

await mkdir(output);
for (const asset of manifest.assets) {
  await copyFile(path.join(root, asset.source), path.join(output, asset.output), constants.COPYFILE_EXCL);
}
for (const name of ['en-US.json', 'manifest.json', 'README.md']) {
  await writeFile(path.join(output, name), await readFile(path.join(directory, name)), { flag: 'wx' });
}
console.log(`Prepared ${output}; screenshots, privacy metadata and release approval remain pending.`);
