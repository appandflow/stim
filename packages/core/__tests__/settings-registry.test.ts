import { coerceSettingText, settingValueError, type SettingDefinition } from '../state/settings-registry.ts';

const BOOLEAN_SETTING: SettingDefinition = {
  key: 'test.enabled',
  type: { kind: 'boolean' },
  scopes: ['machine'],
  description: 'test',
  env: 'STIM_TEST_ENABLED',
};

const NUMBER_SETTING: SettingDefinition = {
  key: 'test.count',
  type: { kind: 'number', integer: true, minimum: 0 },
  scopes: ['machine'],
  description: 'test',
  env: 'STIM_TEST_COUNT',
};

test('coerceSettingText parses boolean and number text into the registry type, not a raw string', () => {
  expect(coerceSettingText(BOOLEAN_SETTING, 'true')).toBe(true);
  expect(coerceSettingText(BOOLEAN_SETTING, 'false')).toBe(false);
  expect(coerceSettingText(NUMBER_SETTING, '40')).toBe(40);
});

test('a value that coerces cleanly passes settingValueError', () => {
  expect(settingValueError(BOOLEAN_SETTING, coerceSettingText(BOOLEAN_SETTING, 'true'))).toBeNull();
  expect(settingValueError(NUMBER_SETTING, coerceSettingText(NUMBER_SETTING, '40'))).toBeNull();
});

test('text that does not decode to the registry type fails settingValueError after coercion', () => {
  expect(settingValueError(BOOLEAN_SETTING, coerceSettingText(BOOLEAN_SETTING, 'yes'))).toBe('true or false');
  expect(settingValueError(NUMBER_SETTING, coerceSettingText(NUMBER_SETTING, 'abc'))).toBe('a whole number, 0 or more');
});

test('a string-kind setting is left as text, never JSON-decoded', () => {
  const STRING_SETTING: SettingDefinition = {
    key: 'test.name',
    type: { kind: 'string' },
    scopes: ['machine'],
    description: 'test',
    env: 'STIM_TEST_NAME',
  };
  expect(coerceSettingText(STRING_SETTING, 'auto')).toBe('auto');
});
