import { swiftpmArtifactQuery } from '../swiftpm-artifact.ts';

const query = {
  project: 'apps/desktop',
  sourceDigest: 'a'.repeat(64),
  stimBuild: 'b1',
  inputs: { complete: true, ignored: [], outputs: [], localFiles: [], environment: ['FLAVOR'] },
  build: { product: 'App', infoPlist: 'Info.plist', resources: { Assets: 'assets' }, assetCatalog: null },
};

test('equivalent declarations normalize to the same completed artifact request without dropping build choices', () => {
  expect(swiftpmArtifactQuery({ ...query, inputs: { ...query.inputs, environment: ['FLAVOR', 'FLAVOR'] } })).toEqual(
    query,
  );
  expect(swiftpmArtifactQuery({ ...query, build: { ...query.build, product: 'Other' } })).not.toEqual(query);
  const resources = Object.fromEntries([['__proto__', 'assets']]);
  expect(swiftpmArtifactQuery({ ...query, build: { ...query.build, resources } })?.build.resources).toEqual(resources);
});

test('malformed and escaping queries cannot reach a worker private-input check', () => {
  for (const invalid of [
    { ...query, project: '../outside' },
    { ...query, sourceDigest: 'claimed-fingerprint' },
    { ...query, inputs: { ...query.inputs, complete: false } },
    { ...query, inputs: { ...query.inputs, environment: ['FLAVOR=value'] } },
    { ...query, inputs: { ...query.inputs, ignored: ['.git/config'] } },
    { ...query, inputs: { ...query.inputs, localFiles: ['private\0file'] } },
    { ...query, inputs: { ...query.inputs, secret: 'must-not-forward' } },
    { ...query, build: { ...query.build, infoPlist: '/outside' } },
    { ...query, build: { ...query.build, resources: { '../outside': 'assets' } } },
    { ...query, build: { ...query.build, assetCatalog: '../../outside' } },
  ])
    expect(swiftpmArtifactQuery(invalid)).toBeNull();
});

test('a query with a build compatibility version carries it instead of the Stim build', () => {
  const { stimBuild: _, ...rest } = query;
  expect(swiftpmArtifactQuery({ ...query, compat: 1 })).toEqual({ ...rest, compat: 1 });
  expect(swiftpmArtifactQuery({ ...query, compat: 0 })).toBeNull();
});
