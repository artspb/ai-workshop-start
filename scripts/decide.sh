#!/bin/sh
# One read of pull request <n> and the decision on it (decide.jq), as .github/workflows/automations.yml makes it:
#   [TRIES=<reads>] scripts/decide.sh <n> <event name> <action> [<review databaseId>]
# Needs gh (GH_TOKEN), jq and GITHUB_REPOSITORY=<owner>/<repo>. Writes pr.json; prints the decision, with base_sha,
# the base branch's commit it was measured against. A "wait" (the checks or the merge state of a completed review)
# reads again, 20 seconds later, up to TRIES times in all (1 by default); still waiting then, it is "nothing".
set -eu
dir=$(dirname "$0")
n=$1 event=$2 action=$3 review=${4:-}
repo=${GITHUB_REPOSITORY:?}
tries=${TRIES:-1}
read_and_decide() {
gh api graphql -F owner="${repo%/*}" -F repo="${repo#*/}" -F n="$n" -f query="$(cat "$dir/pull-request.graphql")" > pr.json
head=$(jq -r '.data.repository.pullRequest.headRefOid' pr.json)
base=$(jq -r '.data.repository.pullRequest.baseRefName' pr.json)
base_sha=$(gh api "repos/$repo/git/ref/heads/$base" --jq .object.sha 2>/dev/null || true)
behind=""
[ -z "$base_sha" ] || behind=$(gh api "repos/$repo/compare/$base_sha...$head" --jq .behind_by 2>/dev/null || true)
jq -f "$dir/decide.jq" --arg event "$event" --arg action "$action" --arg review "$review" --arg behind "$behind" pr.json \
  | jq -c --arg base_sha "$base_sha" '. + { base_sha: $base_sha }'
}
i=1
while decision=$(read_and_decide) && [ "$(echo "$decision" | jq -r .decision)" = wait ] && [ "$i" -lt "$tries" ]; do
  i=$((i + 1)); sleep 20
done
[ -n "$decision" ] || { echo "decide.sh: no decision on #$n" >&2; exit 1; }
echo "$decision" | jq -c 'if .decision == "wait" then .decision = "nothing" | .reason = "still waiting: \(.reason)" else . end'
