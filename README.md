# stim-video

Remotion compositions for stim marketing and benchmark videos. Lives outside the stim repository on purpose so the product code stays free of video tooling.

- `StimWorkflow`: the 90 second "Stim Workflow" explainer (1920x1080), plus `StimWorkflowSocial` (1080x1350).
- `BenchmarkLandscape` and `BenchmarkSocial`: the benchmark replay used on the website. `scripts/render-benchmark-video.mjs` reads the published dataset and assets from a sibling stim checkout (`STIM_WEBSITE_DIR`, default `../stim/website`) and writes the mp4s back into its `static/benchmarks`.

```sh
pnpm install
pnpm studio                # Remotion Studio
pnpm render:workflow       # out/stim-workflow.mp4
pnpm render:workflow-social
pnpm render:benchmark
```

Brand assets in `public/brand` and fonts in `public/fonts` are copies of the stim website's; the numbers in `src/workflowScript.ts` come from the 2026-09-18 trailhead race (SDK 58 preview.3, Xcode 27).
