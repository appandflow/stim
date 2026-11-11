export const BENCHMARK_MODEL_PIN = 'claude-sonnet-5-5';

export const SCENARIOS = ['launch', 'error-fix'];

const VARIANT_SCENARIOS = { javascript: 'launch', standalone: 'launch', 'launch-crash': 'error-fix' };

export function scenarioForVariant(variant) {
  const scenario = VARIANT_SCENARIOS[variant];
  if (!scenario)
    throw new Error(`variant ${variant} is outside the published matrix (scenarios: ${SCENARIOS.join(', ')})`);
  return scenario;
}

export const ARMS = [
  {
    id: 'stim',
    label: 'Stim',
    skills: [
      { name: 'agent-device', source: 'skills-root' },
      { name: 'stim', source: 'stim-package' },
    ],
    providesStim: true,
    promptInstruction: 'Use Stim and its installed skill.',
    deviceAllocation: 'adopt-parked-owned',
    auditRules: ['stim-version-provenance', 'warm-before-use', 'owned-device-adoption'],
    requiredPins: ['STIM_VERSION', 'STIM_INTEGRITY'],
    blockers: [],
  },
  {
    id: 'control',
    label: 'Control',
    skills: [{ name: 'agent-device', source: 'skills-root' }],
    providesStim: false,
    promptInstruction: "Use the project's standard tooling. Do not use Stim.",
    deviceAllocation: 'fresh-created',
    auditRules: ['no-stim-resolvable', 'no-stim-commands'],
    requiredPins: [],
    blockers: [],
  },
  {
    id: 'expo-agent-cli',
    label: 'Expo agent CLI',
    skills: [
      { name: 'agent-device', source: 'skills-root' },
      { name: 'expo', source: 'expo-skills' },
    ],
    providesStim: false,
    promptInstruction: 'Use @expo/agent-cli and the Expo skills installed for it. Do not use Stim.',
    deviceAllocation: 'tool-managed',
    auditRules: [
      'no-stim-resolvable',
      'no-eas-cloud-flags',
      'no-expo-token',
      'telemetry-disabled',
      'agent-cli-version-provenance',
    ],
    requiredPins: ['EXPO_AGENT_CLI_VERSION', 'EXPO_AGENT_CLI_INTEGRITY', 'EXPO_SKILLS_COMMIT'],
    localOnly:
      'cloud features (--eas builds, EAS Simulator sessions, deploy) are out of scope; only the local workflow is compared',
    blockers: [
      'pinned local install of @expo/agent-cli (version and integrity) with a login-shell resolution check',
      'agents:setup run at preparation into the runner home and fixture, with the installed skill bytes pinned',
      'collect and cleanup audits for devices the tool allocates (tool-managed device rule)',
    ],
  },
];

const NATIVE_CRASH = [
  'native launch-crash fixture variant (a crash in app startup that the logs surface) and its collector audit',
];

const IOS_ANDROID_EXPO = ['control', 'stim', 'expo-agent-cli'];
const WITHOUT_EXPO_CLI = ['control', 'stim'];

export const PLATFORMS = [
  {
    id: 'expo-ios',
    label: 'Expo iOS simulator',
    driver: 'readiness',
    driverPlatform: 'ios',
    scenarios: SCENARIOS,
    arms: IOS_ANDROID_EXPO,
    proof: 'agent-device Settings screenshot',
    blockers: [],
  },
  {
    id: 'expo-android',
    label: 'Expo Android emulator',
    driver: 'readiness',
    driverPlatform: 'android',
    scenarios: SCENARIOS,
    arms: IOS_ANDROID_EXPO,
    proof: 'agent-device Settings screenshot',
    blockers: [],
  },
  {
    id: 'bare-ios',
    label: 'Bare React Native iOS simulator',
    driver: 'readiness',
    scenarios: SCENARIOS,
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'the tool targets Expo projects only' },
    proof: 'agent-device Settings screenshot',
    blockers: ['bare React Native fixture with Settings screen, prebuilt iOS project and golden state'],
  },
  {
    id: 'bare-android',
    label: 'Bare React Native Android emulator',
    driver: 'readiness',
    scenarios: SCENARIOS,
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'the tool targets Expo projects only' },
    proof: 'agent-device Settings screenshot',
    blockers: ['bare React Native fixture with Settings screen, prebuilt Android project and golden state'],
  },
  {
    id: 'web',
    label: 'Web (stim web)',
    driver: 'readiness',
    scenarios: SCENARIOS,
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'smoke does not run on web and no web dev target is documented' },
    proof: 'undecided: agent-device does not drive a browser',
    blockers: ['web proof method (product decision)', 'web fixture and golden state'],
  },
  {
    id: 'macos',
    label: 'macOS (stim macos)',
    driver: 'native',
    driverPlatform: 'macos',
    scenarios: SCENARIOS,
    scenarioBlockers: { 'error-fix': NATIVE_CRASH },
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'standalone native apps are not Expo projects' },
    proof: 'agent-device native macOS screenshot and snapshot',
    blockers: [],
  },
  {
    id: 'native-ios',
    label: 'Standalone native iOS',
    driver: 'native',
    driverPlatform: 'ios',
    scenarios: SCENARIOS,
    scenarioBlockers: { 'error-fix': NATIVE_CRASH },
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'standalone native apps are not Expo projects' },
    proof: 'agent-device screenshot and snapshot',
    blockers: [],
  },
  {
    id: 'native-android',
    label: 'Standalone native Android',
    driver: 'native',
    driverPlatform: 'android',
    scenarios: SCENARIOS,
    scenarioBlockers: { 'error-fix': NATIVE_CRASH },
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'standalone native apps are not Expo projects' },
    proof: 'agent-device screenshot and snapshot',
    blockers: [],
  },
  {
    id: 'exact-ios',
    label: 'Exact iOS',
    driver: 'native',
    scenarios: SCENARIOS,
    scenarioBlockers: { 'error-fix': NATIVE_CRASH },
    arms: WITHOUT_EXPO_CLI,
    unsupportedArms: { 'expo-agent-cli': 'standalone native apps are not Expo projects' },
    proof: 'agent-device screenshot and snapshot',
    blockers: ['Exact-enabled fixture (the Exact integration is changing)', 'decide whether Exact is a platform row'],
  },
];

export function benchmarkArm(id) {
  const arm = ARMS.find((candidate) => candidate.id === id);
  if (!arm) throw new Error(`unknown benchmark arm: ${id}`);
  return arm;
}

export function isBenchmarkArm(id) {
  return ARMS.some((candidate) => candidate.id === id);
}

export function armSkillNames(id) {
  return benchmarkArm(id)
    .skills.map((skill) => skill.name)
    .toSorted();
}

function benchmarkPlatform(id) {
  const platform = PLATFORMS.find((candidate) => candidate.id === id);
  if (!platform) throw new Error(`unknown benchmark platform: ${id}`);
  return platform;
}

export function matrixPlatformForDriver(driverPlatform) {
  return `expo-${driverPlatform}`;
}

export function benchmarkCell(platformId, scenario, armId) {
  const platform = benchmarkPlatform(platformId);
  const arm = benchmarkArm(armId);
  if (!platform.scenarios.includes(scenario)) {
    return { platform: platformId, scenario, arm: armId, status: 'not-applicable', missing: [] };
  }
  if (!platform.arms.includes(armId)) {
    return {
      platform: platformId,
      scenario,
      arm: armId,
      status: 'unsupported',
      missing: [platform.unsupportedArms?.[armId] ?? 'arm does not support this platform'],
    };
  }
  const missing = [...platform.blockers, ...(platform.scenarioBlockers?.[scenario] ?? []), ...arm.blockers];
  return {
    platform: platformId,
    scenario,
    arm: armId,
    status: missing.length ? 'not-yet-runnable' : 'runnable',
    missing,
  };
}

export function benchmarkMatrix() {
  return PLATFORMS.flatMap((platform) =>
    platform.scenarios.flatMap((scenario) => ARMS.map((arm) => benchmarkCell(platform.id, scenario, arm.id))),
  ).filter((cell) => cell.status !== 'not-applicable');
}

export function assertRunnableCell(platformId, scenario, armId) {
  const cell = benchmarkCell(platformId, scenario, armId);
  if (cell.status !== 'runnable') {
    throw new Error(`benchmark cell ${platformId}/${scenario}/${armId} is ${cell.status}: ${cell.missing.join('; ')}`);
  }
  return cell;
}

export function campaignModels(pins) {
  return pins.MODELS
    ? pins.MODELS.split(',')
        .map((model) => model.trim())
        .filter(Boolean)
    : [BENCHMARK_MODEL_PIN];
}

export function assertCampaignModel(model, pins) {
  const models = campaignModels(pins);
  if (!models.includes(model)) {
    throw new Error(`model ${model} is not in this campaign's model list: ${models.join(', ')}`);
  }
  return model;
}
