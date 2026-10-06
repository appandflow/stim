import { SETTINGS } from '../state/settings-registry.ts';
import { settingsJsonSchema } from '../state/settings-schema.ts';
import Ajv from 'ajv/dist/2020.js';

test('the editor schema accepts the tailnet-only Metro mode and refuses an unknown provider', () => {
  const validate = new Ajv({ strict: false }).compile(settingsJsonSchema());
  expect(validate({ metro: { tunnel: 'tailscale' } })).toBe(true);
  expect(validate({ metro: { tunnel: 'funnel' } })).toBe(false);
});

test('the published schema covers every setting once, at the scope files it may live in', () => {
  const schema = settingsJsonSchema();
  const keys: Record<string, string[]> = {};
  const walk = (node: Record<string, unknown>, where: string) => {
    for (const child of Object.values((node.properties ?? {}) as Record<string, Record<string, unknown>>)) {
      const stim = child['x-stim'] as { key: string } | undefined;
      if (stim) (keys[stim.key] ??= []).push(where);
      else walk(child, where);
    }
  };
  walk(schema, 'committed');
  walk((schema.$defs as Record<string, Record<string, unknown>>).machine!, 'machine');

  expect(Object.keys(keys).toSorted()).toEqual(SETTINGS.map((setting) => setting.key).toSorted());
  expect(keys).toEqual(
    Object.fromEntries(
      SETTINGS.map((setting) => [
        setting.key,
        (['committed', 'machine'] as const).filter((scope) => setting.scopes.includes(scope)),
      ]),
    ),
  );
});

test('iOS hosting targets accept tailnet names and ports without widening Android remote values', () => {
  const validate = new Ajv({ strict: false }).compile(settingsJsonSchema());
  for (const remote of ['eas', 'proxy', 'auto', 'mini', 'mini.tail.ts.net:7443'])
    expect(validate({ ios: { remote } })).toBe(true);
  for (const remote of ['bad name', 'mini:0', 'mini:65536', true]) expect(validate({ ios: { remote } })).toBe(false);
  for (const remote of ['auto', 'mini']) expect(validate({ android: { remote } })).toBe(false);
});
