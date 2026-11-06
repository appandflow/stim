import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseItems } from './desktop-appcast.mjs';

const liveIosRuntime = 'ce3fc6322e33098aff4057ee163d51d5cef9d2d4';
const nativeLabel = 'native-build-approved';
const protocolFile = 'packages/core/protocol.ts';
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
const api = (path) => JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`]));
const sourceAt = (ref) =>
  Buffer.from(api(`contents/${protocolFile}?ref=${encodeURIComponent(ref)}`).content, 'base64').toString();
const integer = (source, name) =>
  Number(source.match(new RegExp(`export const ${name} = (\\d+)(?:;| as const)`))?.[1] ?? 0);

export function phoneApiProblem({ before, after, fingerprint, runtime, labels }) {
  if (after < before) return 'PHONE_API cannot decrease or disappear.';
  if (after === before || labels.includes(nativeLabel)) return null;
  return fingerprint && fingerprint === runtime
    ? null
    : `PHONE_API changed: iOS fingerprint ${fingerprint} differs from live runtime ${runtime}. Update liveIosRuntime in scripts/release-order.mjs after confirming External TestFlight or App Store availability, or apply ${nativeLabel}.`;
}

export function desktopApiProblem({ before, after, swift }) {
  if (after < before) return 'DESKTOP_API cannot decrease or disappear.';
  if (after === before) return null;
  return new RegExp(`\\bdesktopApi\\s*(?::\\s*Int)?\\s*=\\s*${after}\\b`).test(swift)
    ? null
    : `DESKTOP_API changed to ${after}; ship the matching desktopApi integer in Desktop Swift sources. Start the stable cut within an hour.`;
}

export function tagOrderProblem(stage, version, sha, published, runs, servedDesktop) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return 'Release order requires a stable stim version.';
  if (published !== version) return `Publish stim@${version} before ${stage}.`;
  for (const workflow of stage === 'mobile' ? ['release', 'desktop-release'] : ['release']) {
    if (
      !runs.some(
        (r) =>
          r.path === `.github/workflows/${workflow}.yml` &&
          r.head_sha === sha &&
          r.event === 'push' &&
          r.status === 'completed' &&
          r.conclusion === 'success' &&
          (workflow !== 'desktop-release' || r.head_branch === `desktop-v${servedDesktop}`) &&
          new RegExp(workflow === 'release' ? '^v\\d+\\.\\d+\\.\\d+$' : '^desktop-v\\d+\\.\\d+\\.\\d+$').test(
            r.head_branch,
          ),
      )
    ) {
      return `Complete ${workflow}.yml on ${sha} before ${stage}.`;
    }
  }
  return null;
}

function swiftSources(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? swiftSources(path) : entry.name.endsWith('.swift') ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

async function main() {
  const mode = process.argv[2];
  const source = readFileSync(protocolFile, 'utf8');
  if (mode === 'phoneApi' || mode === 'desktopApi') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event.pull_request?.base.sha ?? event.merge_group.base_sha;
    const name = mode === 'phoneApi' ? 'PHONE_API' : 'DESKTOP_API';
    const before = integer(sourceAt(base), name);
    const after = integer(source, name);
    if (before === after) return;
    let problem;
    if (mode === 'phoneApi') {
      const prs = event.pull_request
        ? [event.pull_request]
        : api(`compare/${base}...${event.merge_group.head_sha}`)
            .commits.flatMap((commit) => api(`commits/${commit.sha}/pulls`))
            .filter((pr) => pr.state === 'open');
      const labels =
        prs.length && prs.every((pr) => pr.labels.some((label) => label.name === nativeLabel)) ? [nativeLabel] : [];
      const fingerprint =
        after > before && !labels.length
          ? JSON.parse(
              run('npx', ['expo-updates', 'fingerprint:generate', '--platform', 'ios'], { cwd: 'apps/mobile' }),
            ).hash
          : '';
      problem = phoneApiProblem({ before, after, fingerprint, runtime: liveIosRuntime, labels });
    } else {
      problem = desktopApiProblem({ before, after, swift: swiftSources('apps/desktop/Sources') });
    }
    if (problem) throw new Error(problem);
    console.log(`${mode} approved. Start the stable cut within an hour of merge.`);
  } else if (mode === 'desktop-next') {
    const previous = process.env.PREVIOUS_NEXT?.match(/\.g([0-9a-f]{7,40})$/)?.[1];
    if (integer(source, 'DESKTOP_API') !== (previous ? integer(sourceAt(previous), 'DESKTOP_API') : 0)) {
      run('gh', ['workflow', 'run', 'desktop-next.yml', '--ref', 'main', '-f', 'publish=true']);
    }
  } else if (mode === 'desktop' || mode === 'mobile') {
    if (mode === 'desktop' && !/^desktop-v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME)) return;
    const version = JSON.parse(readFileSync('packages/stim-cli/package.json', 'utf8')).version;
    const runs = JSON.parse(
      run('gh', [
        'api',
        '--paginate',
        '--slurp',
        `repos/${process.env.GITHUB_REPOSITORY}/actions/runs?head_sha=${process.env.GITHUB_SHA}&event=push&per_page=100`,
      ]),
    ).flatMap((page) => page.workflow_runs);
    const problem = tagOrderProblem(
      mode,
      version,
      process.env.GITHUB_SHA,
      run('npm', ['view', `stim@${version}`, 'version']),
      runs,
      mode === 'mobile'
        ? parseItems(
            run('gh', [
              'release',
              'download',
              'desktop-latest',
              '--repo',
              process.env.GITHUB_REPOSITORY,
              '--pattern',
              'appcast.xml',
              '--output',
              '-',
            ]),
          ).find((item) => item.channel === '')?.version
        : undefined,
    );
    if (problem) throw new Error(problem);
  } else {
    throw new Error(`Unknown release check: ${mode}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
