# One-time test cleanup: issue #2334

Base: `c07038a63` (`origin/main` at the start of this cleanup). Mode: authorized cleanup, not a read-only recommendation. No skill was installed. Guidance was read from [prune-tests](https://github.com/waffleflopper/ai-tools/blob/main/skills/prune-tests/SKILL.md).

The scope is repository-wide candidate discovery, not a promise that every existing test was re-audited. Searches covered `packages`, `scripts`, `test`, `website`, `apps/mobile` and `apps/desktop/Tests`: whole snapshots, source/file scans, declarations and inventory counts, exact generated markup/copy, mock-call assertions, and dimensions/coordinates. File reads of fixture inputs or outputs, parser records, ownership state, persisted artifacts and real subprocess evidence were triaged as behavioral evidence rather than source scans. Regex matches alone did not authorize deletion.

No production behavior, dependencies or test configuration changed. Dead test support was removed: GC snapshots and setup, unused imports/helpers, the internal `isOutputLabel` helper with no production callers, and the test-only export on locally used `rippleDelay`.

## Policy conflicts and boundaries

- AGENTS.md explicitly permits narrow guide identifier scans and requires guide rendering, routing, safety/remedy and command/default contracts. Those keep dispositions take precedence over the generic prohibition on source and copy checks. Some safety wording assertions require updates after equivalent prose edits; this is an acknowledged exception to the generic refactor/copy-survival bar, not a claim that every wording regex is behavioral. Arbitrary indentation and static-skill word-count/wording checks were removed.
- Device coordinate, rotation and fold projection tests encode control routing and platform frame constraints. They are retained as approved behavioral contracts even though the generic geometry rule would flag their numeric assertions. Decorative tilt, ripple timing, sidebar sizing, thumbnail animation and timeline scroll sizing were deleted.
- This cleanup does not ban fixtures or deliberately adopted visual regression testing. No screenshot comparison framework or new visual requirement was introduced.
- No acceptable rewrite exists for the deleted declaration/decoration/inventory checks. A missing requirement is not repaired by inventing one.

## DELETE

| Path                                                     | Individual test                                                                                   | Reason                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/stim-cli/src/__tests__/gc-output.test.ts`      | GC renders a mixed resource report in its established order                                       | Whole-report presentation/serialization snapshot; no independent ordering contract. Cache scope and no-device-inspection behavior already have explicit assertions in gc.test.ts; all mutation and ownership suites remain.                                               |
| `packages/stim-cli/src/__tests__/gc-output.test.ts`      | a cache-scoped report preserves its serialized shape without inspecting devices                   | Whole-report presentation/serialization snapshot; no independent ordering contract. Cache scope and no-device-inspection behavior already have explicit assertions in gc.test.ts; all mutation and ownership suites remain.                                               |
| `packages/stim-cli/src/__tests__/command-output.test.ts` | Stim Desktop reads progress lines with the same label set                                         | Source inventories or declaration self-comparisons. Actual launch-error output and Desktop progress parsing remain covered; label parsing does not require source spelling, sorting, or a helper used only by these tests.                                                |
| `packages/stim-cli/src/__tests__/command-output.test.ts` | every label the run, lifecycle, doctor and gc commands print comes from that one set              | Source inventories or declaration self-comparisons. Actual launch-error output and Desktop progress parsing remain covered; label parsing does not require source spelling, sorting, or a helper used only by these tests.                                                |
| `packages/stim-cli/src/__tests__/build-cache.test.ts`    | @expo/fingerprint is a declared dependency of the Stim package                                    | Package declaration check. Runtime-floor packaging tests and real benchmark fingerprint resolution exercise dependency availability; a manifest entry alone cannot prove installation works.                                                                              |
| `packages/stim-cli/src/__tests__/guide.test.ts`          | the dev-menu section reads at the left margin, not in the payload table column                    | Indentation-only presentation check; guide routing, content rendering, safety and documented identifiers remain covered.                                                                                                                                                  |
| `website/src/components/canTilt.test.ts`                 | opposite tap edges produce opposite tilt axes, regardless of page position                        | Decorative rotation coordinates only. The sole call site, website/src/pages/index.tsx tapIllustration, animates an illustration and does not route a device input or enable an action.                                                                                    |
| `apps/mobile/src/components/pixel-dismiss.test.ts`       | starts at the centre and grows with the distance from it                                          | Decorative splash ripple delay matrix only; no interaction, navigation, or retained-data behavior is asserted.                                                                                                                                                            |
| `apps/mobile/src/design/tone.test.ts`                    | draws brand as primary, which stays legible on the dark background where the brand token does not | Palette token identity/pass-through assertions; selecting a named token does not prove legibility. The deliberate Increase Contrast accessibility threshold suite remains.                                                                                                |
| `apps/mobile/src/lib/fingerprint-config.test.ts`         | resolves a sourceSkips mask that includes PackageJsonScriptsAll                                   | The mask assertion duplicates the surviving real fingerprint-source behavior. The no-skip case tests the third-party fingerprint library alone, rather than Stim configuration. The retained added-script test catches the original OTA runtime regression.               |
| `apps/mobile/src/lib/fingerprint-config.test.ts`         | would otherwise pick up the script change without the skip (guards the test itself)               | The mask assertion duplicates the surviving real fingerprint-source behavior. The no-skip case tests the third-party fingerprint library alone, rather than Stim configuration. The retained added-script test catches the original OTA runtime regression.               |
| `website/src/components/benchmarkSelection.test.ts`      | publishes readiness-aware first-command error evidence for every launch-error Stim cell           | Fixed current model/platform publication inventory or a constant list. Generic fixture selection, exact/fallback behavior, canonical uniqueness, and historical deep-link routing remain protected. Exporter/audit suites validate readiness evidence before publication. |
| `website/src/components/benchmarkSelection.test.ts`      | selects each published launch-error pair without choosing the earlier Sol sample                  | Fixed current model/platform publication inventory or a constant list. Generic fixture selection, exact/fallback behavior, canonical uniqueness, and historical deep-link routing remain protected. Exporter/audit suites validate readiness evidence before publication. |
| `website/src/components/benchmarkSelection.test.ts`      | keeps every known platform and scenario available to render                                       | Fixed current model/platform publication inventory or a constant list. Generic fixture selection, exact/fallback behavior, canonical uniqueness, and historical deep-link routing remain protected. Exporter/audit suites validate readiness evidence before publication. |
| `website/src/components/benchmarkData.test.ts`           | keeps the label fixed while scaling the full time track                                           | Computed visual zoom range/track widths only; no completed user task. Benchmark metric and URL/audit selection behavior remain protected.                                                                                                                                 |
| `website/src/components/benchmarkData.test.ts`           | preserves the minimum track width on a narrow viewport                                            | Computed visual zoom range/track widths only; no completed user task. Benchmark metric and URL/audit selection behavior remain protected.                                                                                                                                 |
| `scripts/release-qa-matrix.test.mjs`                     | keeps the row wording identical to the RELEASE.md section 3 table                                 | Exact duplicated documentation prose; release row decisions and conservative fallback contracts remain protected without freezing paragraph wording.                                                                                                                      |
| `packages/stim-cli/src/__tests__/command-output.test.ts` | the label set is closed, sorted, and free of duplicates                                           | Source inventories or declaration self-comparisons. Actual launch-error output and Desktop progress parsing remain covered; label parsing does not require source spelling, sorting, or a helper used only by these tests.                                                |
| `apps/mobile/src/lib/sidebar.test.ts`                    | keeps the drawer on a cover and uses a compact sidebar on a wide flat window                      | Responsive width, threshold, pane dimensions and layout choices only. MenuDrawer component tests still protect retained navigation state and Back ownership across compact/sidebar transitions; foldOf still protects native fold parsing.                                |
| `apps/mobile/src/lib/sidebar.test.ts`                    | aligns the panes with a book fold even below the flat-window threshold                            | Responsive width, threshold, pane dimensions and layout choices only. MenuDrawer component tests still protect retained navigation state and Back ownership across compact/sidebar transitions; foldOf still protects native fold parsing.                                |
| `apps/mobile/src/lib/sidebar.test.ts`                    | collapses when either physical panel is too narrow                                                | Responsive width, threshold, pane dimensions and layout choices only. MenuDrawer component tests still protect retained navigation state and Back ownership across compact/sidebar transitions; foldOf still protects native fold parsing.                                |
| `apps/mobile/src/lib/sidebar.test.ts`                    | returns to the flat layout when the division disappears after unfolding                           | Responsive width, threshold, pane dimensions and layout choices only. MenuDrawer component tests still protect retained navigation state and Back ownership across compact/sidebar transitions; foldOf still protects native fold parsing.                                |
| `website/src/components/benchmarkData.test.ts`           | scales from the gesture start and clamps to the supported range                                   | Computed visual zoom range/track widths only; no completed user task. Benchmark metric and URL/audit selection behavior remain protected.                                                                                                                                 |
| `website/src/components/timelineGesture.test.ts`         | keeps the content ratio under the gesture midpoint after zoom                                     | Calculated scroll coordinates/playhead threshold only. Ctrl-wheel browser-zoom cancellation, listener cleanup, and one-versus-two-finger input classification remain protected.                                                                                           |
| `website/src/components/timelineGesture.test.ts`         | keeps the early playhead in view without scrolling                                                | Calculated scroll coordinates/playhead threshold only. Ctrl-wheel browser-zoom cancellation, listener cleanup, and one-versus-two-finger input classification remain protected.                                                                                           |
| `website/src/components/timelineGesture.test.ts`         | follows the playhead after it crosses 70% of the visible track                                    | Calculated scroll coordinates/playhead threshold only. Ctrl-wheel browser-zoom cancellation, listener cleanup, and one-versus-two-finger input classification remain protected.                                                                                           |
| `website/src/components/timelineGesture.test.ts`         | stops at the end of the scrollable timeline                                                       | Calculated scroll coordinates/playhead threshold only. Ctrl-wheel browser-zoom cancellation, listener cleanup, and one-versus-two-finger input classification remain protected.                                                                                           |
| `apps/mobile/src/lib/zoom.test.ts`                       | starts on the thumbnail and ends on the stage                                                     | Thumbnail animation interpolation and drag shrink dimensions only. Frame fitting, keyboard accommodation and pinch focal/input mapping remain covered separately.                                                                                                         |
| `apps/mobile/src/lib/zoom.test.ts`                       | shrinks the screen about its center as it follows a drag down, and ignores a drag up              | Thumbnail animation interpolation and drag shrink dimensions only. Frame fitting, keyboard accommodation and pinch focal/input mapping remain covered separately.                                                                                                         |
| `apps/mobile/src/design/tone.test.ts`                    | reads the tone from the %s palette (light and dark)                                               | Palette token identity/pass-through assertions; selecting a named token does not prove legibility. The deliberate Increase Contrast accessibility threshold suite remains.                                                                                                |

## Survival evidence

Each candidate listed below has one disposition. Each group supplies all six survival checks for each named test; its per-test contract is the independent requirement and concrete failure, rather than a claim that the group survives because another test exists.

### Benchmark rendered evidence

Disposition: **REWRITE**. Path: `website/src/components/BenchmarkTimeline.test.ts`.

1. docs/agent-benchmark.md requires full-run usage/cost, missing usage to remain unavailable, concise command presentation, original sanitized command disclosure and preservation of output. The keyboard/accessibility regression is independently recorded by commit 24489b2c7 (#594).
2. The individual tests catch inaccessible timeline/playback context, hidden or falsely zero usage/cost, missing original command evidence, or lost quoted arguments.
3. The known 90-second run, 368,000 total tokens, $0.54 estimate, and literal fixture commands provide expectations independently of markup generation. The unavailable sentinel is explicitly required by the benchmark protocol.
4. The seam is the server-rendered component parsed as a DOM using the existing jsdom dependency. Tests inspect text, interactive elements and accessibility attributes, not generated HTML spelling.
5. Class names, wrappers, attribute order and entity encoding may change without failure. Accessible names are interface selectors; numeric time and sanitized command data remain the contract. The missing-usage test locates each named metric and verifies its associated unavailable value, without a tag or row count.
6. The component seam checks rendering of evidence; exporter tests check evidence validity and pure data tests check calculations. They are different failure boundaries. No end-to-end duplicate was added.

Individual candidates and the behavior they protect:

- **REWRITE**: names the keyboard-scrollable timeline and exposes playback time to assistive technology.
- **REWRITE**: shows full-run Claude usage even when diagnosis usage is absent.
- **REWRITE**: labels missing full-run usage unavailable instead of inventing zero cost.
- **REWRITE**: uses concise command labels and terminal text with expandable original context.
- **REWRITE**: preserves closing quotes in displayed agent-device arguments.

### Desktop progress framing

Disposition: **REWRITE**. Path: `packages/stim-cli/src/__tests__/command-output.test.ts`. Individual candidate: phaseLine preserves the Desktop label and fact framing (formerly phaseLine uses one indented column).

1. The lifecycle progress guide specifies two leading spaces, a single-token label and a fact; ActivityProgress parses that public framing.
2. A changed prefix or lost label/fact makes the desktop drop the progress row.
3. The known port-release fact and published two-space grammar establish expectations independently of the formatter's padding width.
4. The pure formatter's emitted string is the narrow producer seam; concrete desktop fixture/parser tests cover the consumer.
5. Label padding width and fact copy may vary. Only the protocol prefix and preservation of the supplied label/fact are asserted.
6. One direct producer case replaces the exact column-width examples; no source inventory is needed for this framing contract.

### Pinch focal behavior

Disposition: **REWRITE**. Path: `apps/mobile/src/lib/zoom.test.ts`.

1. apps/mobile/README.md Device view specifies zooming where the user pinches/taps and resetting to fit for control. The test is a worked focal-input mapping example.
2. An incorrect focal offset causes the content under a finger to move when zooming, so the user loses the inspected point.
3. The expected offset 0.25 follows an independently worked example: doubling the picture around its quarter point requires a quarter-view offset. The test no longer reconstructs production coordinate arithmetic.
4. zoomOffset is the pure seam used by the device viewer gesture path.
5. The expectation is tied to the input mapping contract rather than animation timing, color, component wrappers or decorative dimensions.
6. One direct domain example replaces the redundant reconstruction. Neighboring move/clamp examples cover different input cases.

Individual candidates and the behavior they protect:

- **REWRITE**: keeps the point under the fingers in place.

### Cache contract runner

Disposition: **REWRITE**. Path: `packages/cache/__tests__/contract.test.ts`.

1. packages/cache/README.md defines the independently usable provider contract and its test runner; AGENTS.md requires cache packages to work without Stim.
2. The runner must accept a provider honoring storage semantics and report named violations from a broken provider. A false success or exception prevents provider authors from detecting corruption/collisions.
3. The fixture stores actual buffers, objects and artifact bytes. Miss/store/overwrite/key-isolation expectations are the provider contract, not stubbed return equality.
4. runCacheProviderContract is the public package seam with external provider boundaries.
5. Number of runner checks and existence of the fixture directory are incidental and were removed. Capability results and violations survive refactoring of the runner.
6. The two cases cover success and failure, while abort, iOS directory and module-loading cases cover separate contracts. No new duplicate was added.

Individual candidates and the behavior they protect:

- **REWRITE**: the contract passes for a provider that honors both capabilities.
- **REWRITE**: the contract reports violations instead of throwing.

### Release mapping integrity

Disposition: **REWRITE**. Path: `scripts/release-qa-matrix.test.mjs`.

1. RELEASE.md section 3 and docs/specs/2026-09-18-release-qa-orchestration-design.md require path-based QA decisions and conservative fallback. A mapping must refer to an actual QA row or exemption.
2. A misspelled row can silently omit required release evidence. Missing directory inventory coverage cannot do that because unknown paths already require the full matrix.
3. The valid QA row set is the independent release matrix; every mapping must resolve to it. The test retains referential integrity and removes directory enumeration/duplicate counts.
4. The mapping data is the stable release policy seam consumed by computeQaMatrix; the existing computeQaMatrix examples separately assert resulting decisions.
5. New source directories and renamed prose do not fail this narrowed check. A row rename requires matching the release policy references.
6. This data integrity check complements the public decision cases, without duplicating their expected platform results.

Individual candidates and the behavior they protect:

- **REWRITE**: covers every top-level source directory and names only rows the table defines -> mapped paths refer to valid QA rows or an exemption.

### Static router contract

Disposition: **REWRITE**. Path: `packages/stim-cli/src/__tests__/guide.test.ts`.

1. AGENTS.md invariant 1 explicitly requires exactly one shipped skill containing only the version-matched agent router, both PATH and npx forms, with no static operational fallback.
2. Stale operational commands or extra shipped skills can make agents follow guidance for another version instead of the installed CLI.
3. The required commands and banned mutable operational examples come from the governing invariant, not from the current body text.
4. The shipped skill file and directory are the distribution interface.
5. Arbitrary 110-word length and exact explanatory sentence were removed. The one-router command counts and mutable-detail prohibition remain because they express the explicit repository contract.
6. Runtime guide contract cases validate the detailed guidance; this case validates the tiny distributed activation entry point and does not repeat the detailed body.

Individual candidates and the behavior they protect:

- **REWRITE**: the static skill is only the agent guide router.

### Historical link and empty audit state

Disposition: **REWRITE**. Path: `website/src/components/benchmarkSelection.test.ts`.

1. docs/agent-benchmark.md says canonical comparison updates replace runs and preserve historical links; the earlier alias is a recorded migrated URL.
2. A historical link must continue selecting the intended current comparison and arm rather than becoming broken or selecting an unrelated sample.
3. The input old stage and expected canonical stage/arm are an explicit migration example, independently fixed by the published URL contract.
4. benchmarkSelectionSearch and benchmarkSelectionFromSearch are the public URL-selection seams.
5. The redundant current catalog inventory assertion was removed; adding unrelated benchmark cells no longer changes this case.
6. The specific historical alias complements generic fixture fallback/selection tests; no other case covers this old URL.

Individual candidates and the behavior they protect:

- **REWRITE**: routes the earlier Sol deep link to its current comparison.

### Empty audit selection

Disposition: **REWRITE**. Path: `website/src/components/benchmarkData.test.ts`.

1. docs/agent-benchmark.md requires the viewer to show recorded evidence and never fabricate unavailable proof.
2. An empty invalid run must not claim a selected event or proof.
3. The expected null selection follows the absence of every independently supplied event collection.
4. initialAuditSelection is the pure selection seam used by the benchmark viewer.
5. The assertion that the fixture already had null proof was deleted. Selection behavior survives presentation and internal implementation changes.
6. This is the single absent-evidence case, distinct from active-command selection and exporter validity.

Individual candidates and the behavior they protect:

- **REWRITE**: returns an empty audit state when an invalid run has no events or proof.

### OTA script-only stability

Disposition: **KEEP**. Path: `apps/mobile/src/lib/fingerprint-config.test.ts`.

1. apps/mobile/README.md runtimeVersion requires JS-only changes to retain installed-build compatibility. Issue #1814 motivated the PackageJsonScriptsAll configuration; commit 658007017 (#1897) introduced this regression test.
2. A scripts-only package edit must not produce a native fingerprint source that forces another binary build.
3. Before/after source equality is an independently specified metamorphic requirement, not the implementation formula. The action adds a real script to a temporary manifest.
4. The app-resolved Expo fingerprint config and actual package source generator are the runtime seam.
5. The test permits configuration representation and bitmask changes as long as the native-source behavior remains stable.
6. The mask-only and upstream no-skip cases were deleted, leaving one real configuration behavior case.

Individual candidates and the behavior they protect:

- **KEEP**: does not change the package.json scripts fingerprint source when a script is added.

### Permitted guide contracts

Disposition: **KEEP**. Path: `packages/stim-cli/src/__tests__/guide.test.ts`.

1. AGENTS.md Tests and abstractions and invariant 1 approve guide rendering, routing, safety, recovery, defaults and agreement with code-defined identifiers. website/docs/commands.md Guide describes topic/section lookup and refusal-code discovery; command and registry contracts define the exact names.
2. Each named case catches the missing/incorrect content, route, instruction, identifier, status placement or lookup behavior named in its title. Safety cases protect a consequential agent decision, not promotional prose.
3. For rendering/routing, configured topic/section content is an independent renderer input, not the renderer calculation. For identifier agreement the authoritative registry/command types are independent of guide text. Safety expectations come from AGENTS.md ownership, cleanup, warming, lease, signing, launch and authorization invariants.
4. renderTopic, renderSection, renderIndex, the Commander guide command and the shipped guide artifact are stable agent interfaces. Narrow source scans are retained only to enumerate documented identifiers.
5. Renderer/identifier tests survive internal refactors. Safety/remedy wording checks are the explicit repository exception described above: equivalent prose edits can require assertion updates. This limitation is recorded rather than concealed.
6. Pure renderer, route, distribution and instruction cases protect distinct failures; command behavior suites remain the proof of the operations themselves. No operational test was replaced with a source scan.

Individual candidates and the behavior they protect:

- **KEEP**: every advertised topic renders non-empty content.
- **KEEP**: every section of every sectioned topic renders its own content.
- **KEEP**: \n.
- **KEEP**: an alias resolves to the same body as the section it spells.
- **KEEP**: section and alias names are unique within a topic.
- **KEEP**: a section name that no topic declares renders nothing.
- **KEEP**: a sectioned topic prints its preamble and an index of every section.
- **KEEP**: an index row carries the word count of the section body it names.
- **KEEP**: the errors index keeps the configured group separators and preambles.
- **KEEP**: a section renders its group preamble before its body.
- **KEEP**: the lifecycle topic grids every label the output vocabulary allows, and no others.
- **KEEP**: native-build cache fields are documented in the JSON failure contract.
- **KEEP**: an unknown topic renders nothing rather than throwing.
- **KEEP**: an inherited property name is an unknown topic, not a prototype member.
- **KEEP**: a whole topic offers no section index and no section body.
- **KEEP**: the index lists every topic and the running version.
- **KEEP**: the errors topic documents every code the build commands and the iOS signing gate can emit.
- **KEEP**: current guides require completed warming and leave worktree creation to Git.
- **KEEP**: the errors topic documents every code the engine can emit under a command.
- **KEEP**: the errors topic documents both codes the ownership-claim primitive raises.
- **KEEP**: AVD claim recovery requires checking native processes and keeping incomplete ownership.
- **KEEP**: emulator teardown signals only a verified process and names the refusal.
- **KEEP**: short lock recovery requires checking the holder before manual removal.
- **KEEP**: the rendered guide carries the warm --refresh contract, not just its source.
- **KEEP**: the facts topic documents every reload strategy the command can report.
- **KEEP**: the facts topic documents the status remote device fields and states.
- **KEEP**: the facts topic documents every physical device connection state.
- **KEEP**: the facts topic documents every gc verdict reason code and inventory owner.
- **KEEP**: pool recovery guidance routes claim refusals to the error remedy and back.
- **KEEP**: the viewer override is discoverable beside the machine preference and boot guidance.
- **KEEP**: the settings topic names the reason stim settings prints for a Stim Desktop default.
- **KEEP**: emulator boot guidance routes the emulator viewer preference to the settings topic.
- **KEEP**: the settings topic documents every registered setting and its environment override.
- **KEEP**: every guide topic explains the npx fallback for short stim commands.
- **KEEP**: the agent asks before gc deletes and before the worktree sweep.
- **KEEP**: the agent workflow checks errors before and after edits, before cleanup.
- **KEEP**: the logs guides distinguish an unused workspace from an empty filtered timeline.
- **KEEP**: the logs guide documents the context field that --errors --json adds to Expo errors.
- **KEEP**: the agent and lifecycle guides name both workflows.
- **KEEP**: the agent guide routes situations to valid sections before listing every topic.
- **KEEP**: FULL TOPIC LIST.
- **KEEP**: \n.
- **KEEP**: |.
- **KEEP**: the agent guide shares the Stim Desktop link the commands print, once.
- **KEEP**: the agent guide protects other workspaces device lease files.
- **KEEP**: the agent guide limits memory-pressure recovery to owned workspaces.
- **KEEP**: the agent and cleanup guides shut down owned simulators without an occupancy check.
- **KEEP**: the guide names every path Stim ignores by default.
- **KEEP**: the package exposes only the stim binary.
- **KEEP**: the reload payload guide distinguishes dispatch from observed completion.
- **KEEP**: warm guidance protects existing entries and tracked changes.
- **KEEP**: temporary storage guidance names the override and Git visibility boundary.
- **KEEP**: build guidance names the experimental Android compiler opt-in.
- **KEEP**: EAS guidance requires profile clarification when needed and authorization for paid builds.
- **KEEP**: slot selection and shared Metro behavior are discoverable in operational guidance.
- **KEEP**: named ports guidance is routed and separates named listener cleanup from Metro.
- **KEEP**: guide prints the status block before the index and the agent topic, and never before a section.
- **KEEP**: the facts topic documents every status issue code.
- **KEEP**: the facts topic documents every workspace phase.
- **KEEP**: the facts topic documents every workspace stage kind.
- **KEEP**: the facts topic documents every machine owner kind.
- **KEEP**: the facts topic documents every agent tool status can attribute.
- **KEEP**: the facts topic documents every memory source.
- **KEEP**: the facts topic documents every app process state.
- **KEEP**: the facts topic names every detected automation tool.
- **KEEP**: the facts topic documents every web page state.
- **KEEP**: the facts topic documents every build result and the history length status can report.
- **KEEP**: the stats facts document every placement decision and the placement retention.
- **KEEP**: the facts topic documents every native build step a running build can report.
- **KEEP**: the facts topic documents every build phase and state status can report.
- **KEEP**: the facts topic lists every field of a running build.
- **KEEP**: the web topic names every web setting and every stim web flag, and the agent guide routes to it.

### Device geometry and gesture behavior

Disposition: **KEEP**. Path: `apps/mobile/src/lib/zoom.test.ts`.

1. apps/mobile/README.md Device view specifies fitting the stream, zooming/panning where the user touches, resetting at fit and retaining keyboard control. Public geometry API contracts specify the fitted aperture, keyboard bounds and pan limits.
2. The named cases catch obscured/clipped screen areas, keyboard-obscured controls, lost focal point or panning beyond valid screen bounds.
3. The supplied rectangular worked examples and independent focal/pan constraints establish expected results; they do not import output constants or restate zoom implementation.
4. Pure fitRect, liftAbove, zoomOffset and clampOffset are the lowest stable seams used by the viewer.
5. Geometry values here encode valid input/screen bounds, an acknowledged behavioral exception to the generic appearance rule. They survive view/component and animation refactors.
6. Animation interpolation cases were deleted; the retained examples cover distinct aperture, keyboard and gesture constraints.

Individual candidates and the behavior they protect:

- **KEEP**: centers a phone screen in a wider stage and a landscape one in a taller stage.
- **KEEP**: lifts the screen until its bottom meets the keyboard.
- **KEEP**: stops at the header when the screen is taller than the room above the keyboard.
- **KEEP**: leaves a screen that already ends above the keyboard in place.
- **KEEP**: follows the fingers when they move while pinching.
- **KEEP**: never pans past the picture edge, and centers the picture back at fit.
- **KEEP**: limits a pan to what overflows the view.

### Timeline gesture routing

Disposition: **KEEP**. Path: `website/src/components/timelineGesture.test.ts`.

1. docs/agent-benchmark.md requires interactive timeline zoom/playback; ordinary scrolling must remain available and zoom must consume only its own input. The two-finger classification is the interaction seam, not decorative dimensions.
2. The named cases catch browser page zoom stealing a timeline gesture, ordinary wheel interference, leaked listeners, incorrect pinch focal input or one-finger scrolling interception.
3. Cancelability, unhandled ordinary events and one-versus-two-finger behavior follow browser/gesture contracts; the known touch pair independently establishes 100 distance and 150 midpoint.
4. EventTarget dispatch and timelinePinchGeometry are the lowest stable input seams; no private component calls are asserted.
5. CSS dimensions, track width and playhead scroll thresholds are not asserted. Event cancellation and touch classification survive those appearance changes.
6. Scroll-coordinate appearance cases were deleted; the four survivors protect different input/cancellation and cleanup outcomes.

Individual candidates and the behavior they protect:

- **KEEP**: cancels Ctrl-wheel page zoom and reports the focal point and scale.
- **KEEP**: leaves an ordinary wheel event untouched and removes its listener.
- **KEEP**: reports a two-touch distance and midpoint.
- **KEEP**: leaves one-finger timeline scrolling alone.

### Canonical catalog uniqueness

Disposition: **KEEP**. Path: `website/src/components/benchmarkSelection.test.ts`.

1. docs/agent-benchmark.md explicitly requires one current result per model, platform, scenario and arm, replacing validated canonical comparisons.
2. A duplicate cell can silently select an older or unrelated comparison rather than the latest intended result.
3. The uniqueness relation is an independent publication rule; there is no fixed expected inventory count and no copied model list.
4. The published catalog is the actual data interface used by URL/picker selection.
5. Adding new unique models/platforms/scenarios and changing labels does not fail it; only an ambiguous canonical cell does.
6. This declarative publication constraint complements fixture selection behavior and exporter evidence checks. Fixed current-model inventory cases were deleted.

Individual candidates and the behavior they protect:

- **KEEP**: publishes only one benchmark per model, platform and scenario, and one run per arm and variant.

### Release fallback and policy data

Disposition: **KEEP**. Path: `scripts/release-qa-matrix.test.mjs`.

1. RELEASE.md section 3 and the QA orchestration design require conservative fallback for unknown files rather than silently exempting native release risk.
2. A more-specific directory fallback must not drop required QA inherited from its parent; doing so would skip evidence for a newly added file.
3. The subset relation is an independently specified monotonic safety property, not an expected copy of the selector implementation.
4. Path policy data is the stable mapping seam consumed by the release QA script.
5. New files, mapped directories and wording survive so long as fallback remains conservative.
6. The public unmapped-file cases protect actual fallback selection; this relation covers every configured nested fallback without multiplying examples.

Individual candidates and the behavior they protect:

- **KEEP**: never lets a directory fallback require fewer rows than the directory above it.

### Troubleshooting discovery

Disposition: **KEEP**. Path: `website/scripts/gen-troubleshooting.test.mjs`.

1. AGENTS.md requires aligned website/CLI error remedies and explicitly permits narrow identifier contract scans; the website must render usable troubleshooting links.
2. The individual cases catch an emitted refusal without an anchor, generated MDX that cannot parse, or ungrouped error discovery.
3. CLI refusal identifiers and guide sections are independent generator inputs; MDX syntax constraints and grouped discovery are publication requirements.
4. buildTroubleshooting output is the website generator interface; narrow code scans enumerate refusal IDs rather than testing how operations are implemented.
5. Error prose and CLI internals may change. Identifier additions/removals legitimately change the anchor contract. The fixed lower-bound guard is only a scan-sanity check, a retained repo-approved contract limitation.
6. These generator-specific anchors/syntax checks complement the CLI guide and behavior cases; no duplicate HTML snapshot is retained.

Individual candidates and the behavior they protect:

- **KEEP**: every refusal code the CLI can emit has an anchored entry on the troubleshooting page.
- **KEEP**: the page carries no markup MDX would refuse to parse.
- **KEEP**: every code entry sits under a group heading.

### Cache-scoped inspection boundary

Disposition: **REWRITE**. Path: `packages/stim-cli/src/__tests__/gc.test.ts`. Individual candidate: carries the scope and inspects nothing else.

1. AGENTS.md cleanup/output contracts and website/docs/commands.md `gc --cache` require cache scope to leave device inspection outside the request.
2. Inspecting devices for a compilation-cache-only report can stall/fail unrelated cleanup and claim device findings outside its scope.
3. Absence of simctl, avdmanager, adb and emulator invocation follows scope semantics, independently of empty fixture output.
4. The existing public collectGcReport case now captures the executor boundary, including synchronous/asynchronous file calls and spawn.
5. Internal device helper names and report prose may change; only native device invocations outside the cache scope fail the new assertion.
6. This extends the existing case instead of duplicating it. The removed serialized-report snapshot did not actually observe whether native inspection occurred.

## Other inspected leads retained unchanged

These are not implementation-source checks: they read fixtures/state, test actual process effects, or specify public protocol/ownership behavior. The search matched syntax shared with behavioral tests.

| Path / inspected lead                                                                                                                                                | Disposition and six-point justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/__tests__/settings-schema.test.ts`: the published schema covers every setting once, at the scope files it may live in                                 | **KEEP**. AGENTS.md Settings registry requires schema/registry alignment; missing or wrong-scope keys break settings consumers; the independent registry is the expected input; public generated JSON Schema is the seam; refactors/copy are incidental; schema generation is distinct from settings validation.                                                                                                                                                                                                                                                          |
| `packages/core/__tests__/paths.test.ts`: workspace/shared path and purity cases                                                                                      | **KEEP**. AGENTS.md Shared state reads, canonical paths and Redirect test state establish layout; escaped/colliding roots corrupt another workspace; fixed STIM_HOME/path examples and no-side-effects are independent requirements; exported path functions are the seam; implementations may change while paths remain contractual; ownership metadata tests exercise different effects.                                                                                                                                                                                |
| `packages/stim-cli/src/__tests__/paths.test.ts`: ensureWorkspaceStorage records ownership and refuses a mismatched record                                            | **KEEP**. AGENTS.md Locked state and ownership require matching workspace metadata; accepting a collision writes another workspace; a planted mismatched owner is independent evidence; ensureWorkspaceStorage output/refusal/persisted JSON are the seam; harmless code refactors survive; this tests ownership creation rather than the pure path seam.                                                                                                                                                                                                                 |
| `scripts/agent-benchmark/cache-key.test.mjs`: real pinned fingerprint selection and cache-key refusal cases                                                          | **KEEP**. docs/agent-benchmark.md requires exact prepared native cache identity; loading a conflicting project package or ambiguous ABI key falsifies benchmark evidence; injected conflicting package and real input changes independently establish expected hash behavior; actual fingerprint/key-selection seams are exercised; copy and implementation names are irrelevant; this runtime regression supplements package tests rather than duplicating a manifest declaration.                                                                                       |
| `scripts/prompt-eval/cases.test.mjs`: actual prompt extraction and command-sequence/protocol cases                                                                   | **KEEP**. Website copyable prompts and AGENTS.md guide-first/workspace/physical/slot/error contracts are independent requirements; wrong action or malformed fixture result invalidates agent evaluation; planted wrong commands and CLI payload shapes are independent evidence; websitePrompt/commandState and public CLI facts are stable seams; prompt wording may vary while extraction/commands stay valid; driver policy differs from real CLI execution tests.                                                                                                    |
| `apps/mobile/src/design/contrast.test.ts`: Increase Contrast text/tone 7:1 and border/separator 3:1 cases, light and dark                                            | **KEEP**. Deliberate accessibility palette requirement in commit 075ef7f0a (#2185), rather than inferred style; unreadable contrast breaks accessibility; independent WCAG contrast calculation and thresholds establish the expectation; palette is the public design seam; individual colors may change without failure when thresholds hold; this catches accessibility behavior rather than token identity.                                                                                                                                                           |
| `apps/mobile/src/lib/agent-prompts.test.ts`: distinct sample membership and pool exhaustion cases                                                                    | **KEEP**. README home prompt suggestions and pickPrompts API require a bounded selection of real suggestions; duplicates/foreign suggestions or over-selection make choices unusable; set membership/distinctness/exhaustion are independent properties; the pure selection seam is stable; wording/order/random outcomes may change; this tests selection rather than fixed corpus count.                                                                                                                                                                                |
| `apps/mobile/src/lib/fold.test.ts`: vertical/horizontal division parsing and absent/edge division cases                                                              | **KEEP**. Native reserved-region fold contract governs panel/input regions; misclassification treats the camera as a fold or rotates panels wrong; recorded region fixtures and semantic orientation are independent; foldOf is the pure parser seam; component and decorative layout refactors survive; sidebar width tests were removed instead.                                                                                                                                                                                                                        |
| `apps/mobile/src/lib/device-control.test.ts`: framePoint letterbox/reject/clamp cases                                                                                | **KEEP**. README Device view and control require touches to reach the correct screen pixels; wrong mapping or out-of-picture touches drive unintended device actions; known center/outside/edge points are independent geometric examples; framePoint is the pure input seam; frame decoration/animation can change; no renderer snapshot duplicates it.                                                                                                                                                                                                                  |
| `apps/mobile/src/components/menu-drawer.test.tsx`: all five retained navigation state/Back/haptic transition cases                                                   | **KEEP**. README menu/home retention and Android Back and recorded drawer regressions define the contract; rotation or overlay must not remount home, reset menu intent, intercept Back or replay opening feedback; seeded user opening/layout/focus events establish expectations; component events with external drawer/Back boundaries are the stable seam; layout widths provide contexts rather than expected ratios; this retains consequential transitions while sidebar dimension tests are removed.                                                              |
| `apps/mobile/src/hooks/polled-request.test.ts and hooks/machine-details.test.ts`: poll scheduling, late reply, cancellation, failure and pending-cap cases           | **KEEP**. README live machine details/refresh and protocol unknown-method compatibility require ordered, bounded requests; stale results overwrite newer data, unmounted work leaks or unknown methods loop forever; explicitly ordered replies/clocks provide independent outcomes; public hooks with connection boundary are the seam; request implementation/copy can change; each case covers a different scheduling/error state.                                                                                                                                     |
| `apps/desktop/Tests/StimKitTests/ScreenGeometryTests.swift`: all three screen-point mapping cases                                                                    | **KEEP**. Desktop device control must map the fitted stream to native coordinates and reject blank-space input; wrong letterbox/pillarbox mapping taps another pixel; worked known positions establish expected top-left fractions; normalizedScreenPoint is the pure input seam; layout refactors survive while the input relation stays valid; these do not duplicate fold projection.                                                                                                                                                                                  |
| `apps/desktop/Tests/SimulatorFramesTests/DuoFoldProjectionTests.swift`: all nine projected touch/platform perspective/live surface/orientation cases                 | **KEEP**. Desktop Duo input/surface and UIKit orientation requirements verified for #2220/#2280 family establish native coordinates; wrong projection taps another leaf/pixel or shows a stale/misoriented surface; CoreAnimation transform and native orientation are independent platform oracles plus known touches; pure projection and native display view are stable platform seams; geometry assertions are the approved control/platform exception, not arbitrary styling; each covers distinct platform mapping, hit exclusion, surface or orientation behavior. |
| `packages/stim-cli/src/__tests__/gc.test.ts and gc-workspaces/gc-recordings/gc-memory/gc-idle tests`: cache scope and all ownership/refusal/persisted-resource cases | **KEEP**. AGENTS.md cleanup ownership/fail-closed/output contracts independently require these outcomes; wrong cleanup can destroy another workspace/device or claim a clean uninspected machine; planted owners, claims and filesystem evidence supply independent expectations; public report/runGc and state seams are exercised; copy may vary except meaningful refusals/contract labels; snapshot deletion leaves explicit behavioral cases in place.                                                                                                               |

## Recorded coverage limits

- `apps/desktop/Tests/StimKitTests/ActivityProgressTests.swift` parses concrete CLI phase lines and the captured `stim-ios-run.txt` output fixture. CLI Android/iOS command cases assert streamed phases and final stdout/JSON facts. These cover real consumer behavior, but they do not dynamically feed every future command label into the Swift parser. Deleting the cross-language source vocabulary comparison removes that exhaustive declaration-alignment guard; new label behavior still needs a consumer fixture/parser case under the existing test rules. The guide vocabulary check remains independently required by AGENTS.md.
- GC `gc --json` cases in `gc.test.ts` assert one parseable dry-run/delete payload, its section fields, ownership inventory and no unwanted deletion. Cache scope keeps explicit section assertions and now checks the native-executor boundary. The deleted internal collectGcReport snapshot was neither the public stdout payload nor proof of no native calls.

## Validation

The following checks validate the final diff. No native tool invocation or end-to-end workflow changed, so compatibility/device execution and E2E runs are not required for this cleanup. Desktop sources/tests are unchanged.

- Initial narrow root run: 43 passed, four suites could not import unbuilt workspace packages; fixed by running the prescribed build, not by changing tests/configuration.
- Initial mobile run: sandbox blocked Watchman state access; the same Jest script runs with `--watchman=false` and temporary test state.
- Narrow root candidates after build: 344 passed; the first DOM rewrite hit Docusaurus virtual-module resolution in a browser transform. Running existing server rendering plus parsed DOM in the Node test environment resolves it without configuration/dependency changes.
- Final focused benchmark rendering, gesture and release-matrix cases: 17 passed. Final command-output cases, including progress framing: 17 passed.
- Focused mobile behavior: 6 suites / 27 tests passed.
- Full mobile suite: 57 suites / 598 tests passed.
- Initial format check reported eight touched files; formatted only the affected files.
- Knip initially found the removed tests' unused `rippleDelay` export and `isOutputLabel` helper; removed that test-only support.
- Website typecheck initially found jsdom declarations unavailable and a missing restored pinch import; corrected test loading/import without adding a dependency or changing test configuration.
- Initial full root run with default parallelism: 6,011 passed, nine failed, 18 skipped. Two failures were the restored pinch tests missing their import; seven were unrelated subprocess/server timeout failures under concurrent load. No timeout or configuration was changed.
- A bounded rerun (`pnpm test --maxWorkers=4`) passed all previously timed-out cases and 6,019 tests; the sole failure was a missing-usage assertion that included the caption text. It was corrected to inspect each labeled metric's unavailable value. The first focused correction also exposed concatenated DOM text; exact descendant value checks resolved it.
- Final full root suite, `pnpm test --maxWorkers=4`: 212 files passed, 6,021 tests passed, 18 skipped (6,039 total), exit 0. This includes the rewritten progress-framing case.
- Root `pnpm run format:check`, `pnpm run lint`, `pnpm run build`, `pnpm run typecheck`, `pnpm run knip` and `pnpm run test:runtime`: passed, exit 0.
- Mobile `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run intl:check`, and `pnpm test --runInBand --watchman=false`: passed, exit 0; full suite 57 files / 598 tests.
- Website `pnpm run typecheck`: passed, exit 0.
- `git diff --check`: passed. Dependency lockfile and test configuration are unchanged.
