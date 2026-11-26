#!/bin/sh
# Rebases the reviewed head of a pull request onto a base commit, the same way every time, with git only:
#   scripts/rebase.sh <head branch> <reviewed head> <base commit>
# The committer and the date are fixed (the date is the base commit's), so two runs make the same commits: the job
# that tests the rebase and the job that pushes it, which runs none of the pull request's code, compare the result.
# Prints the new head; exits 2 when the rebase stops on a conflict (aborted), 3 when the branch moved from the reviewed head.
set -eu
branch=$1 head=$2 base=$3
git fetch -q --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch" "$base"
[ "$(git rev-parse "refs/remotes/origin/$branch")" = "$head" ] || { echo "moved: $branch is no longer at $head" >&2; exit 3; }
git -c advice.detachedHead=false checkout -q --detach "$head"
GIT_COMMITTER_NAME='github-actions[bot]' GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
GIT_COMMITTER_DATE=$(git log -1 --format=%cI "$base") \
  git -c rebase.autoSquash=false -c rebase.updateRefs=false rebase -q "$base" >&2 \
  || { git rebase --abort >&2 || true; echo "conflict: $head does not apply onto $base" >&2; exit 2; }
git rev-parse HEAD
