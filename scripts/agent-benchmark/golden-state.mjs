export function matchesGoldenPreparation(actual, expected) {
  return (
    actual !== null &&
    typeof actual === 'object' &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

export function preparedAndroidEmulator({ config, avds, activeNames, systemImage, expectedName }) {
  const records = config?.parked?.android;
  if (config?.pool?.androidParkedMax !== 1 || !Array.isArray(records) || records.length !== 1) {
    throw new Error('golden must contain exactly one parked Android emulator with max 1');
  }
  const record = records[0];
  if (
    typeof record?.name !== 'string' ||
    !/^stim-[A-Za-z0-9._-]+$/.test(record.name) ||
    record.udid !== record.name ||
    typeof record.parkedAt !== 'string' ||
    record.configuration !== JSON.stringify([['disk.dataPartition.size', String(8 * 1024 ** 3)]]) ||
    record.deletionClaim !== undefined ||
    (expectedName && record.name !== expectedName)
  ) {
    throw new Error('parked Android emulator identity or creation configuration is invalid');
  }
  const avd = avds.find(({ name }) => name === record.name);
  if (!avd || record.systemImage !== systemImage || avd.systemImage !== systemImage) {
    throw new Error('parked Android emulator is missing or has the wrong system image');
  }
  const configuration = JSON.parse(record.configuration);
  if (
    !Array.isArray(configuration) ||
    configuration.length === 0 ||
    !configuration.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === 'string') &&
        avd.config?.[entry[0]] === entry[1],
    )
  ) {
    throw new Error('parked Android emulator creation settings no longer match its pool record');
  }
  if (activeNames.includes(record.name)) throw new Error('parked Android emulator is still running');
  return { ...record, deviceTypeIdentifier: avd.deviceTypeIdentifier, runtimeIdentifier: avd.runtimeIdentifier };
}
