export function iosDevicesFromSimctl(payload) {
  return Object.entries(payload.devices ?? {}).flatMap(([runtimeIdentifier, devices]) =>
    devices.map((device) => ({ ...device, runtimeIdentifier })),
  );
}

export function matchesExpectedIosSimulator(device, expected) {
  return (
    device?.name === expected.name &&
    device?.deviceTypeIdentifier === expected.deviceTypeIdentifier &&
    device?.runtimeIdentifier === expected.runtimeIdentifier
  );
}

function withoutName(expected) {
  return { ...expected, name: undefined, namePrefix: undefined, matchAnyName: true };
}

export function selectIosCandidate(devices, { arm, baseline, parkedUdid, expectedControl }) {
  const candidates = devices.filter((device) => {
    if (!device.isAvailable) return false;
    return arm === 'stim' ? device.udid === parkedUdid : !baseline.has(device.udid);
  });
  if (candidates.length > 1) return { error: 'multiple-candidate-simulators', candidates };
  const candidate = candidates[0] ?? null;
  if (arm === 'control' && candidate && !matchesExpectedIosSimulator(candidate, expectedControl)) {
    return { error: 'control-simulator-mismatch', candidates, expected: expectedControl };
  }
  if (
    arm === 'expo-agent-cli' &&
    candidate &&
    (candidate.deviceTypeIdentifier !== expectedControl.deviceTypeIdentifier ||
      candidate.runtimeIdentifier !== expectedControl.runtimeIdentifier)
  ) {
    return { error: 'expo-agent-cli-simulator-mismatch', candidates, expected: expectedControl };
  }
  return { candidate };
}

export function androidDevicesFromAdb(output, describe) {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith('emulator-') && state === 'device')
    .map(([serial]) => Object.assign(describe(serial), { udid: serial, isAvailable: true }));
}

export function androidApplicationLabelFromBadging(output) {
  return output.match(/^application-label:'([^']*)'$/m)?.[1] ?? null;
}

export function matchesExpectedAndroidEmulator(device, expected) {
  return (
    (expected.matchAnyName ||
      (expected.namePrefix ? device?.name?.startsWith(expected.namePrefix) : device?.name === expected.name)) &&
    (!expected.deviceTypeIdentifier || device?.deviceTypeIdentifier === expected.deviceTypeIdentifier) &&
    device?.runtimeIdentifier === expected.runtimeIdentifier &&
    (!expected.systemImage || device?.systemImage === expected.systemImage)
  );
}

export function selectAndroidCandidate(
  devices,
  { arm, baseline, expectedControl, expectedStim, preexistingNames = new Set() },
) {
  const candidates = devices.filter((device) => device.isAvailable && !baseline.has(device.udid));
  if (candidates.length > 1) return { error: 'multiple-candidate-emulators', candidates };
  const candidate = candidates[0] ?? null;
  if (arm === 'expo-agent-cli' && candidate && preexistingNames.has(candidate.name)) {
    return { error: 'expo-agent-cli-adopted-preexisting-emulator', candidates };
  }
  const expected =
    arm === 'stim' ? expectedStim : arm === 'expo-agent-cli' ? withoutName(expectedControl) : expectedControl;
  if (candidate && !matchesExpectedAndroidEmulator(candidate, expected)) {
    return { error: `${arm}-emulator-mismatch`, candidates, expected };
  }
  return { candidate };
}
