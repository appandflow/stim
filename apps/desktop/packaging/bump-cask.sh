#!/bin/sh
set -eu

version=${1:?usage: packaging/bump-cask.sh <version> [output]}
out=${2:-/dev/stdout}
dmg=Stim-$version.dmg
sums=$(curl -fsSL "https://github.com/appandflow/stim/releases/download/desktop-v$version/SHA256SUMS")
sha=$(printf '%s\n' "$sums" | awk -v f="$dmg" '$2 == f { print $1 }')
if ! printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "bump-cask.sh: the desktop-v$version release lists no SHA-256 for $dmg" >&2
  exit 1
fi
sed -e "s/@VERSION@/$version/" -e "s/@SHA256@/$sha/" "$(dirname "$0")/Casks/stim.rb" >"$out"
