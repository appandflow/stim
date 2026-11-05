export const ANDROID_BENCHMARK_AVD_CONFIG = Object.freeze({
  'disk.dataPartition.size': String(8 * 1024 ** 3),
  'hw.device.name': 'pixel_6',
  'hw.keyboard': 'yes',
});

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
    record.configuration !== JSON.stringify(Object.entries(ANDROID_BENCHMARK_AVD_CONFIG)) ||
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

function refuseCleanup() {
  throw new Error(
    'benchmark cleanup cannot preserve the expected golden device; retain worktrees and inspect Stim state',
  );
}

export function assertGoldenCleanup({ config, platform, expectedIdentity }) {
  if (!['ios', 'android'].includes(platform) || typeof expectedIdentity !== 'string' || !expectedIdentity)
    refuseCleanup();
  if (!config?.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) refuseCleanup();
  let matches = 0;
  const inspect = (candidatePlatform, record, parked) => {
    const identity = parked ? record?.udid : candidatePlatform === 'ios' ? record?.deviceUdid : record?.avdName;
    if (
      candidatePlatform !== platform ||
      identity !== expectedIdentity ||
      (!parked && record?.owned !== true) ||
      (parked && record?.deletionClaim !== undefined) ||
      (parked && platform === 'android' && record?.name !== expectedIdentity)
    )
      refuseCleanup();
    matches += 1;
  };
  for (const project of Object.values(config.projects)) {
    if (!project || typeof project !== 'object') refuseCleanup();
    for (const records of [project.platforms ?? {}, ...Object.values(project.deviceSlots ?? {})]) {
      if (!records || typeof records !== 'object' || Array.isArray(records)) refuseCleanup();
      for (const [candidatePlatform, record] of Object.entries(records)) inspect(candidatePlatform, record, false);
    }
  }
  for (const [candidatePlatform, records] of Object.entries(config.parked ?? {})) {
    if (!Array.isArray(records)) refuseCleanup();
    for (const record of records) inspect(candidatePlatform, record, true);
  }
  if (matches !== 1) refuseCleanup();
}
