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
2. Wait for the Desktop workflow to pass on the `main` commit you are
   releasing. It builds the same ad-hoc release package on every change to
   `apps/desktop`.
3. Tag that commit and push the tag:

   ```bash
   git tag -a desktop-v1.2.0 -m "Stim Desktop 1.2.0"
   git push origin desktop-v1.2.0
   ```

4. Approve the `Desktop release` run in the `release` environment, as for the
   npm release.

The workflow, `.github/workflows/desktop-release.yml`:

1. Imports the Developer ID certificate into a temporary keychain and writes the
   App Store Connect API key to a temporary file.
2. Runs `apps/desktop/scripts/release.sh <version>`, which builds, signs,
   notarizes and staples the app, then writes `Stim-<version>.dmg`,
   `Stim-<version>.zip` and `SHA256SUMS` to `apps/desktop/build/release`.
3. Signs the zip with the Sparkle EdDSA key and writes `appcast.xml`.
4. Uploads everything as a workflow artifact.
5. Creates the `desktop-v<version>` GitHub release, never marked as the
   repository's latest release, and attaches the DMG, the zip and
   `SHA256SUMS`. A version with a prerelease suffix is marked as a prerelease.
6. For a stable version only: uploads `Stim.dmg` and `appcast.xml` to the
   `desktop-latest` release and bumps the Homebrew cask.
7. Deletes the keychain and the key file.

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

## Dry run

Run the workflow from the Actions tab or with:

```bash
gh workflow run desktop-release.yml -f version=0.0.0
```

A dispatched run needs the same `release` approval, builds with whatever
secrets are set, uploads the artifact and publishes nothing. Without secrets,
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
- `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`: an App Store Connect API key
  file and its IDs.
- `SPARKLE_PUBLIC_ED_KEY`, when the app embeds Sparkle: the public half of the
  update signing key, written into `SUPublicEDKey`.

`CFBundleShortVersionString` is the version you pass. `CFBundleVersion` is the
commit count of `HEAD`, which grows with every release and is the value Sparkle
compares, so a release needs full history (the workflow checks out with
`fetch-depth: 0`).

## Signing and entitlements

`release.sh` signs inside out with `--options runtime --timestamp`:
`Lottie.framework`, then `sim-fold`, then the app, then the DMG.

A Developer ID build carries no entitlements. Hardened Runtime's library
validation accepts code signed by Apple or by the app's own team, and Xcode's
CoreSimulator and SimulatorKit are signed by Apple, so the app loads them
without `com.apple.security.cs.disable-library-validation`. `Lottie.framework`
is re-signed with the app's identity.

An ad-hoc build has no team ID, so library validation would reject the ad-hoc
signed `Lottie.framework`. It signs the app with `Support/adhoc.entitlements`,
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
only approved runs can read them. Each group is optional; a missing group skips
its step with a notice, and a partly set group fails the run.

| Name                      | Kind     | Content                                                                              |
| ------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `DESKTOP_CERT_P12_BASE64` | secret   | `base64 -i cert.p12` of the Developer ID Application certificate and its private key |
| `DESKTOP_CERT_PASSWORD`   | secret   | The password of that `.p12`                                                          |
| `ASC_KEY_P8_BASE64`       | secret   | `base64 -i AuthKey_<id>.p8` of an App Store Connect API key                          |
| `ASC_KEY_ID`              | secret   | That key's ID                                                                        |
| `ASC_ISSUER_ID`           | secret   | The issuer ID shown above the keys list in App Store Connect                         |
| `SPARKLE_ED_PRIVATE_KEY`  | secret   | The private EdDSA key from Sparkle's `generate_keys -x <file>`                       |
| `SPARKLE_PUBLIC_ED_KEY`   | variable | The matching public key that `generate_keys` prints                                  |
| `HOMEBREW_TAP_TOKEN`      | secret   | A fine-grained token with Contents read and write on `appandflow/homebrew-tap` only  |

### Apple artifacts

- A **Developer ID Application** certificate for the App&Flow team, created by
  the Account Holder in Certificates, Identifiers & Profiles. Export it with its
  private key from Keychain Access as a `.p12` with a password.
- An **App Store Connect API key** with the Developer role (Users and Access >
  Integrations > App Store Connect API > Team Keys). Apple lets you download the
  `.p8` once.

No provisioning profile, App ID or Mac App Store record is needed.

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
`HOMEBREW_TAP_TOKEN` is set.

## Troubleshooting

- `codesign` reports `unable to build chain to self-signed root`: the runner is
  missing the Developer ID intermediate certificate. Export the `.p12` with the
  certificate chain, or import `DeveloperIDG2CA.cer` from
  [Apple's certificate authority page](https://www.apple.com/certificateauthority/)
  into the temporary keychain.
- Notarization ends with `Invalid`: `release.sh` prints the notary log, which
  names each rejected file.
