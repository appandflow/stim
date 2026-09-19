import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = ['smoke', 'loop', 'caches', 'pool'];
const ALL = ['loop', 'caches', 'pool'];
const PLATFORMS = {
  ios: ['smoke', 'loop', 'caches', 'pool'],
  android: ['smoke', 'loop', 'caches'],
  windows: ['smoke', 'loop'],
};

function requested({ eventName, labels, suite }) {
  switch (eventName) {
    case 'push':
      return ['smoke'];
    case 'schedule':
      return ['loop'];
    case 'workflow_dispatch':
      if (suite === 'all') return ALL;
      if (!SUITES.includes(suite)) throw new Error(`unknown suite input: ${JSON.stringify(suite)}`);
      return [suite];
    case 'pull_request': {
      const wanted = new Set();
      for (const label of labels) {
        if (label === 'e2e-all') for (const s of ALL) wanted.add(s);
        else if (label.startsWith('e2e-') && SUITES.includes(label.slice(4))) wanted.add(label.slice(4));
      }
      return SUITES.filter((s) => wanted.has(s));
    }
    default:
      throw new Error(`unsupported event: ${JSON.stringify(eventName)}`);
  }
}

export function planSuites(input) {
  const suites = requested(input);
  return Object.fromEntries(
    Object.entries(PLATFORMS).map(([platform, supported]) => [platform, suites.filter((s) => supported.includes(s))]),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = planSuites({
    eventName: process.env.GITHUB_EVENT_NAME,
    labels: JSON.parse(process.env.E2E_PR_LABELS || 'null') ?? [],
    suite: process.env.E2E_SUITE,
  });
  for (const [platform, suites] of Object.entries(plan)) console.log(`${platform}=${JSON.stringify(suites)}`);
}
