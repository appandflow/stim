# Unreleased

## Added

- `stim worktree add --refresh` first refreshes the source checkout as `stim worktree warm --refresh` does: it fast-forwards the checked-out branch to its upstream and reinstalls dependencies when its lockfiles moved. It refuses with the same errors (`STIM_MAIN_DIRTY`, `STIM_MAIN_DETACHED`, `STIM_MAIN_DIVERGED`) and then creates no worktree. With no commit-ish, the new worktree starts at the refreshed source `HEAD`, also when the command runs from another worktree. [#6596](https://github.com/appandflow/stim/issues/6596)
