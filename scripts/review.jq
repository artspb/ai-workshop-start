# The review automations' rules, shared: the skills (code-review, address-review, merge-when-reviewed) and
# .github/workflows/automations.yml read the same pull request (scripts/pull-request.graphql) with these definitions.
# Included by the other scripts in this directory: `include "review" {search: "./"};`.

# The pull request of a GraphQL answer.
def pr: .data.repository.pullRequest;

# Text outside its fenced code blocks: a ``` or ~~~ fence at the start of a line, closed by the same fence,
# or never closed (GitHub renders it to the end).
def code: (. // "") | gsub("(?m)^ {0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(^ {0,3}\\1[`~]*[ \\t]*\\r?$|\\z)"; "");

# address-review's marker, a line of its own outside code blocks: everything it posts has it.
def ar: code | test("(?m)^<!-- address-review( answers:[0-9,]+)? -->\\s*$");
# Code Review's reply that leaves a thread open for a person.
def stays_open: code | test("(?m)^<!-- code-review: stays open -->\\s*$");
# The review bodies an address-review round answers: the databaseIds of its `answers:` marker.
def answers: [code | match("(?m)^<!-- address-review answers:([0-9,]+) -->\\s*$"; "g")
  | .captures[0].string | split(",")[] | select(length > 0) | tonumber];
# Names a finding: a label, or a `path:line`.
def labels: code | test("\\*\\*(blocking|suggestion|question)\\*\\*");
def named: labels or (code | test("[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+:[0-9]+"));

# Every Air automation posts as one bot: the login and the type, never the login alone.
def air: .author.login == "jetbrains-air" and .author.__typename == "Bot";
# The Automations workflow (.github/workflows/automations.yml) posts as GitHub Actions.
def workflow: .author.login == "github-actions" and .author.__typename == "Bot";

# Code Review's reviews: the bot's, with a body and no address-review marker; the last one is its latest.
def code_reviews: [pr.reviews.nodes[] | select(air and ((.body // "") | length > 0) and (.body | ar | not))];
def last_code_review: code_reviews | last;

# The head's checks, but the Automations workflow's own, which runs while it decides:
# "failure" when one has failed, else "pending" while one runs (or none has started), else "success".
def automations: ((.checkSuite.workflowRun.workflow.name // "") == "Automations") or ((.name // "") | startswith("automations"));
def checks: [(pr.head.nodes[0].commit.statusCheckRollup.contexts.nodes // [])[] | select(automations | not)
    | if .__typename == "CheckRun" then
        (if .status != "COMPLETED" then "pending" elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "success" else "failure" end)
      else
        (if .state == "SUCCESS" then "success" elif (.state | IN("PENDING", "EXPECTED")) then "pending" else "failure" end)
      end]
  | if any(. == "failure") then "failure" elif length == 0 or any(. == "pending") then "pending" else "success" end;

# Mergeable, nothing in the way but the checks: GitHub says UNSTABLE while a check has not passed, the workflow's own
# included, so with the checks read above, UNSTABLE is as clean as CLEAN.
def clean: pr.mergeable == "MERGEABLE" and (pr.mergeStateStatus | IN("CLEAN", "UNSTABLE"));

# merge-when-reviewed's checks 1-6 (section 2), as flags.
def merge_flags: pr as $p | last_code_review as $cr
  | { bot_pr:     (($p | air) and ($p.isDraft | not) and ($p.isCrossRepository | not) and $p.state == "OPEN"),
      on_head:    ($cr != null and $cr.commit.oid == $p.headRefOid),
      nothing:    (($cr.body // "") | startswith("Nothing blocks")),
      no_inline:  ($cr != null and ([$cr.comments.nodes[]? | select(.replyTo == null)] | length == 0)),
      no_named:   ($cr != null and ($cr.body | named | not)),
      resolved:   ([$p.reviewThreads.nodes[] | .isResolved] | all),
      bot_only:   ([$p.comments.nodes[], $p.reviews.nodes[] | air or workflow] | all),
      no_pending: ([$p.reviews.nodes[] | .state != "PENDING"] | all),
      checks:     checks,
      green:      (checks == "success" and clean),
      conflict:   (checks == "success" and $p.mergeable == "CONFLICTING" and $p.mergeStateStatus == "DIRTY"),
      unknown:    ($p.mergeable == "UNKNOWN" or $p.mergeStateStatus == "UNKNOWN"),
      said:       ([$p.comments.nodes[] | select(air or workflow) | .body
                    | test("(?m)^<!-- merge-when-reviewed conflict:\($p.headRefOid) -->\\s*$")] | any),
      review:     $cr.databaseId,
      summary:    $cr.body };

# address-review's "unanswered" (section 0): threads, then review bodies.
def unanswered_threads: [pr.reviewThreads.nodes[]
  | select((.isResolved | not) and (.comments.nodes[-1].body | ar or stays_open | not))];
def unanswered_bodies: [pr.reviews.nodes[] | .body | answers[]] as $answered
  | [pr.reviews.nodes[] | select(.state != "PENDING" and ((.body // "") | length > 0) and (.body | ar | not)
      and ((.body | startswith("Nothing blocks") | not) or (.body | labels))
      and (.databaseId as $id | $answered | any(. == $id) | not))];
def rounds: [pr.commits.nodes[].commit.messageHeadline | select(startswith("Address review"))] | length;
def stopped: [pr.comments.nodes[].body | select(contains("Stopped after 3 rounds of review fixes"))] | any;

# What Code Review must settle (code-review section 1): its latest review is on the head, and an address-review
# answer is newer: a reply in an open thread it started, or a round that answers its review body.
def to_settle: pr as $p | last_code_review as $cr
  | if $cr == null or $cr.commit.oid != $p.headRefOid then []
    else [($p.reviewThreads.nodes[]
            | select((.isResolved | not) and (.comments.nodes[0] | air and (.body | ar | not)))
            | select(any(.comments.nodes[]; (.body | ar) and .createdAt > $cr.submittedAt))
            | "\(.path):\(.line // "")"),
          ($p.reviews.nodes[] | select((.body | ar) and (.submittedAt // "") > $cr.submittedAt)
            | select(.body | answers | any(. == $cr.databaseId)) | "the review body")]
    end;
