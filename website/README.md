# Stim documentation website

The Docusaurus source for [stim.appandflow.com](https://stim.appandflow.com/).

The website is the primary human documentation. Package README files stay
short and link here to avoid duplicate guidance.

```bash
pnpm install
pnpm start
pnpm build
```

GitHub Pages deploys the site from `main` through `.github/workflows/docs.yml`.

## Branding prototype

The theme and landing page follow the [Stim branding board](https://www.figma.com/design/ENnvWM98Hb0S1jk43T1tx7?node-id=8426-8348)
and [landing page reference](https://www.figma.com/design/ENnvWM98Hb0S1jk43T1tx7?node-id=8426-12140).
The Figma SVG exports, optimized with ImageOptim, live in `static/img/branding`.
The 1200x630 social card that `themeConfig.image` serves as the `og:image` is the Figma PNG export
`static/img/branding/social-card.png`; re-export it there when the tagline or artwork changes. Inter and JetBrains Mono
are bundled with their licenses in `src/css/fonts`.

The reference uses GT Maru Trial Bold for the hero. This prototype uses Inter Bold
until a GT Maru webfont is available; `--stim-font-heading` controls the heading family.
The landing page keeps the white canvas from the reference. Documentation supports
both light and dark themes, with light as the default.

## Benchmark video

The benchmark replay and the other stim videos are rendered from a separate
Remotion project, `stim-video`, kept outside this repository. Its
`render:benchmark` script reads the published benchmark JSON and proof assets
from this `website/` directory and writes the MP4s and poster back into
`static/benchmarks/`; commit those generated files here like any other asset.
