import { coerceSettingText, settingValueError, SETTINGS, type SettingDefinition } from '../state/settings-registry.ts';

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

test('offload.machine validates placement text and rejects empty or non-string settings', () => {
  const setting = SETTINGS.find((entry) => entry.key === 'offload.machine')!;
  for (const value of ['auto', 'local', 'mini', 'mini.tail.ts.net:8443'])
    expect(settingValueError(setting, value)).toBeNull();
  for (const value of ['', ' ', 'bad name', 'mini:abc', 'mini:0', 'mini:65536', 12, false])
    expect(settingValueError(setting, value)).not.toBeNull();
});

test.each([
  ['archive.enabled', true, 'STIM_ARCHIVE_ENABLED', false],
  ['archive.maxAgeDays', 30, 'STIM_ARCHIVE_MAX_AGE_DAYS', undefined],
  ['archive.maxCount', 200, 'STIM_ARCHIVE_MAX_COUNT', undefined],
  ['archive.maxTotalGb', 5, 'STIM_ARCHIVE_MAX_TOTAL_GB', undefined],
  ['archive.logs.maxAgeDays', 14, 'STIM_ARCHIVE_LOGS_MAX_AGE_DAYS', undefined],
  ['archive.logs.maxMbPerWorkspace', 100, 'STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE', undefined],
  ['archive.recordings.maxAgeDays', 3, 'STIM_ARCHIVE_RECORDINGS_MAX_AGE_DAYS', undefined],
  ['archive.recordings.maxTotalGb', 2, 'STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB', undefined],
  ['archive.agentActions.maxAgeDays', 7, 'STIM_ARCHIVE_AGENT_ACTIONS_MAX_AGE_DAYS', undefined],
])('%s rejects wrong types and accepts disabling retention', (key, value, env, scoped) => {
  const setting = SETTINGS.find((entry) => entry.key === key)!;
  expect(setting).toMatchObject({ default: value, env });
  expect(setting.scopedHomeValue).toBe(scoped);
  expect(setting.scopes).toEqual(
    key === 'archive.enabled' ? ['machine', 'workspace', 'repo', 'committed'] : ['machine'],
  );
  expect(settingValueError(setting, value)).toBeNull();
  expect(settingValueError(setting, key === 'archive.enabled' ? false : 0)).toBeNull();
  expect(settingValueError(setting, key === 'archive.enabled' ? 1 : -1)).not.toBeNull();
  expect(settingValueError(setting, String(value))).not.toBeNull();
});

test.each([
  'archive.maxAgeDays',
  'archive.maxCount',
  'archive.logs.maxAgeDays',
  'archive.recordings.maxAgeDays',
  'archive.agentActions.maxAgeDays',
])('%s rejects fractional ages or counts', (key) => {
  expect(
    settingValueError(
      SETTINGS.find((entry) => entry.key === key)!,
      1.5,
    ),
  ).not.toBeNull();
});
