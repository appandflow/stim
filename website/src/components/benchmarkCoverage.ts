import matrix from '../data/benchmark-matrix.json';

export type CoverageStatus = 'planned' | 'not-applicable';

export type CoveragePlatform = {
  id: string;
  label: string;
  tasks: string[];
  arms: Record<string, CoverageStatus>;
};

const coverageTaskLabels: Record<string, string> = {
  launch: 'App launch',
  'native-change': 'Native change',
  'error-fix': 'Error fix',
};

export const coverageArms = matrix.arms.map(({ id, label }) => ({ id, label }));

export const coveragePlatforms: CoveragePlatform[] = matrix.platforms.map((platform) => ({
  id: platform.id,
  label: platform.label,
  tasks: platform.scenarios.map((scenario) => coverageTaskLabels[scenario] ?? scenario),
  arms: Object.fromEntries(
    matrix.arms.map((arm) => [arm.id, platform.arms.includes(arm.id) ? 'planned' : 'not-applicable']),
  ),
}));

export const coverageStatusLabels: Record<CoverageStatus, string> = {
  planned: 'Planned',
  'not-applicable': 'Not supported by the tool',
};
