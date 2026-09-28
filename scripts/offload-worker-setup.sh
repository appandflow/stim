#!/bin/bash
# Prototype (appandflow/stim#1780): installs this checkout's built Stim on an SSH build worker under
# ~/stim-offload, and pins the worker's CocoaPods to this Mac's version.
# Usage: scripts/offload-worker-setup.sh <ssh-host>
set -euo pipefail
host="$1"
repo="$(cd "$(dirname "$0")/.." && pwd)"
pack="$(mktemp -d)"
trap 'rm -rf "$pack"' EXIT
for pkg in core cache metro stim-cli; do
  (cd "$repo/packages/$pkg" && pnpm pack --pack-destination "$pack" >/dev/null)
done
pods="$(LANG=en_US.UTF-8 pod --version | tail -1)"
ssh -o BatchMode=yes "$host" 'rm -rf ~/stim-offload/pkgs && mkdir -p ~/stim-offload/pkgs ~/stim-offload/stim ~/stim-offload/home ~/stim-offload/gems'
scp -q "$pack"/*.tgz "$host:stim-offload/pkgs/"
ssh -o BatchMode=yes "$host" "zsh -lc '
set -e
cd ~/stim-offload/stim
[ -f package.json ] || echo \"{\\\"private\\\":true}\" > package.json
npm install --no-audit --no-fund --silent ~/stim-offload/pkgs/*.tgz
if ! GEM_HOME=~/stim-offload/gems GEM_PATH=~/stim-offload/gems ~/stim-offload/gems/bin/pod --version 2>/dev/null | grep -qx $pods; then
  GEM_HOME=~/stim-offload/gems GEM_PATH=~/stim-offload/gems gem install cocoapods -v $pods --no-document --silent
fi
cat > ~/stim-offload/env.sh <<ENV
export GEM_HOME=\\\$HOME/stim-offload/gems
export GEM_PATH=\\\$HOME/stim-offload/gems
export PATH=\\\$HOME/stim-offload/gems/bin:\\\$PATH
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ENV
source ~/stim-offload/env.sh
echo worker stim \$(node -p \"require(\\\"./node_modules/stim/package.json\\\").version\"), pod \$(pod --version 2>/dev/null | tail -1)
'"
