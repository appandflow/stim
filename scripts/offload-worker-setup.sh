#!/bin/bash
# Prototype (appandflow/stim#1780): installs this checkout's built Stim on an SSH build worker under
# <root> (default ~/stim-offload), pins the worker's CocoaPods to this Mac's version, and writes
# ~/.stim-offload.env, which points every worker write (repos, STIM_HOME, gems, CocoaPods and pnpm
# caches) at <root>.
# Usage: scripts/offload-worker-setup.sh <ssh-host> [<absolute root on the worker>]
set -euo pipefail
host="$1"
root="${2:-}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
pack="$(mktemp -d)"
trap 'rm -rf "$pack"' EXIT
for pkg in core cache metro stim-cli; do
  (cd "$repo/packages/$pkg" && pnpm pack --pack-destination "$pack" >/dev/null)
done
pods="$(LANG=en_US.UTF-8 pod --version | tail -1)"
jdk="$(sed -n 's/^JAVA_VERSION="\([0-9]*\).*/\1/p' "${JAVA_HOME:-$(/usr/libexec/java_home)}/release")"
[ -n "$root" ] || root="$(ssh -o BatchMode=yes "$host" 'echo $HOME')/stim-offload"
ssh -o BatchMode=yes "$host" "rm -rf '$root/pkgs' && mkdir -p '$root/pkgs' '$root/stim' '$root/home' '$root/gems'"
scp -q "$pack"/*.tgz "$host:$root/pkgs/"
ssh -o BatchMode=yes "$host" "zsh -l -s -- '$root' '$pods' '$jdk'" <<'REMOTE'
set -e
root="$1"; pods="$2"; jdk="$3"
java_home=""
for candidate in "$(/usr/libexec/java_home -v "$jdk" 2>/dev/null)" \
  "/opt/homebrew/opt/openjdk@$jdk/libexec/openjdk.jdk/Contents/Home" \
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
  [ -n "$candidate" ] && [ -f "$candidate/release" ] && grep -q "^JAVA_VERSION=\"${jdk}[.\"]" "$candidate/release" && { java_home="$candidate"; break; }
done
[ -n "$java_home" ] || echo "warning: no JDK $jdk on the worker; Android offload stays refused"
cat > ~/.stim-offload.env.tmp <<ENV
export STIM_OFFLOAD_ROOT="$root"
export STIM_HOME="$root/home"
export GEM_HOME="$root/gems"
export GEM_PATH="$root/gems"
export PATH="$root/gems/bin:\$PATH"
export CP_HOME_DIR="$root/cocoapods"
export CP_CACHE_DIR="$root/cocoapods-cache"
export npm_config_store_dir="$root/pnpm-store"
export pnpm_config_store_dir="$root/pnpm-store"
export npm_config_cache="$root/npm-cache"
export GRADLE_USER_HOME="$root/gradle"
export CCACHE_DIR="$root/ccache"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ENV
[ -z "$java_home" ] || printf 'export JAVA_HOME="%s"\n' "$java_home" >> ~/.stim-offload.env.tmp
mv ~/.stim-offload.env.tmp ~/.stim-offload.env
source ~/.stim-offload.env
cd "$root/stim"
[ -f package.json ] || echo '{"private":true}' > package.json
npm install --no-audit --no-fund --silent "$root"/pkgs/*.tgz
pod --version 2>/dev/null | grep -qx "$pods" || gem install cocoapods -v "$pods" --no-document --silent
echo "worker root $root, JAVA_HOME ${JAVA_HOME:-none}, stim $(node -p 'require("./node_modules/stim/package.json").version'), pod $(pod --version 2>/dev/null | tail -1)"
REMOTE
