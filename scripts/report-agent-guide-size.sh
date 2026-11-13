#!/usr/bin/env bash
set -euo pipefail

base=$1
if ! git cat-file -e "$base^{commit}"; then
  git fetch --quiet --no-tags --depth=1 origin "$base"
fi
if git diff --quiet "$base" -- \
  packages/stim-cli/skill/SKILL.md packages/stim-cli/src/guide \
  packages/stim-cli/src/commands/guide.ts packages/stim-cli/src/engine/simslim{,-data}.ts \
  scripts/report-agent-guide-size.sh; then
  exit 0
fi

head_cli="$PWD/packages/stim-cli/dist/cli.mjs"
tmp=$(mktemp -d)
cleanup() {
  if [ -d "$tmp/base" ]; then
    git worktree remove --force "$tmp/base"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

git worktree add --quiet --detach "$tmp/base" "$base"
(
  cd "$tmp/base"
  pnpm install --frozen-lockfile
  pnpm run build
)

guide_bytes() {
  (cd "$tmp"; STIM_NO_UPDATE_CHECK=1 STIM_HOME="$tmp/stim" node "$1" guide agent) | wc -c | tr -d '[:space:]'
}

before=$(guide_bytes "$tmp/base/packages/stim-cli/dist/cli.mjs")
after=$(guide_bytes "$head_cli")
skill=packages/stim-cli/skill/SKILL.md
skill_before=$(wc -c < "$tmp/base/$skill" | tr -d '[:space:]')
skill_after=$(wc -c < "$skill" | tr -d '[:space:]')
{
  printf '### Agent guide size\n\n'
  printf '\x60stim guide agent\x60: %s → %s UTF-8 bytes (%+d).\n' "$before" "$after" "$((after - before))"
  printf 'Skill file: %d → %d UTF-8 bytes (%+d).\n' "$skill_before" "$skill_after" "$((skill_after - skill_before))"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
