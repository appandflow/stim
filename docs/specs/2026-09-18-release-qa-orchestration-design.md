# Coverage-aware release QA orchestration

Date: 2026-09-18. Status: proposed; phase 1 implemented as
`scripts/release-qa-matrix.mjs`. Issue: #598.

## Summary

The release QA matrix is chosen by a program, not by hand. A mapping from
repository paths to the rows of the RELEASE.md section 3 table turns
`git diff <last-published-tag>..HEAD` into the set of rows the diff can affect,
the reason each row is required, and the reason each omitted row cannot be
reached. The same computation prints the owner's checklist and the `QA` section
of `docs/releases/X.Y.Z.md`, so the checklist that was worked and the section
that was published cannot disagree.

## Motivation

Section 3 already permits a patch release to omit rows, but only with a
diff-based reason per omission. Producing that argument by hand costs an
inspection of every commit since the tag against an eight-row table, and it is
the release owner who pays it, at the point where the release is already late.
The last three releases took the other exit: 1.4.0, 1.5.0, and 1.6.0 each
waived the whole native matrix at the user's request. A waiver is cheap and a
justified subset is expensive, so the cheap one wins, and the release ships
with less evidence than a computed subset would have given it.

The cost is the argument, not the tests. Computing the argument makes the
justified subset the cheapest option on the table.

## Scope

In: choosing the section 3 rows for a release diff, the reason for each
inclusion and omission, and the release-note `QA` section generated from that
result.

Out (non-goals):

- Changing what any suite asserts, or merging the lifecycle and cache runners.
  That is the other half of #598 and it keeps its own evidence bar: equivalent
  assertions, seeded failures that still fail, and measured savings.
- Scheduling, parallelism, and host resource policy. Heavy native builds stay
  sequential on the QA host.
- Waiving the major-release rule that the full matrix runs on two
  representative real repositories. The mapping narrows a patch or minor
  release; it never narrows a major.
- Deciding whether QA is needed on a feature branch or a pull request. This
  reads a release range only.
- Inferring areas from commit messages, issue labels, or pull request labels.
  Those describe intent; the diff describes reach.
- Symbol-level or import-graph reachability. See "Decisions".
- Gating the release. The script prints a decision; the owner and the section 3
  checklist still own the gate.

## What the mapping is keyed on

Repository-relative paths, most specific prefix wins. A rule is a path (a file
or a directory) plus either the rows that a change under it can affect, or an
`exempt` reason stating why it can affect none. A rule may narrow the platform
(`ios`, `android`) or the framework (`expo`, `bare`) so the matrix asks for the
Gradle rows on a Gradle change rather than both platforms.

The mapping lives in `scripts/release-qa-matrix.data.mjs`, next to the script,
as data. Three levels do the work:

- **Package.** `packages/cache` is cache and remote-provider evidence, because
  it is the provider contract the remote cache consumes; `packages/metro` is
  cache and log evidence.
- **Directory.** `packages/stim-cli/src` requires every row, and each directory
  under it requires at least what it inherits. A directory rule is a fallback
  for files nobody has mapped yet, so it may never ask for less than the
  directory above it: narrowing there is silent, and the file it silently
  narrows has not been read by anyone. A test over the data enforces that.
- **File.** Only a file rule narrows. `engine/gradle.ts` is Android cache and
  lifecycle evidence rather than the whole `src` fallback; `engine/tunnel.ts`
  is the remote provider row alone. A file with no rule keeps the fallback and
  over-requires, which is visible and costs a run, rather than under-requiring,
  which is silent and costs the evidence.

Platform narrowing (`ios`, `android`) applies to any row. Framework narrowing
(`expo`, `bare`) only reaches `loop`, the one framework-axis row, so a rule
whose rows are all platform-axis or global carries no framework list.

Paths that cannot change native behavior carry an `exempt` reason instead of
rows: documentation, the website, repository tooling, test configuration, and
the guide text whose contract tests already run in the preflight. An exempt
directory is an explicit claim that nothing under it reaches native evidence,
not a fallback, so it is the one directory rule the monotonic check skips.
`test/e2e/native` is not exempt even though `test` is: the section 2 preflight
runs `test/e2e/*.e2e.js`, not those runners, and changing the instrument
invalidates its readings.

A path that matches no rule is not assumed harmless. It is reported as
unclassified and every row becomes required, which is invariant 8 applied to
evidence: when the mapping cannot prove a path is unaffected, it keeps the
work. The unit test enforces that this stays rare by failing when a top-level
source directory has no rule of its own, so a new subsystem lands with its
mapping or it does not land.

## Computing the required matrix

```bash
node scripts/release-qa-matrix.mjs v1.6.0
node scripts/release-qa-matrix.mjs v1.6.0 --format markdown
```

1. Read the changed paths with `git diff --numstat --no-renames <tag>..HEAD`,
   the machine-readable form of the `git diff --stat` a release owner reads by
   eye. `--no-renames` keeps a rename from hiding two paths behind one arrow.
2. Drop the candidate version bump. The candidate under QA is already bumped
   (section 2 step 1), so every release diff contains five manifests. A
   `packages/*/package.json` whose diff moves the `version` field and nothing
   else is exempt; one that moves a dependency is not, because a dependency
   change moves fingerprints and builds.
3. Classify each remaining path and union the rows, the platforms, and the
   frameworks its rule names.
4. Print each row as required with the paths that require it, or as omitted
   with the table's own wording for what the diff does not touch.

The last published tag comes from section 1, which already resolves it from
the registry rather than from local tags. The script takes it as an argument
instead of guessing, so a partial release cannot silently move the baseline.

## Where the automated suite summaries land

Phase 1 changes nothing here: `run-cache-e2e.mjs --summary <path>` writes where
the owner points it, and the summaries are attached to the release pull request
or task as section 3 requires.

Phase 2 gives the run a directory rather than a habit. One evidence root per
candidate, `$STIM_HOME/release-qa/<version>/`, holding one file per required
row named `<row-id>-<framework>-<platform>.json`, plus a `manifest.json`
recording the candidate SHA, the fixture and tool versions, the host, the rows
this run claims, and the stage timings. The row names come from the same data
file, so the checklist, the file names, and the release note use one
vocabulary, and a required row with no file is a visible hole rather than a
missing sentence. `$STIM_HOME` and not the project tree, because this is run
state: only the manifest and the summaries the owner attaches reach the
repository.

## Generating the release note QA section

`--format markdown` prints the `QA` section for `docs/releases/X.Y.Z.md`: the
range it read, the required rows with their evidence sentence and the paths
that required them, the omitted rows each with its diff-based reason, and the
reminder that a required row without attached evidence is not a pass. Section 3
already demands exactly this argument; generating it means the published note
is the checklist that was worked.

An expedited RC still uses the lane's own fixed wording. A waived stable
release still states that it was waived. The generated section replaces neither;
it is what a release that does its QA writes down.

## Known gaps

The field protocol has a `Physical iPhone` row that the section 3 table does
not list, so no mapping rule can require it. Today a change to
`engine/ios-device.ts` or `engine/ios-signing.ts` maps to the iOS lifecycle and
launch rows, which the simulator can satisfy, while the protocol's staged
checklist is what actually covers a cabled phone. Closing that gap means adding
a row to the section 3 table, which is a release-owner decision rather than a
mapping change.

## Testing

- `computeQaMatrix` over crafted change lists: a narrow file rule beating its
  directory fallback, platform narrowing, the union of causes per row, the
  empty diff, and the table's wording on an omitted row.
- The version-bump reader: a manifest diff that moves only `version`, one that
  moves a dependency, and an empty diff.
- An unclassified path requires every row and names itself as the reason.
- Both renderers: the checklist marks required and omitted rows with their
  reasons, and the markdown carries the `## QA` heading, one bullet per row,
  and both reason forms.
- Coverage: every top-level source directory, every package, and every
  `packages/stim-cli/src` subsystem has its own rule, every rule is either rows
  or an exempt reason, and no rule names a row the table does not define.
- Monotonic directories: no directory rule requires fewer rows than the nearest
  directory above it.
- Wording: the `change` and `evidence` strings parsed out of the RELEASE.md
  section 3 table equal the ones in the data file, in order, so editing the
  table without editing the mapping fails the suite.

## Decisions

| Question                               | Decision                                           | Why                                                                                     |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Key                                    | Repository paths, most specific prefix wins        | A diff is paths; a prefix table is reviewable and has no build step                     |
| Import-graph reachability              | No                                                 | It answers "what could execute", not "what evidence is at risk", and it rots            |
| Unmatched path                         | Requires the full matrix                           | Invariant 8: unproven means retained, never assumed clean                               |
| New subsystem directory                | Unit test fails until it has a rule                | The mapping decays silently otherwise, and it decays toward less QA                     |
| Unmapped file under a mapped directory | Keeps the fallback, which for `src` is every row   | Over-requiring costs a run and is visible; under-requiring costs evidence and is silent |
| Where narrowing is allowed             | File rules only; a directory never shrinks         | A directory rule is the fallback for files nobody has read yet                          |
| Candidate version bump                 | Exempt when the manifest diff moves only `version` | Otherwise every release diff requires the full matrix and the tool is useless           |
| Lockfile change                        | Cache and lifecycle rows                           | Section 2 step 4: the lockfile no longer moves with a bump, so it means dependencies    |
| Native e2e runner change               | The row that runner produces                       | Changing the instrument invalidates its prior readings                                  |
| Who gates                              | The owner and the section 3 checklist              | The script argues; it does not have the standing to pass a release                      |
| Where phase 2 evidence lands           | `$STIM_HOME/release-qa/<version>/`                 | Run state, not repository content; the repository takes the manifest and summaries      |

## Phases

1. Row selection, the reason for each decision, and the generated `QA` section.
   Implemented here; RELEASE.md section 3 points at it.
2. The evidence root, the per-row file naming, and the manifest, with a missing
   file failing the gate rather than the owner noticing.
3. Applicability after a candidate fix: recompute the matrix for the fix's own
   diff, rerun the rows it reaches, and retain the rest with their exact commit
   and the recorded reason. Packaging, version, and exact-commit CI stay
   required regardless.
