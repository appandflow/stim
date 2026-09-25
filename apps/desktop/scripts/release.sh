#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

version=${1:?usage: scripts/release.sh <version>}
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "release.sh: $version is not a semver version such as 1.2.3 or 1.2.3-rc.1" >&2
  exit 1
fi
identity=${DESKTOP_SIGNING_IDENTITY:-}
build_number=$(git rev-list --count HEAD)
out=build/release
app=build/Stim.app
dmg=$out/Stim-$version.dmg
zip=$out/Stim-$version.zip

./scripts/bundle.sh --universal >/dev/null
rm -rf "$out"
mkdir -p "$out"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" -c "Set :CFBundleVersion $build_number" \
  "$app/Contents/Info.plist"

if [ -n "$identity" ]; then
  sign() { codesign --force --options runtime --timestamp --sign "$identity" "$@"; }
  app_entitlements=
else
  echo "release.sh: DESKTOP_SIGNING_IDENTITY is not set, so this build is signed ad hoc and is not notarized. Use it for testing only." >&2
  sign() { codesign --force --options runtime --sign - "$@"; }
  app_entitlements="--entitlements Support/adhoc.entitlements"
fi
sign "$app/Contents/Frameworks/Lottie.framework"
sign --entitlements Support/SimFold/runtime.entitlements "$app/Contents/Resources/sim-fold"
sign $app_entitlements "$app"
codesign --verify --strict --deep "$app"

notarize=
if [ -n "$identity" ] && [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  notarize=1
elif [ -n "$identity" ]; then
  echo "release.sh: ASC_KEY_PATH, ASC_KEY_ID or ASC_ISSUER_ID is not set, so this build is not notarized." >&2
fi

submit() {
  result=$out/notary-$(basename "$1").json
  xcrun notarytool submit "$1" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
    --wait --timeout 1h --output-format json >"$result" || true
  status=$(plutil -extract status raw -o - "$result")
  if [ "$status" != Accepted ]; then
    id=$(plutil -extract id raw -o - "$result")
    echo "release.sh: notarization of $1 ended with status $status" >&2
    xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2
    exit 1
  fi
}

if [ -n "$notarize" ]; then
  ditto -c -k --keepParent "$app" "$out/notarize.zip"
  submit "$out/notarize.zip"
  rm "$out/notarize.zip"
  xcrun stapler staple "$app"
  spctl --assess --type execute --verbose=2 "$app"
fi
ditto -c -k --keepParent "$app" "$zip"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Stim.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname Stim -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
if [ -n "$identity" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi
if [ -n "$notarize" ]; then
  submit "$dmg"
  xcrun stapler staple "$dmg"
fi

(cd "$out" && shasum -a 256 "Stim-$version.dmg" "Stim-$version.zip" >SHA256SUMS)
if [ -n "$notarize" ]; then
  echo "release.sh: Stim $version ($build_number) is signed and notarized." >&2
elif [ -n "$identity" ]; then
  echo "release.sh: Stim $version ($build_number) is signed with Developer ID and not notarized." >&2
else
  echo "release.sh: Stim $version ($build_number) is signed ad hoc and not notarized." >&2
fi
echo "$PWD/$out"
