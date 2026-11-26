# address-review's "unanswered" (its section 0) on scripts/pull-request.graphql's answer:
#   jq -f scripts/unanswered.jq pr.json
include "review" {search: "./"};
{ threads: unanswered_threads, bodies: [unanswered_bodies[] | { id, databaseId, author: .author.login, body }],
  rounds: rounds, stopped: stopped }
