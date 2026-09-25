import { SETTINGS, type SettingDefinition, type SettingScope } from './settings-registry.ts';

export const SETTINGS_SCHEMA_FILE = 'settings.schema.json';

export const SETTINGS_SCHEMA_URL: string = `https://unpkg.com/stim/dist/${SETTINGS_SCHEMA_FILE}`;

type JsonSchema = Record<string, unknown>;

function leafSchema(setting: SettingDefinition, scope: SettingScope): JsonSchema {
  const { type } = setting;
  const schema: JsonSchema = { description: setting.description };
  switch (type.kind) {
    case 'string':
      schema.type = 'string';
      if (type.pattern) schema.pattern = type.pattern;
      break;
    case 'path':
    case 'bundle-url':
      schema.type = 'string';
      break;
    case 'strings':
      schema.type = 'array';
      schema.items = { type: 'string' };
      break;
    case 'number':
      schema.type = type.integer ? 'integer' : 'number';
      if (type.minimum !== undefined) schema.minimum = type.minimum;
      if (type.maximum !== undefined) schema.maximum = type.maximum;
      break;
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'choice':
      schema.type = 'string';
      schema.enum = [...type.choices];
      break;
    case 'object':
      schema.type = 'object';
      break;
  }
  if (setting.sensitive && scope === 'committed') schema.pattern = '^(env|file):\\S';
  if (setting.default !== undefined) schema.default = setting.default;
  schema['x-stim'] = {
    key: setting.key,
    kind: type.kind,
    scopes: [...setting.scopes],
    ...(type.kind === 'path' && type.absolute ? { absolute: true } : {}),
    ...(type.kind === 'path' && type.relative ? { relative: true } : {}),
    ...(setting.env ? { env: setting.env } : {}),
    ...(setting.sensitive ? { sensitive: true } : {}),
    ...(setting.committedAt ? { committedAt: setting.committedAt } : {}),
  };
  return schema;
}

function objectSchema(settings: readonly SettingDefinition[], scope: SettingScope, closed: boolean): JsonSchema {
  const root: JsonSchema = { type: 'object', properties: {}, additionalProperties: !closed };
  for (const setting of settings) {
    const parts = setting.key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const properties = node.properties as Record<string, JsonSchema>;
      properties[part] ??= { type: 'object', properties: {}, additionalProperties: false };
      node = properties[part];
    }
    (node.properties as Record<string, JsonSchema>)[parts.at(-1)!] = leafSchema(setting, scope);
  }
  return root;
}

/**
 * The published settings schema. The root describes a committed `.stim.json`;
 * `$defs.machine` describes the settings keys of `$STIM_HOME/config.json`.
 * Every leaf carries `x-stim` with its dotted key, kind, writable scopes,
 * environment override, and sensitivity.
 */
export function settingsJsonSchema(): JsonSchema {
  const committed = objectSchema(
    SETTINGS.filter((setting) => setting.scopes.includes('committed')),
    'committed',
    true,
  );
  (committed.properties as Record<string, JsonSchema>).$schema = { type: 'string' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SETTINGS_SCHEMA_URL,
    title: 'Stim settings',
    description:
      'Settings in a committed .stim.json. $defs.machine lists the machine settings in $STIM_HOME/config.json.',
    ...committed,
    $defs: {
      machine: objectSchema(
        SETTINGS.filter((setting) => setting.scopes.includes('machine')),
        'machine',
        false,
      ),
    },
  };
}
