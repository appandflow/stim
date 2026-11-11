import data from '../../website/src/data/benchmark-matrix.json' with { type: 'json' };

export const BENCHMARK_MODEL_PIN = 'claude-sonnet-5-5';

const SCENARIOS = data.scenarios;

const VARIANT_SCENARIOS = { javascript: 'launch', standalone: 'launch', 'launch-crash': 'error-fix' };

export function scenarioForVariant(variant) {
  const scenario = VARIANT_SCENARIOS[variant];
  if (!scenario)
    throw new Error(`variant ${variant} is outside the published matrix (scenarios: ${SCENARIOS.join(', ')})`);
  return scenario;
}

export const ARMS = data.arms;

const PLATFORMS = data.platforms;

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
