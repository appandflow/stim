# Releasing Stim Desktop

Stim Desktop ships outside the Mac App Store. It loads Xcode's private
CoreSimulator and SimulatorKit frameworks and bundles the `sim-fold` simulator
helper, which the App Store does not allow. A release is a Developer ID signed,
notarized universal app (arm64 and x86_64), published as a DMG for people and a
zip for Sparkle updates on a GitHub release tagged `desktop-v<semver>`. These
tags are separate from the npm packages' `v*` tags, which follow
[RELEASE.md](../../RELEASE.md).

## Cut a release

1. Pick the version. Stable versions look like `1.2.0`; release candidates look
   like `1.2.0-rc.1`.
2. Cut the Desktop release right after an npm release publishes, at the same
   commit. Find that commit with `git rev-list -n 1 v<npm-version>`. An npm
   release commit changes no path the Desktop workflow watches, so no Desktop
   run exists for it; the `Desktop release` run builds the app before it loads
   any secret.
3. Tag that commit and push the tag:

   ```bash
   git tag -a desktop-v1.2.0 -m "Stim Desktop 1.2.0" "$(git rev-list -n 1 v1.25.0)"
   git push origin desktop-v1.2.0
   ```

4. The `Desktop release` run starts in the `release` environment. That
   environment has no required reviewers for now, so it needs no approval.

Tag without waiting for a `Desktop next` run. The two workflows build, sign and
notarize in parallel and take turns only for the few seconds that each `publish`
job writes the `desktop-latest` appcast (see [Appcast publish](#appcast-publish)),
so a next build in progress never delays or overwrites a release.

The app carries no server or Node. It embeds `StimEngineVersion`, the published
`stim` it installs or moves the Stim engine to: `stim@latest` for a stable tag,
`stim@next` for a prerelease tag, read when the workflow runs. Tag after the npm
release the Desktop needs is published. A `Desktop next` build embeds `stim@next`
and publishes only once that version is built from the Desktop commit or a later
one (its version names the commit); until then the hourly run skips it, and a
`next` publish that changes `desktopApi` dispatches it.

The workflow, `.github/workflows/desktop-release.yml`:

1. Checks that the tag is on `main` and builds the app before loading any
   secret. It then imports the Developer ID certificate into a temporary
   keychain and writes the App Store Connect API key to a temporary file.
2. Runs `apps/desktop/scripts/release.sh <version>`, which builds, signs,
   notarizes and staples the app, then writes `Stim-<version>.dmg`,
   `Stim-<version>.zip` and `SHA256SUMS` to `apps/desktop/build/release`.
3. Signs the zip with the Sparkle EdDSA key and writes the appcast item.
4. Uploads everything as a workflow artifact.
5. Creates the `desktop-v<version>` GitHub release, never marked as the
   repository's latest release, and attaches the DMG, the zip and
   `SHA256SUMS`. A version with a prerelease suffix is marked as a prerelease.
6. Deletes the keychain and the key file. This ends the macOS `release` job.
7. For a stable version only, in the Linux `publish` job and unless
   `desktop-latest` already serves a newer build: uploads `Stim.dmg` to the
   `desktop-latest` release, replaces the stable item of its `appcast.xml`
   while keeping the [next channel](#next-channel) items that are newer, and
   bumps the Homebrew cask. The job downloads the artifact of step 4 and holds
   the `desktop-appcast` group described in [Appcast publish](#appcast-publish).

A tag push stops before step 5 when the build is not Developer ID signed and
notarized, after the artifact upload. Re-running the job after adding the
secrets is safe: an existing release gets its assets replaced.

### Stable download links

GitHub's `releases/latest` link points at the newest npm release, so the
desktop app keeps its own stable release, `desktop-latest`. The workflow
replaces its assets on every stable release:

- `https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg`
- `https://github.com/appandflow/stim/releases/download/desktop-latest/appcast.xml`,
  the Sparkle feed the app's `SUFeedURL` names.

The `desktop-latest` tag stays on the commit of the first stable release; its
notes name the release its assets came from.

## Next channel

Every merge to `main` that changes Desktop also publishes a notarized prerelease on the Sparkle `next`
channel, so testers get Desktop changes without waiting for a `desktop-v*` tag. The `Desktop next` workflow,
`.github/workflows/desktop-next.yml`, runs the same build steps as the stable workflow through the shared
composite action `.github/actions/desktop-build`.

- **Trigger.** A push to `main` that changes `apps/desktop/**`, the composite action or the workflow. An
  hourly schedule is the safety net, and Actions -> Desktop next -> Run workflow with `publish` set on
  `main` builds the head without waiting for the throttle. Every run first checks that Desktop changed
  since the newest published build, the newest stable tag or the newest next item in the appcast, whichever
  is later, so a run with no Desktop change builds nothing. It builds the head of `main` at the time it runs,
  once that head passed the merge queue's `merge gate`, or the CI release-gate jobs for a push that
  bypassed the queue, and skips a head that is already in the appcast.
- **Throttle.** A cheap Linux job waits until 30 minutes (`DESKTOP_NEXT_THROTTLE_MINUTES`) after the newest
  next prerelease was published, then the macOS job builds whatever is the head of `main` then. GitHub keeps
  one run active and one pending under the workflow's own concurrency group, so a burst of merges queues at
  most one build, and a pending stable release is never replaced because the stable workflow has another
  group. Next builds never hold a stable release. The notarization of a build takes minutes of a macOS runner, which is the cost of each build.
- **Version.** `<next minor of the newest stable desktop-v tag>-next.<UTC commit time>.g<short sha>`, so
  `0.3.0-next.20261103170000.gabc1234` while `0.2.16` is the newest stable release. `CFBundleVersion` is the
  commit count of the built head, which is above the stable build tagged before it, so Sparkle ranks the
  prerelease above that stable build and a later stable release above the prerelease.
- **Publish.** The macOS `build` job creates the GitHub prerelease `desktop-next-<version>` (marked
  prerelease, never the repository's latest) with the DMG, the zip and `SHA256SUMS`. The Linux `publish` job
  then adds an item with
  `<sparkle:channel>next</sparkle:channel>` to the appcast on `desktop-latest`. It never changes the stable
  item, `Stim.dmg` or the Homebrew cask. The tag does not start with `desktop-v`, so the repository's
  `release tags` ruleset, which forbids deleting `desktop-v*` tags, does not apply to it and the job can
  delete old ones. A build that is not Developer ID signed and notarized, or has no appcast item, publishes
  nothing.
- **Pruning.** The appcast keeps the newest five next items (`DESKTOP_NEXT_KEEP`), dropping those a stable
  release supersedes, and the job deletes older `desktop-next-*` prereleases and their tags.
  `scripts/desktop-appcast.mjs` does the merge for both workflows, so a stable release keeps the next items
  that are still newer than it. `scripts/desktop-publish-appcast.sh` uploads the merged file and merges again
  when another run replaced the appcast in between; [Appcast publish](#appcast-publish) keeps two runs from
  doing that at the same time.
- **In the app.** Sparkle offers a `next` item only to a build that returns `next` from
  `allowedChannels(for:)`: **Settings > App > Updates > Get prerelease updates**, off by default and on for a
  build whose version contains `-next.`. A stable build with it off never sees one. Turning it off keeps the
  installed prerelease until a newer stable release. A prerelease is a candidate only for a build with a
  lower commit count, so a stable release tagged at a commit older than the newest next build is not offered
  to builds on the channel until a newer item appears.
- **Engine version.** A next build embeds `stim@next` as `StimEngineVersion` and is built only once that
  version names the Desktop commit or a later one. While `next` carries a release candidate, whose version
  names no commit, the workflow skips with a notice.
- **Pause.** `gh variable set DESKTOP_NEXT_PAUSED --body true` skips the workflow until
  `gh variable delete DESKTOP_NEXT_PAUSED`.
- **Dry run.** Dispatching the workflow on `main` with `publish` off builds the head with the `release`
  environment's secrets and publishes nothing. The environment only runs `main` and the release tags, so
  another branch cannot start it.

## Appcast publish

`desktop-latest` carries one `appcast.xml` that both workflows edit: a stable release replaces the stable
item and a next build adds a `next` item. Each workflow ends with a `publish` job that downloads the build
artifact, reads the served appcast, merges its item and uploads the result. Both `publish` jobs run in the
concurrency group `desktop-appcast` with `cancel-in-progress: false`, so the read-merge-upload steps take
turns while the builds, signing and notarization of the two workflows run in parallel. Each job merges onto
the result of the one before it, and `scripts/desktop-publish-appcast.sh` still merges again when something
else replaced the file, refuses a merged appcast without a stable item and refuses to continue when it
cannot list the release.

GitHub keeps one running and one pending job per group and cancels an older pending job when a newer one
queues. That cannot drop a stable publish: each workflow's own group (`desktop-release`, `desktop-next`)
starts a run only after the previous run of that workflow finished, so `desktop-appcast` never holds more
than one stable and one next `publish` job. Dispatched dry runs skip `publish`. Do not add another job to
the group, and re-run a failed `publish` job only while no other Desktop run is publishing. A failed
`publish` job needs "Re-run failed jobs", not a new build or tag: the artifact is kept for the default retention for
a stable release and 7 days for a next build.

## Dry run

Run the workflow from the Actions tab or with:

```bash
gh workflow run desktop-release.yml -f version=0.0.0
```

A dispatched run builds with whatever secrets are set, uploads the artifact
and publishes nothing. It runs the workflow and scripts of the branch it was
dispatched on with the real secrets, so the `release` environment's deployment
branches stay restricted to `main` and the release tags. Without secrets,
it produces an ad-hoc signed build and prints a notice for each skipped step.

## Build locally

```bash
apps/desktop/scripts/release.sh 1.2.0
```

Without `DESKTOP_SIGNING_IDENTITY`, the script signs ad hoc and says so. The
result runs on the machine that built it or after removing the quarantine
attribute, and cannot be notarized. To sign and notarize locally, set:

- `DESKTOP_SIGNING_IDENTITY`: the name or SHA-1 of a `Developer ID Application`
  identity in your keychain.
- `DESKTOP_PROVISIONING_PROFILE`: the path to a Developer ID provisioning
  profile for `dev.stim.desktop` with Associated Domains enabled, using that
  signing certificate.
- `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`: an App Store Connect API key
  file and its IDs.
- `SPARKLE_PUBLIC_ED_KEY`: the public half of the update signing key, which
  `bundle.sh` writes into `SUPublicEDKey`. Without it, the app never checks for
  updates.
- `STIM_DESKTOP_SENTRY_DSN`, and `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
  `SENTRY_PROJECT` with `sentry-cli` on `PATH`: crash reporting and the dSYM
  upload; see [Crash reports](./README.md#crash-reports).

`CFBundleShortVersionString` is the version you pass. `CFBundleVersion` is the
commit count of `HEAD`, the value Sparkle compares. Release tags must be on
`main`, where the count grows with every commit, and the count needs full
history (the workflow checks out with `fetch-depth: 0`).

## Signing and entitlements

`release.sh` signs inside out with `--options runtime --timestamp`:
`Lottie.framework`; Sparkle's `Installer.xpc`, `Downloader.xpc` (keeping its
entitlements), `Autoupdate`, `Updater.app` and `Sparkle.framework`, in the
order [Sparkle documents](https://sparkle-project.org/documentation/sandboxing/#code-signing);
`sim-fold`; the app; then the DMG. Notarization covers the nested binaries with
the rest of the app, so a rejected one fails `release.sh`'s `notarytool` step and
the log names it.

A Developer ID build signs the app with `Support/app.entitlements`, including
`applinks:stim.appandflow.com` and the application identifier
`R7E8P23K3N.dev.stim.desktop`. Its provisioning profile is embedded at
`Contents/embedded.provisionprofile`. Hardened Runtime's library
validation accepts code signed by Apple or by the app's own team, and Xcode's
CoreSimulator and SimulatorKit are signed by Apple, so the app loads them
without `com.apple.security.cs.disable-library-validation`. `Lottie.framework`
and `Sparkle.framework` are re-signed with the app's identity.

An ad-hoc build has no team ID, so library validation would reject its ad-hoc
signed frameworks. It signs the app with `Support/adhoc.entitlements`,
which disables library validation, so the test build still runs with Hardened
Runtime on.

`sim-fold` is an iOS Simulator executable, signed with
`Support/SimFold/runtime.entitlements`. `simctl spawn` starts it with
`DYLD_ROOT_PATH` pointing at the simulator runtime, and Hardened Runtime drops
`DYLD_` variables unless the binary carries
`com.apple.security.cs.allow-dyld-environment-variables`; without it, dyld
aborts with `DYLD_ROOT_PATH not set for simulator program`. Its
`com.apple.springboard.sbdisplay.service` entitlement lives in its
`__TEXT,__entitlements` section, which the simulator reads and re-signing
keeps. Check the first notarization log for a complaint about this binary.

## Secrets and variables

Set these on the `release` environment (Settings > Environments > release), so
only runs on its deployment branches and tags can read them. Signing requires both certificate secrets
and `DESKTOP_PROVISIONING_PROFILE_BASE64`; without a certificate the build
remains ad hoc. Other missing groups skip their step with a notice, and a
partly set group fails the run. The Sentry dSYM
upload runs only when `SENTRY_AUTH_TOKEN` is set, and then needs `SENTRY_ORG`
and `SENTRY_DESKTOP_PROJECT`.

| Name                                  | Kind     | Content                                                                                                |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `DESKTOP_CERT_P12_BASE64`             | secret   | `base64 -i cert.p12` of the Developer ID Application certificate and its private key                   |
| `DESKTOP_CERT_PASSWORD`               | secret   | The password of that `.p12`                                                                            |
| `DESKTOP_PROVISIONING_PROFILE_BASE64` | secret   | Base64 of the Developer ID provisioning profile for `dev.stim.desktop` with Associated Domains enabled |
| `ASC_KEY_P8_BASE64`                   | secret   | `base64 -i AuthKey_<id>.p8` of an App Store Connect API key                                            |
| `ASC_KEY_ID`                          | secret   | That key's ID                                                                                          |
| `ASC_ISSUER_ID`                       | secret   | The issuer ID shown above the keys list in App Store Connect                                           |
| `SPARKLE_ED_PRIVATE_KEY`              | secret   | The private EdDSA key from Sparkle's `generate_keys -x <file>`                                         |
| `SPARKLE_PUBLIC_ED_KEY`               | variable | The matching public key that `generate_keys` prints                                                    |
| `STIM_DESKTOP_SENTRY_DSN`             | variable | The Sentry project's DSN; unset builds report no crashes                                               |
| `SENTRY_AUTH_TOKEN`                   | secret   | A Sentry organization auth token, used only for the dSYM upload                                        |
| `SENTRY_ORG`                          | variable | The Sentry organization slug                                                                           |
| `SENTRY_DESKTOP_PROJECT`              | variable | The Desktop Sentry project slug; the workflow passes it to `bundle.sh` as `SENTRY_PROJECT`             |
| `HOMEBREW_TAP_DEPLOY_KEY`             | secret   | The private half of a write deploy key on `appandflow/homebrew-tap`                                    |

### Apple artifacts

- A **Developer ID Application** certificate for the App&Flow team, created by
  the Account Holder in Certificates, Identifiers & Profiles. Export it with its
  private key from Keychain Access as a `.p12` with a password.
- An **App Store Connect API key** with the Developer role (Users and Access >
  Integrations > App Store Connect API > Team Keys). Apple lets you download the
  `.p8` once.

Create or edit the explicit App ID `dev.stim.desktop` on team `R7E8P23K3N`
in Apple Developer's Certificates, Identifiers & Profiles. Enable Associated
Domains, then generate a Developer ID provisioning profile using the same
Developer ID Application certificate as the release workflow. Download the
profile and put its base64 contents in `DESKTOP_PROVISIONING_PROFILE_BASE64`
on the GitHub `release` environment:

```sh
base64 -i /path/to/Stim-Desktop.provisionprofile | pbcopy
```

The profile contains Apple-signed app identifiers, entitlements and public
certificate information, not the private signing key. The Actions secret
supplies it to the workflow without committing it; base64 is only encoding.
No Mac App Store record is needed. Apple's
[Associated Domains documentation](https://developer.apple.com/documentation/Xcode/supporting-associated-domains)
describes the matching app entitlement and website association.

### Sparkle key

Generate the key pair once with Sparkle's `generate_keys` from the
[Sparkle release](https://github.com/sparkle-project/Sparkle/releases) and
export the private key with `generate_keys -x <file>`. Losing it means shipped
apps can no longer verify updates.

## Homebrew

`packaging/Casks/stim.rb` is the cask template for the
`appandflow/homebrew-tap` repository, installed with
`brew install --cask appandflow/tap/stim`. `packaging/bump-cask.sh <version>
[output]` fills in the version and the DMG's SHA-256 from the release's
`SHA256SUMS`. The workflow runs it and pushes `Casks/stim.rb` to the tap when
`HOMEBREW_TAP_DEPLOY_KEY` is set. The key is an SSH deploy key with write
access to that repository only; rotate it with `gh repo deploy-key` on the tap.

## Troubleshooting

- `codesign` reports `unable to build chain to self-signed root`: the runner is
  missing the Developer ID intermediate certificate. Export the `.p12` with the
  certificate chain, or import `DeveloperIDG2CA.cer` from
  [Apple's certificate authority page](https://www.apple.com/certificateauthority/)
  into the temporary keychain.
- Notarization ends with `Invalid`: `release.sh` prints the notary log, which
  names each rejected file.
