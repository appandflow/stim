#!/bin/bash
# Adds one Sparkle item to the appcast on the desktop-latest release and checks that the merged file is still
# served afterwards. Another run's upload can replace the file between the download and the upload, so a
# lost update is merged again.
# usage: scripts/desktop-publish-appcast.sh <item.xml> <merged-appcast-output>
# environment: GH_TOKEN, GH_REPO, APPCAST_URL, optional DESKTOP_NEXT_KEEP
set -euo pipefail

item=${1:?usage: desktop-publish-appcast.sh <item.xml> <merged-appcast-output>}
output=${2:?usage: desktop-publish-appcast.sh <item.xml> <merged-appcast-output>}
: "${GH_REPO:?}" "${APPCAST_URL:?}"
script="$(dirname "$0")/desktop-appcast.mjs"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
version=$(sed -n 's|.*<sparkle:shortVersionString>\(.*\)</sparkle:shortVersionString>.*|\1|p' "$item" | head -1)
[ -n "$version" ] || { echo "::error::$item has no sparkle:shortVersionString"; exit 1; }

fetch() {
  local assets
  : > "$1"
  assets=$(gh release view desktop-latest --json assets --jq '.assets[].name') || {
    echo "::error::Could not list the assets of desktop-latest; the appcast is left as it is."
    exit 1
  }
  if grep -qx appcast.xml <<<"$assets"; then
    rm -rf "$dir/download"
    gh release download desktop-latest --pattern appcast.xml --dir "$dir/download"
    mv "$dir/download/appcast.xml" "$1"
  fi
}

for attempt in 1 2 3 4 5; do
  fetch "$dir/current.xml"
  node "$script" merge --current "$dir/current.xml" --item "$item" --link "$APPCAST_URL" \
    --out "$dir/appcast.xml" --keep "${DESKTOP_NEXT_KEEP:-5}"
  if ! node "$script" list --current "$dir/appcast.xml" | cut -f1 | grep -qx stable; then
    echo "::error::The merged appcast has no stable item; not uploading it."
    exit 1
  fi
  gh release upload desktop-latest --clobber "$dir/appcast.xml"
  fetch "$dir/served.xml"
  node "$script" list --current "$dir/appcast.xml" > "$dir/expected.txt"
  node "$script" list --current "$dir/served.xml" > "$dir/served.txt"
  if cmp -s "$dir/expected.txt" "$dir/served.txt"; then
    cp "$dir/served.xml" "$output"
    echo "desktop-latest's appcast.xml serves:"
    cat "$dir/served.txt"
    exit 0
  fi
  echo "::warning::The served appcast differs from the one uploaded after attempt $attempt; another run replaced it. Merging again."
  sleep $((attempt * 5))
done
echo "::error::Could not add $version to the appcast on desktop-latest."
exit 1
