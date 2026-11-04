import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_RUN_TITLE = 'Full suite (native E2E)';

function findFullSuiteRun(runs, sha) {
  return (
    runs
      .filter(
        (run) =>
          run.name === 'Full suite' &&
          run.event === 'workflow_dispatch' &&
          run.display_title === NATIVE_RUN_TITLE &&
          run.head_sha === sha &&
          run.status === 'completed' &&
          run.conclusion === 'success',
      )
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2];
  const run = findFullSuiteRun(JSON.parse(readFileSync(0, 'utf8')).workflow_runs ?? [], sha);
  if (run) {
    console.log(`Full suite is green on ${sha}: ${run.html_url}`);
  } else {
    console.error(
      `No successful "${NATIVE_RUN_TITLE}" run for ${sha}. Dispatch it on a branch at that commit ` +
        `(gh workflow run full-suite.yml --ref <branch>), wait for it to pass, then re-run this job.`,
    );
    process.exit(1);
  }
}

export { findFullSuiteRun };
