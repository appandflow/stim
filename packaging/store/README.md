# Release asset preparation

This package tracks iOS App Store readiness. It contains existing production
icons, English metadata drafts and a screenshot capture inventory. The Mac App
Store plan was dropped; retained Desktop assets are reference material for its
existing Developer ID delivery. This is not a submission package yet. Issue [#2383](https://github.com/appandflow/stim/issues/2383)
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
2880 x 1800 for the retained Desktop reference. Only the iPhone and iPad sets
are part of the current store preparation. These are accepted options in Apple's
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

| Item                      | Current evidence                                                                                                     | Remaining work                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| iOS identity and branding | Production `com.appandflow.stim`; existing 1024 x 1024 RGB icon                                                      | Review final candidate's compiled icon and metadata                                                                                       |
| iPhone and iPad scenes    | Capture inventory prepared                                                                                           | Capture, inspect and approve release-candidate screens at the listed dimensions                                                           |
| English metadata          | Drafts in `en-US.json` use the published privacy and support pages                                                   | Approve wording and category against the final release candidate                                                                          |
| Privacy policy            | [Privacy policy](https://stim.appandflow.com/privacy) is published and linked from mobile About                      | Verify the policy against the configured release and approve the App Store privacy answers                                                |
| Crash reporting           | Optional Sentry configuration, scrubbing and capture restrictions are implemented; automatic session tracking is off | Verify production DSN/retention and actual Expo Updates, push and native crash behavior before declaring data collection                  |
| Review access             | [App Review Worker](../../apps/demo-server/README.md) implements fictional data, pairing and simulated Control       | Verify deployment/token configuration and clean TestFlight pairing over cellular; provide credentials privately through App Store Connect |
| iOS distribution          | Existing build/update documentation lives in `apps/mobile/README.md`                                                 | Verify signing, SDK acceptance, privacy manifests and a release build on actual supported hardware; no submission is authorized here      |
| Mac distribution          | Current app ships as Developer ID signed, notarized DMG/zip, documented in `apps/desktop/RELEASING.md`               | Continue the existing delivery; no Mac App Store work is planned here                                                                     |

Apple also requires a
[privacy policy URL and accurate privacy information](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/).
`sendDefaultPii: false` is not evidence that an app collects no data. Inspect
the configured release and SDK behavior; this package leaves that decision
unfilled instead of guessing.

The published [support page](https://stim.appandflow.com/support) includes a
contact route and links to GitHub issues. The support and privacy pages returned
HTTP 200 on November 2, 2026. Reachability does not approve their content or the
release candidate's privacy disclosures.

After the final images are approved, record each capture's candidate commit,
device/OS, dimensions and SHA-256 in the manifest. Keep #2383 open until the
requested assets and readiness evidence are complete.
