#!/bin/sh
set -eu
cd "$(dirname "$0")"

version=${1:?usage: native/fsevents/release.sh <version>}
if ! printf '%s' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' || [ "$(printf '%s' "$version" | wc -l)" -ne 0 ]; then
  echo "release.sh: $version is not a semver version such as 1.2.3 or 1.2.3-rc.1" >&2
  exit 1
fi
identity=${FSEVENTS_SIGNING_IDENTITY:-}
out=build/release
bin=build/stim-fsevents
zip=$out/stim-fsevents-$version.zip

rm -rf build
mkdir -p "$out" build/unzipped
clang -Wall -Wextra -Werror -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -framework CoreServices -o "$bin" stim-fsevents.c

if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --identifier dev.stim.fsevents --sign "$identity" "$bin"
else
  echo "release.sh: FSEVENTS_SIGNING_IDENTITY is not set, so this build is signed ad hoc and is not notarized. Use it for testing only." >&2
  codesign --force --options runtime --identifier dev.stim.fsevents --sign - "$bin"
fi
codesign --verify --strict "$bin"
ditto -c -k --norsrc --noextattr --noqtn "$bin" "$zip"

if [ -n "$identity" ] && [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  result=build/notary.json
  xcrun notarytool submit "$zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
    --wait --timeout 1h --output-format json >"$result" || true
  status=$(plutil -extract status raw -o - "$result")
  if [ "$status" != Accepted ]; then
    id=$(plutil -extract id raw -o - "$result")
    echo "release.sh: notarization ended with status $status" >&2
    xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2
    exit 1
  fi
  rm "$result"
elif [ -n "$identity" ]; then
  echo "release.sh: ASC_KEY_PATH, ASC_KEY_ID or ASC_ISSUER_ID is not set, so this build is not notarized." >&2
fi

ditto -x -k "$zip" build/unzipped
cmp "$bin" build/unzipped/stim-fsevents
(cd "$out" && shasum -a 256 "stim-fsevents-$version.zip" >SHA256SUMS)
(cd build/unzipped && shasum -a 256 stim-fsevents >>"../../$out/SHA256SUMS")
echo "$PWD/$out"
