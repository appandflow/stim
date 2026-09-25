import { SETTINGS } from '../state/settings-registry.ts';
import { settingsJsonSchema } from '../state/settings-schema.ts';

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
