#!/bin/sh
set -eu
cd "$(dirname "$0")"

version=${1:?usage: host/release.sh <version>}
if ! printf '%s' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?'; then
  echo "release.sh: $version is not a semver version such as 1.2.3 or 1.2.3-rc.1" >&2
  exit 1
fi
identity=${HOST_SIGNING_IDENTITY:-}
build_number=$(git rev-list --count HEAD)
out=build/release
app="build/Stim Host.app"
zip=$out/StimHost-$version.zip

rm -rf build
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$out"
clang -Wall -Wextra -Werror -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -framework ApplicationServices -framework CoreGraphics -o "$app/Contents/MacOS/stim-host" stim-host.c
cp Info.plist "$app/Contents/Info.plist"
cp ../../../apps/desktop/Support/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" -c "Set :CFBundleVersion $build_number" \
  -c "Add :CFBundleIconFile string AppIcon" "$app/Contents/Info.plist"

if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
else
  echo "release.sh: HOST_SIGNING_IDENTITY is not set, so this build is signed ad hoc and is not notarized. Use it for testing only." >&2
  codesign --force --options runtime --sign - "$app"
fi
codesign --verify --strict --deep "$app"

if [ -n "$identity" ] && [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  ditto -c -k --keepParent "$app" "$out/notarize.zip"
  result=$out/notary.json
  xcrun notarytool submit "$out/notarize.zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
    --wait --timeout 1h --output-format json >"$result" || true
  status=$(plutil -extract status raw -o - "$result")
  if [ "$status" != Accepted ]; then
    id=$(plutil -extract id raw -o - "$result")
    echo "release.sh: notarization ended with status $status" >&2
    xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2
    exit 1
  fi
  rm "$out/notarize.zip" "$result"
  xcrun stapler staple "$app"
  spctl --assess --type execute --verbose=2 "$app"
elif [ -n "$identity" ]; then
  echo "release.sh: ASC_KEY_PATH, ASC_KEY_ID or ASC_ISSUER_ID is not set, so this build is not notarized." >&2
fi

ditto -c -k --keepParent "$app" "$zip"
(cd "$out" && shasum -a 256 "StimHost-$version.zip" >SHA256SUMS)
echo "$PWD/$out"
