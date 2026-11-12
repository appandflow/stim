# Release process

How to cut a new version of `stim` to npm and GitHub. Keep this in sync with
what we actually do — when something changes, update both this file and the
real workflow at the same time.

Stim Desktop has its own tags and workflow; see
[apps/desktop/RELEASING.md](./apps/desktop/RELEASING.md).
The phone app ships with its own workflow, which also rolls back a bad update;
see [Each release](./apps/mobile/README.md#each-release) and
[Roll back a bad update](./apps/mobile/README.md#roll-back-a-bad-update).

## 0. The published packages

```text
packages/stim-cli  stim                CLI, server, CI and public APIs
packages/cache-s3  @stim-cli/cache-s3  optional S3-compatible cache provider
```

Both published packages carry the same version. The other workspace packages
are private and keep their own builds for repository consumers.

Run every command from the repo root unless a step says otherwise. Each
package ships its own README in its own tarball; the root README is a landing
page and is not copied anywhere.

## 1. Decide the version

The source of truth for "what was last released" is the npm registry, not
local git tags — a publish can fail after the tag is pushed, leaving the tag
ahead of what's actually on npm. Post-stable, the highest published version
can sit on either the `latest` or the `next` dist-tag, so check both and take
the semver-higher one, ignoring the `-next.` builds of the
[prerelease channel](#prerelease-channel), which have no git tag. Pull it and list commits since the matching tag:

```bash
git fetch --tags
if last=$(npm view stim dist-tags --json 2>/dev/null | node -e '
  const { latest, next } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const parse = (v) => {
    const [core, pre] = v.split("-");
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : null };
  };
  const compare = (l, r) => {
    const a = parse(l), b = parse(r);
    for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
    if (!a.pre && !b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
      const x = a.pre[i], y = b.pre[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x === y) continue;
      return /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x < y ? -1 : 1;
    }
    return 0;
  };
  const versions = [latest, next].filter((v) => v && !v.includes("-next."));
  if (!versions.length) process.exit(1);
  process.stdout.write(versions.reduce((hi, v) => (compare(v, hi) > 0 ? v : hi)));
'); then
  echo "Last published: v$last"
  git log "v$last..HEAD" --oneline
else
  echo "No published stim version"
  git log --oneline
fi
```

An npm `E404` means a first release for that package name: complete the
first-publication bootstrap in
[docs/release-recovery.md](./docs/release-recovery.md) before pushing the tag.
Every package name must already exist on npm, because trusted publishing can
only be configured for an existing package:

```bash
for p in stim @stim-cli/cache-s3; do
  npm view "$p" name >/dev/null || echo "$p: first publication required"
done
```

Use `X.Y.Z-rc.N` for a release candidate. The workflow computes the publish
dist-tag itself from the tag and the registry: it reads `npm view stim version`
-- the package installs start from -- as its stable-or-not signal, and a candidate
publishes to `next` instead of `latest` only when that signal is already a
stable version, so a plain `npm install` never regresses to a candidate.
Every other publish -- a stable version, or a candidate published while no
stable release exists yet, including a first-ever publish (`E404`) -- lands
on `latest`, which is what installs resolve. Since its first stable release,
`stim`'s `latest` has been stable. A run that dies before publishing `stim`
leaves the previous stable version as the signal, so a candidate still goes
to `next` and never replaces a stable `latest`. The gate assumes a
partial release is always completed or recovered (see
[docs/release-recovery.md](./docs/release-recovery.md)) before the next tag
lands; the workflow does not check that on its own. A tag higher than the
published version
means a release never landed: see
[docs/release-recovery.md](./docs/release-recovery.md) before bumping.

Look at every commit in the list and decide:

- **Patch** (`0.2.0 -> 0.2.1`) — bug fixes, doc-only changes, internal refactors with no user-visible effect.
- **Minor** (`0.2.0 -> 0.3.0`) — new commands, new flags, additions to existing commands, and breaking changes that follow [Compatibility and breaking changes](#compatibility-and-breaking-changes).
- **Major** (`1.x -> 2.0`) — only a change to a frozen surface (rule 6 of that section).

If anything in the list is breaking, call it out under "Removed (breaking)" /
"Migration notes" in the draft release notes.

Before pre-flight, write `docs/releases/X.Y.Z.md`. This is the evidence index
for candidate verification. Use the sections `New`,
`Removed (breaking)`, `Fixes`, `Docs`, and `Migration notes`, omitting empty
sections. Link prior commits with
`[<short-sha>](https://github.com/appandflow/stim/commit/<sha>)`, and say
which package a line concerns when it is not the CLI. The version commit later
includes this already-reviewed file.

## 2. Prepare and verify the exact candidate

Start from `main`, fully up to date with `origin/main`. Before candidate
preparation, `git status --short` may show only the draft
`docs/releases/X.Y.Z.md`.

1. **Bump the version in lockstep.** All published `package.json` files carry the
   same number, and `dist/cli.mjs` reads it from its own `package.json`:

   ```bash
   pnpm run release:prep X.Y.Z
   ```

   The script refuses a malformed version, one that does not come after the
   version the packages already carry, and a tree whose versions already
   disagree. It rewrites the `version` fields together, refreshes the
   lockfile, regenerates `apps/mobile/src/generated/licenses.json` (it embeds
   the workspace versions, and CI runs `licenses:check` on it), then re-reads
   the published manifests to confirm all packages landed on the new version and that the
   lockfile still matches them, and leaves the candidate uncommitted and
   untagged. If any of that fails it puts the manifests and the licenses file
   back as they were, so a failed run is never half-bumped. The licenses step
   runs `expo export`, so a fresh checkout needs `pnpm install --frozen-lockfile`
   and a workspace build first.

   Workspace links stay at `workspace:*` during a bump, including Stim's
   development dependencies, except peer dependencies, which stay at
   `workspace:^` so `@stim-cli/cache-s3` accepts any later `stim` of the same
   major. Stim bundles the `@stim-cli/*` code and ships no
   runtime dependency on those packages. pnpm substitutes remaining workspace
   ranges when packing; no `workspace:` range may reach a published tarball
   (verified in step 3).
   `pnpm run release:prep --check` audits that shape -- package versions in
   lockstep, every internal range exactly `workspace:*` and every peer range
   exactly `workspace:^` -- without changing
   anything.

   Confirm the published packages moved:

   ```bash
   grep -H '"version"' packages/{stim-cli,cache-s3}/package.json
   ```

2. **Install and run the pre-flight against those exact files.** Run only
   what CI does not. The version PR and the merge queue run format, lint,
   typecheck, knip, the RPC check and the full unit suite, and the push to
   `main` runs the same suite on Node 22 and 24, the cross-platform e2e and
   the published-runtime check on the exact release commit (section 4 step 4).
   Repeating them on the release machine only adds minutes.

   The native compatibility stage requires the tools and connected iPhone listed
   in [docs/testing.md](./docs/testing.md), including `STIM_AGENT_DEVICE_SOURCE` for
   the agent-device source checkout. Record unavailable prerequisites
   explicitly; a unit-only pass does not satisfy that stage.

   ```bash
   pnpm install --frozen-lockfile
   pnpm run release:prep --check
   pnpm run build
   pnpm run test:compat
   node packages/stim-cli/dist/cli.mjs --help
   node packages/stim-cli/dist/cli.mjs guide agent
   test "$(node packages/stim-cli/dist/cli.mjs --version)" = "X.Y.Z"
   ```

   When CI or the merge queue is unavailable, run `pnpm run format:check`,
   `pnpm run lint`, `pnpm run typecheck`, `pnpm run knip`, `pnpm test`,
   `pnpm run test:e2e` and `pnpm run test:runtime` here as well, and record that
   in the release report.

3. **Verify each npm tarball** ships only what should ship, that each one
   carries its own README, and that Stim has no `@stim-cli/*` runtime
   dependencies. Any remaining inter-package dependencies name the exact
   release version, with no `^` or `~`, except peer dependencies, which name
   `^` and the release version. Pack with `pnpm`, never `npm`: the release workflow publishes
   pnpm-packed tarballs, and `npm pack` prints the unsubstituted `workspace:`
   ranges rather than what actually publishes.

   ```bash
   out=$(mktemp -d)
   for p in stim-cli cache-s3; do
     tgz=$(cd "packages/$p" && pnpm pack --pack-destination "$out" | tail -1)
     echo "== $p ($(tar -tzf "$tgz" | wc -l | tr -d ' ') files)"
     tar -tzf "$tgz" | grep -E 'README|LICENSE'
     tar -xzOf "$tgz" package/package.json | grep -E '"version"|"@stim-cli/|"stim":'
   done
   rm -rf "$out"
   ```

   Keep the `files` whitelists tight (`dist`, `shim`, `skill`, `LICENSE`,
   `README.md` for the CLI; `dist`, `README.md`, `LICENSE` for the other
   packages). The `stim` bin lives under `bin/` and loads its bundled
   JavaScript from `dist/`. A
   `workspace:` range in that output means the tarball was not packed by pnpm;
   stop and fix the packing before publishing.

4. **Inspect the candidate diff.** `git status --short` should contain only the
   published package manifests and the draft release notes. `pnpm-lock.yaml` no
   longer moves with a version bump -- it records the internal edges as
   `workspace:` specifiers and `link:` targets, neither of which carries a
   version. Resolve anything else before QA.

## 4. Cut the release

1. **Freeze the evidence and notes.** Check each release-note claim against
   candidate verification. Correct the notes and rerun affected checks before
   continuing.
2. **Open the version commit as a pull request** with a
   `chore: X.Y.Z — <one-line summary>` title and let the merge queue land it.
   The body can be terse; the GitHub release notes carry the real changelog.
   The queue's `Merge gate` run builds and tests the merge-group commit
   (format, lint, build, typecheck, knip, the RPC check and the full unit
   suite), and that commit is the one that lands on `main`.
3. **Record the exact release commit** once the queue has merged the pull
   request. It is the version commit, not the tip of `main`: a pull request
   queued behind it may already have landed.

   ```bash
   release_commit=$(gh pr view <version-pr> --json mergeCommit --jq .mergeCommit.oid)
   ```

   When a pull request landed between the freeze and the version commit and
   the notes do not name it, add it with a notes pull request. The notes commit
   becomes the release commit, and steps 3 and 4 repeat for it.

4. **Wait for the release gate on that exact commit.** The gate is the
   `Merge gate` run of the merge queue plus three jobs of the `CI` run that the
   push to `main` started: `test (node 22)`, `test (node 24)` and
   `published runtime (node 22.12.0)`. Every other job of that run, and every
   other workflow the push started, is not part of the gate (section 5
   says what to do with them).

   The commit match is checked by SHA. The merge-queue run and the push run
   both carry `head_sha == $release_commit`, so the check below proves the
   jobs ran on the commit about to be tagged. It exits non-zero when the merge
   gate is missing or red, when no push run exists, or when a gate job is not
   green:

   ```bash
   release_commit=<release-commit-sha> ci_event=push ci_branch=main
   repo=appandflow/stim
   (
     gh api "repos/$repo/actions/runs?head_sha=$release_commit&event=merge_group&per_page=100" |
       jq -e -r --arg sha "$release_commit" '
         [.workflow_runs[] | select(.name == "Merge gate" and .head_sha == $sha)]
         | sort_by(.created_at) | last
         | select(.conclusion == "success")
         | "merge gate ok: run \(.id) on \(.head_branch)"' || { echo "merge gate not green"; exit 1; }

     run_id=$(gh api "repos/$repo/actions/runs?head_sha=$release_commit&event=$ci_event&per_page=100" |
       jq -e -r --arg sha "$release_commit" --arg branch "$ci_branch" '
         [.workflow_runs[] | select(.name == "CI" and .head_branch == $branch and .head_sha == $sha)]
         | sort_by(.created_at) | last | .id') || { echo "no CI run for the commit"; exit 1; }
     echo "CI run $run_id"

     for _ in $(seq 120); do
       run_status=$(gh api "repos/$repo/actions/runs/$run_id" --jq .status) || exit 1
       gate=$(gh api "repos/$repo/actions/runs/$run_id/jobs?per_page=100" | jq -c '
         [.jobs[] | select(.name | IN("test (node 22)", "test (node 24)", "published runtime (node 22.12.0)"))
          | {name, status, conclusion}]') || exit 1
       echo "$gate"
       [ "$run_status" = completed ] && break
       jq -e 'length == 3 and all(.status == "completed")' <<<"$gate" >/dev/null && break
       sleep 30
     done
     jq -e 'length == 3 and all(.conclusion == "success")' <<<"$gate" >/dev/null || { echo "release gate NOT green"; exit 1; }
     echo "release gate: green"
   )
   ```

   Do not wait for the rest of the `CI` run. For 1.34.0 the merge gate took 7
   minutes and the slowest gate job finished 9 minutes after the push.

   The push run is cancelled when another pull request lands on `main` before
   it finishes (its concurrency group is the branch), and it may be missing
   when the push did not start `CI`. Then run the same jobs on a throwaway
   branch at the same commit, and repeat the check with the dispatched run
   once it appears in `gh run list --workflow ci.yml --branch release-ci/X.Y.Z`.
   `-f full=false` keeps the dispatched run to the Linux jobs; a stable release
   starts the `Full suite` below on the same branch anyway.

   ```bash
   git push origin <release-commit-sha>:refs/heads/release-ci/X.Y.Z
   gh workflow run ci.yml --ref release-ci/X.Y.Z -f full=false
   ```

   Run the check again with the first line changed to set `ci_event` to
   `workflow_dispatch` and `ci_branch` to `release-ci/X.Y.Z`.

   **A stable version also needs a green `Full suite` on that commit.** Pull
   requests and `main` run only Linux jobs, so the macOS, Windows, Desktop and
   native E2E smoke jobs run here instead. Push the release commit to
   `release-ci/X.Y.Z` as above, dispatch the suite with the native E2E smoke
   (the default), and wait for it. The first run took 66 minutes, 30 of them the
   Desktop job and the rest the macOS runner queue; Windows Android smoke was 14 minutes:

   ```bash
   gh workflow run full-suite.yml --ref release-ci/X.Y.Z
   gh run list --workflow full-suite.yml --branch release-ci/X.Y.Z --limit 1 --json databaseId,status,conclusion,url
   gh run watch <databaseId> --exit-status
   ```

   The `Release` and `Desktop release` workflows check for that run before they
   publish a stable version: `scripts/full-suite-gate.mjs` accepts only a
   successful run named `Full suite (native E2E)` whose head is the tagged
   commit. A tag pushed without it fails in the first job, before anything is
   published; run the suite on a branch at that commit and re-run the failed
   job. A prerelease (`-rc.N`) needs no `Full suite` run, and neither does the
   candidate release gate, which stays the Linux jobs above. The `next`
   channels (npm and Desktop) never wait for it. A flaky job in the suite is a
   failure to read, not to re-run blindly: the same rule as section 5.

   A fix creates a new commit and repeats steps 2 to 4. Never tag a commit
   that has not passed this gate. Delete `release-ci/X.Y.Z` once the tag is
   pushed.

5. **Tag and push the proven commit:**

   ```bash
   git fetch origin
   git tag -a vX.Y.Z -m "vX.Y.Z" <release-commit-sha>
   git push origin vX.Y.Z
   ```

   One tag for the repo, not one per package: the packages share a version, so
   a per-package tag would only repeat the same thing.

   The Release workflow refuses to run unless the tagged commit is an ancestor
   of `origin/main`, so the release commit must already be on `main` (step 3).

6. **Publish the already-reviewed release notes in
   `docs/releases/X.Y.Z.md`.** This committed file is the single source of
   truth: the website's changelog page is GENERATED from it at site build
   (`website/scripts/gen-changelog.mjs`, triggered by the Docs deploy on any
   push touching `docs/releases/`), and the GitHub release is created from the
   same file:
   ```bash
   tail -n +2 docs/releases/X.Y.Z.md > /tmp/notes.md
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md
   ```
   Add `--prerelease` when `X.Y.Z` contains a prerelease suffix.
   Do not add claims here. Once the tag is remote, a correction requires a new
   version; never move or force-push the published tag.
7. **Publish to npm.** Pushing the tag in step 5 triggers the
   `Release` workflow, which publishes all the packages via OIDC trusted
   publishing (no token, `--provenance`) in the `release` environment. That
   environment has no required reviewers for now, so the run publishes
   without an approval step. Find the run with:

   ```bash
   gh run list --workflow Release --limit 1 --json databaseId,url,status
   ```

   The workflow packs the package tarballs with pnpm, checks
   that every packed `stim` and `@stim-cli/*` dependency is exactly the tag
   version (no `workspace:`, `^` or `~`) and every such peer dependency is `^`
   and the tag version, skips an exact package version
   that already exists, computes the dist-tag (section 1) and publishes every
   package to it. Its `smoke` job then waits, up to 15 minutes per check, for
   the registry to serve each version, its tarball and the dist-tag, and runs
   `npx stim@X.Y.Z --version`, `npx stim@X.Y.Z ci --version`
   and `npx stim@X.Y.Z serve --version` in a scratch
   directory.

   The `Release` run holds only `tag-on-main`, `publish` and `smoke`, so it
   ends when `smoke` does: in 1.29.0 to 1.33.0 `publish` took under 2 minutes
   and `smoke` 6 to 8.

   A NEW package, a failed publish, or
   a provenance rejection: see
   [docs/release-recovery.md](./docs/release-recovery.md).

8. **Smoke-test the published versions** from a scratch directory. npm can
   take several minutes to serve a new version, and until then `npx` fails
   with E404. When the `smoke` job fails after a green `publish` job, read
   the failing check before acting: a version, tarball or E404 that is still
   missing means wait and re-run the failed job (or these commands), never
   republish ([docs/release-recovery.md](./docs/release-recovery.md)).
   ```bash
   version=X.Y.Z
   cd /tmp && npx "stim@$version" --version
   cd /tmp && npx "stim@$version" guide agent >/dev/null
   npm pack "stim@$version" --dry-run 2>&1 | grep ' README.md$'
   cd /tmp && npx --yes "stim@$version" ci --version
   cd /tmp && npx --yes "stim@$version" serve --version
   ```
   Keep the `cd /tmp`. Inside this repository, `npx "stim@$version"` with the
   workspace's own `stim` version does not download the release: npm treats
   the workspace package as installed and runs whichever `stim` is first on
   `PATH`, so the check can pass or fail against a different build. The same
   applies to every subcommand. The `smoke` job runs from a scratch directory for this
   reason.
   The `npm pack` line lists the published tarball's README. Do not check
   `npm view "stim@$version" readme`: it prints the registry's package-level
   README, which is empty whenever the newest publish is not on `latest`, such
   as a release candidate on `next`. A tarball without `README.md` means the
   package directory lacks one
   ([docs/release-recovery.md](./docs/release-recovery.md)).

## 5. After the release

- Triage the nightly failures. None of them blocks the release or is a
  reason to unpublish: a published version stays, and a real defect ships in
  the next version. The `Full suite`, `Native E2E` and `Stim CI dogfood`
  nightlies file an issue titled `Nightly failure: <workflow>` when they fail
  (`gh issue list --label "source: nightly"`). A failure that shows the
  published packages are broken on that platform is `priority: P0`: follow
  [docs/release-recovery.md](./docs/release-recovery.md). Do not hold the
  release report, the Desktop release or the machine updates for them.

- When retiring workspace packages, deprecate their published names by hand
  after the stable release is visible on npm. OIDC publishing cannot deprecate;
  this needs an npm owner login and 2FA. Set `version` to the stable cut:

  ```bash
  version=X.Y.0
  for name in core cache ci server transport transport-tailscale transport-local agent-driver agent-driver-agent-device; do
    npm deprecate "@stim-cli/$name@*" "moved into stim $version; see https://github.com/appandflow/stim/blob/main/docs/releases/$version.md"
  done
  npm deprecate '@stim-cli/metro@*' "no longer published; remove sharedCacheStores from metro.config.js, Stim's injected config sets cacheStores when Stim starts Metro"
  npm deprecate '@stim-cli/expo-build-cache@*' "deprecated in stim $version; run builds through stim ios or stim android and remove expo.buildCacheProvider from the app config"
  for name in core cache ci server transport transport-tailscale transport-local agent-driver agent-driver-agent-device metro expo-build-cache; do
    npm view "@stim-cli/$name" deprecated
  done
  ```

- When a release changes the phone or Desktop API integer, publish npm first,
  then the matching Desktop release, then the production phone update. Update
  workers with `npm i -g stim@<version> && stim service install`. Prepare the
  stable cut within an hour of merging the API change; run the Full suite on
  the exact candidate commit before tagging it.

- Leave every `package.json` at the just-released version. The next release
  bumps them as part of its own section 2, step 1; we don't carry a `-dev`
  suffix between releases.
- Cut the Stim Desktop release for this version now, at the release commit
  that `vX.Y.Z` points to, so the bundled CLI and server equal the published
  packages. See [apps/desktop/RELEASING.md](./apps/desktop/RELEASING.md).
  Tag it without waiting for a `Desktop next` run: the two workflows build in
  parallel and take turns only to publish the appcast.

## Compatibility and breaking changes

1. **A compatibility path needs a named population that cannot update.** The
   default is to delete the old behaviour. A kept path names who runs the old
   side, why they cannot update before they meet the new side, how many they
   are, and when the path ends. "Someone might run an old copy" is not a
   population. Each kept path is a row of `scripts/compat-budget.json`, and its
   lines sit between `// compat C<N> permanent` (or `until <version>`) and
   `// compat end`; `node scripts/compat-budget.mjs --report` counts them per
   row, and `pnpm run lint` fails a row over its budget.
2. **Same build by construction beats a check.** Two Stim processes that talk
   on one machine run the same build. An older process is ended or restarted,
   never bridged, except through a budget row whose end is a release, which
   is deleted in that release.
3. **Every surface between different builds carries one integer that changes
   only on a removal, a rename or a change of meaning.** A request the other
   side does not know answers `unknown-method` (or `unknown-field`), and the
   caller tells the person to update the older side, as
   `apps/mobile/src/lib/connection.ts` does for a stim-server without
   `workspaces.subscribe`. Sides on the same integer never refuse each other.
4. **A breaking change lands in a minor, with a refusal and a remedy.** The
   release bumps the surface's integer, ships a refusal that names the side to
   update and the command that updates it, and lists the break under
   `## Removed (breaking)` in its release notes. Clients too old to know the
   integer get `protocol-unsupported`. A patch never breaks anything (1.17.1
   did). Only a frozen surface (rule 6) needs a major.
5. **A changed meaning gets a new name.** The old name refuses and names the
   new one for 30 days; an unchanged meaning keeps its name. 1.36.0 changed
   `stim ci run` in place, which this rule forbids.
6. **Frozen surfaces change only in a major.** The phone's native framing is
   frozen: its first byte is the protocol version and anything else gets
   `protocol-unsupported`, because installed phone binaries change only
   through App Store review. A surface joins this list only by passing rule 1.
7. **Release order is part of the design.** Native phone code reaches the
   stores before a Stim release requires it, `next` publishes no production
   phone JavaScript, and whoever merges a bump of an integer the phone or Stim
   Desktop reads starts the stable cut within the hour, so the production
   phone update or the matching Stim Desktop follows.

## Prerelease channel

Every push to `main` also starts the `Release` workflow's `next-publish` job,
which publishes the head of `main` to the `next` dist-tag. Testers install it
with:

```bash
npm install --global stim@next
```

- **Version.** `X.(Y+1).0-next.<UTC commit time>.g<short sha>`, where `X.Y` is
  the version the packages carry on `main`, so `1.39.0` on `main` publishes
  `1.40.0-next.20261103040825.g751e1f0`. It sorts above every published
  release and below the next minor, and a plain `npm install stim` or a `^`
  range never selects it. Both published packages use that version. When the
  next stable release is a major, `.github/next-version` names it (`2.0.0`)
  and the channel publishes `2.0.0-next.<UTC commit time>.g<short sha>`
  instead; the workflow refuses a file that is not `X.Y.0` or is below the
  minor bump. Delete the file in the candidate version commit of that release.
- **Throttle.** The job waits until `NEXT_THROTTLE_MINUTES` (5) after the
  current `next` was published, then publishes whatever is the head of `main`
  at that moment. GitHub keeps one run active and one pending, so under
  constant merges a commit reaches `next` within about the throttle plus one
  publish. A head already published is skipped. An hourly schedule is a
  safety net, and Actions -> Release -> Run workflow on `main` publishes
  without waiting.
- **Gate.** The job publishes a head that passed the merge queue's
  `merge gate`, or, for a push that bypassed the queue, the CI jobs
  `test (node 22)`, `test (node 24)` and `published runtime (node 22.12.0)`.
  It runs no tests of its own. Those CI jobs are still running when the push
  starts the job, so a bypassing push usually waits for the hourly schedule
  or a dispatch.
- **Guards.** The job runs only on `main` of this repository, refuses a
  version without the `-next.` suffix and publishes only with `--tag next`.
  It never touches `latest`, so the stable dist-tag logic in section 1 is
  unaffected.
- **Release candidates.** A candidate also publishes to `next`. While the
  packages on `main` carry a prerelease version (from the candidate's version
  commit until the stable one), the job publishes nothing, so `next` stays on
  the candidate and its `smoke` check of `dist-tags.next` is not raced. A
  channel run that resolved `main` before the candidate's version commit can
  still be publishing then; let it finish before pushing the candidate's tag.
- **What `next` points to:** `npm view stim dist-tags.next`. Each run's
  summary names the version, its commit and which packages published.
- **Pause:** `gh variable set NEXT_PAUSED --body true` skips the job until
  `gh variable delete NEXT_PAUSED`. Stable releases are unaffected.

### Desktop prereleases

Stim Desktop has its own `next` channel. A push to `main` that changes `apps/desktop/**` starts the
`Desktop next` workflow (`.github/workflows/desktop-next.yml`), which builds, signs and notarizes the head
of `main` through the same build steps as a stable Desktop release and publishes it as a GitHub prerelease
and a Sparkle item on the `next` channel. See [apps/desktop/RELEASING.md](./apps/desktop/RELEASING.md#next-channel)
for the details; this repository's variable `DESKTOP_NEXT_PAUSED` set to `true` pauses it, as `NEXT_PAUSED`
pauses the npm channel. A stable `desktop-v*` release is unaffected and never waits for a
next build: only the short appcast publish of each workflow takes turns.

## Stim Host releases

`stim service install` installs the Stim Host app on a hosting Mac
(`packages/server/host/`). Its signed build ships apart from the npm packages,
because macOS keys the person's Screen Recording and control grants to its
signature, and it only needs a new version when the launcher changes.

1. Tag a commit on `main` with `host-v<version>` and push the tag. The
   `Stim Host release` workflow builds it universal, signs it with the Desktop
   Developer ID certificate, notarizes and staples it, and attaches
   `StimHost-<version>.zip` and `SHA256SUMS` to a `host-v<version>` GitHub
   release. It uses the `release` environment and the Desktop signing and App
   Store Connect secrets. The environment has no required reviewers for now,
   so the run starts without an approval step. A tag refuses to publish
   a build that is not signed and notarized; a dispatched run is a dry run.
2. Pin the release in `RELEASE` in `packages/server/src/stim-host.ts`: the
   version and the SHA-256 from the workflow's `SHA256SUMS`. From the next
   `stim` release (or checkout build), `install` downloads that zip,
   checks the digest and the team's Developer ID signature, and installs
   `~/Applications/Stim Host.app` (`dev.stim.host`). A Mac that had Stim Host
   Dev keeps that bundle in `~/Applications`; its owner can delete it and its
   System Settings entries after the switch. Update the paragraphs that
   describe the installed app in `packages/server/README.md` ("Run as a
   service"), `website/docs/macos.md` and `stim guide macos`
   (`packages/stim-cli/src/guide/macos.ts`) when a release changes what
   install does.
3. Never replace a published zip: its pinned digest would stop matching. Fix a
   bad release with a new version.

`packages/server/host/release.sh <version>` builds the same zip locally, ad hoc
signed unless `HOST_SIGNING_IDENTITY` is set.

## Don't

- Force-push tags. Cut a new version.
- Skip the tarball check in section 2, step 3. Untracked files have shipped
  before, and it is the only place a `workspace:` range would be caught by hand.
- Hold the tag or the publish for a nightly run. Only the `Full suite` run on
  the release commit (section 4, step 4) gates a stable version.
- Publish one package at a new version and leave the others behind. The shared
  version is the compatibility statement; a partial release makes it a lie.
