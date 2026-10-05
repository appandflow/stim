# Release asset preparation

This package covers the requested iOS and Mac release preparation. It contains
existing production icons, English metadata drafts and a screenshot capture
inventory. It is not a submission package yet. Issue [#2383](https://github.com/appandflow/stim/issues/2383)
tracks the remaining captures and review.

From the repository root, assemble a durable copy in a new directory:

```sh
node packaging/store/assemble.mjs /absolute/path/to/stim-release-assets
```

The assembler checks the versioned source hashes, iOS icon dimensions and PNG
transparency, and metadata character limits. It copies assets without altering
the app artwork and refuses an existing destination. It does not build, sign,
contact App Store Connect or upload anything. A successful assembly means those
files passed these checks; it does not mean the apps are ready for submission.

Keyword limits use UTF-8 bytes, while the other checked fields use characters,
following Apple's [platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/).

## Screenshots

Capture the scenes in `manifest.json` from the release candidate on owned test
devices, using the regular Stim home and Stim viewer. Use a deterministic demo
repository and app, generic workspace names and a temporary demonstration
pairing. Keep private machine names, paths, project code and pairing tokens out
of the captures. Exercise the actual screen before capturing it; test fixtures,
DEBUG playground windows and altered app screenshots are not release evidence.

The chosen targets are 1320 x 2868 for iPhone, 2064 x 2752 for iPad and
2880 x 1800 for Mac. These are accepted options in Apple's
[screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/),
checked October 4, 2026. Production iOS supports tablets, so the iPad set is
required. Apple accepts one to ten JPEG or PNG screenshots per set without
alpha channels. Keep the first screenshot focused on the workspace overview;
the later ones show devices, logs and notifications. App previews are optional
and are not part of this first package.

The current runtime proof screenshots include development UI, test apps and
sizes outside these primary sets. They remain PR evidence, not finished store
assets. No final screenshots are included in this package.

## Readiness

| Item                      | Current evidence                                                                                                                                          | Remaining work                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| iOS identity and branding | Production `com.appandflow.stim`; existing 1024 x 1024 RGB icon                                                                                           | Review final candidate's compiled icon and metadata                                                                                  |
| iPhone and iPad scenes    | Capture inventory prepared                                                                                                                                | Capture, inspect and approve release-candidate screens at the listed dimensions                                                      |
| English metadata          | Drafts in `en-US.json`; proposed existing website and GitHub issue support links                                                                          | Approve wording, category and working support destination                                                                            |
| Privacy policy            | No policy URL is supplied in this package                                                                                                                 | Publish an accurate policy and expose it inside the app; approve the App Store privacy answers                                       |
| Crash reporting           | Mobile initializes Sentry when bundled with `EXPO_PUBLIC_SENTRY_DSN`; scrubbing and capture restrictions are in `src/lib/sentry.ts` and `sentry-scrub.ts` | Audit the actual production build, Expo updates, push and crash dependencies before declaring data collection                        |
| Review access             | Pairing needs a reachable Mac running Stim Desktop/stim-server                                                                                            | Arrange a temporary review Mac and provide private instructions through App Store Connect                                            |
| iOS distribution          | Existing build/update documentation lives in `apps/mobile/README.md`                                                                                      | Verify signing, SDK acceptance, privacy manifests and a release build on actual supported hardware; no submission is authorized here |
| Mac distribution          | Current app ships as Developer ID signed, notarized DMG/zip, documented in `apps/desktop/RELEASING.md`                                                    | Use that existing release path for the full desktop app; a Mac App Store variant needs a separate product and implementation plan    |

Current Desktop loads Xcode private CoreSimulator/SimulatorKit APIs, runs local
tools and uses Sparkle for updates. Its release documentation explicitly
chooses distribution outside the Mac App Store. Apple's
[review guidelines](https://developer.apple.com/app-store/review/guidelines/)
require public APIs (2.5.1), appropriate sandboxing and App Store updates for
Mac App Store apps (2.4.5). This is a concrete architecture gap, not a claim
that uploading different assets makes the current desktop binary eligible.
Do not remove these features or change distribution as part of asset work.

Apple also requires a
[privacy policy URL and accurate privacy information](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/).
`sendDefaultPii: false` is not evidence that an app collects no data. Inspect
the configured release and SDK behavior; this package leaves that decision
unfilled instead of guessing.

The proposed GitHub support URL is a draft. Apple's platform version guidance
requires the final support website to include contact information; approve or
replace that destination before submission.

After the final images are approved, record each capture's candidate commit,
device/OS, dimensions and SHA-256 in the manifest. Keep #2383 open until the
requested assets and readiness evidence are complete.
