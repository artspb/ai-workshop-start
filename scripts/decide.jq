# What .github/workflows/automations.yml does for an event on a pull request (spec/automations.md):
#   jq -f scripts/decide.jq --arg event <event name> --arg action <action> --arg review <review databaseId, or "">
#      --arg behind <commits the head is behind its base, or ""> pr.json
# pr.json is scripts/pull-request.graphql's answer. Prints
#   { decision: "merge" | "rebase" | "start" | "wait" | "nothing", start: [<automation>…], reason: <one line>, … }
# with each <automation> one of "code-review", "address-review", "merge-when-reviewed".
include "review" {search: "./"};

def short: .[0:7];
# The first of merge-when-reviewed's checks 1-5 that fails, in words.
def incomplete($f):
  if ($f.bot_pr | not) then "not an open pull request of the bot"
  elif ($f.review == null) then "no review by Code Review yet"
  elif ($f.on_head | not) then "Code Review's latest review is not on the head"
  elif ($f.nothing | not) then "Code Review's latest review does not say nothing blocks"
  elif ($f.no_inline | not) then "Code Review's latest review has inline findings"
  elif ($f.resolved | not) then "a thread is open"
  elif ($f.bot_only | not) then "a person commented"
  else "a review is pending" end;

pr as $p | merge_flags as $f
| ($review | if . == "" then null else tonumber end) as $id
| ([$p.reviews.nodes[] | select(.databaseId == $id)] | first) as $r
| (if $r == null then null
   elif ($r | air) and ($r.body | ar) then "address-review"
   elif ($r | air) and (($r.body // "") | length > 0) then "code-review"
   elif ($r | air) then "bot"
   else "person" end) as $kind
| ($behind | if . == "" then null else tonumber end) as $behind
| ($p.headRefOid | short) as $head
| ($f.bot_pr and $f.on_head and $f.nothing and $f.no_inline and $f.resolved and $f.bot_only and $f.no_pending) as $completed
| (unanswered_threads | length) as $threads
| (unanswered_bodies | length) as $bodies
| to_settle as $settle
| (if $p == null then { decision: "nothing", reason: "no such pull request" }
   elif $p.state != "OPEN" then { decision: "nothing", reason: "the pull request is \($p.state | ascii_downcase)" }
   elif $event == "pull_request" and ($action | IN("opened", "synchronize")) then
     { decision: "start", start: ["code-review"], reason: "a new head, \($head): Code Review reviews it" }
   elif $completed then
     if ($f.no_named | not) then
       { decision: "start", start: ["merge-when-reviewed"],
         reason: "Code Review found nothing on \($head), but its summary names a path:line or a label: Merge Reviewed reads it" }
     elif $f.said then { decision: "nothing", reason: "the conflict on \($head) is already handed over to a person" }
     elif $f.checks == "failure" then { decision: "nothing", reason: "the review is completed, but a check fails on \($head)" }
     elif $f.checks == "pending" then { decision: "wait", reason: "the review is completed, the checks on \($head) are running" }
     elif $f.unknown then { decision: "wait", reason: "the review is completed, GitHub is computing the merge state of \($head)" }
     elif $f.conflict then
       { decision: "start", start: ["merge-when-reviewed"],
         reason: "the review of \($head) is completed, but it conflicts with \($p.baseRefName): Merge Reviewed resolves it" }
     elif ($f.green | not) then
       { decision: "nothing", reason: "the review is completed, but the merge state of \($head) is \($p.mergeable), \($p.mergeStateStatus)" }
     elif $behind == null then { decision: "wait", reason: "the review is completed, how far \($head) is behind \($p.baseRefName) is unknown" }
     elif $behind == 0 then { decision: "merge", reason: "Code Review found nothing on \($head), every thread is resolved and it is up to date" }
     else { decision: "rebase", reason: "Code Review found nothing on \($head), but it is \($behind) commits behind \($p.baseRefName)" }
     end
   else
     ([ (if $threads + $bodies > 0 and ($p.isDraft | not) and ($p.isCrossRepository | not) and $kind != "address-review"
           and ((rounds >= 3 and stopped) | not)
         then "address-review" else empty end),
        (if ($settle | length > 0) and $id != $f.review then "code-review"
         elif ($event | IN("workflow_dispatch", "pull_request")) and ($f.on_head | not) then "code-review"
         else empty end) ] ) as $start
     | if ($start | length) > 0 then
         { decision: "start", start: $start,
           reason: ([ (if $start | any(. == "address-review") then "\($threads) unanswered threads and \($bodies) review bodies: Address Review answers them" else empty end),
                      (if $start | any(. == "code-review") then
                         (if $settle | length > 0 then "answers to settle in \($settle | join(", ")): Code Review settles them"
                          else "\($head) has no review: Code Review reviews it" end)
                       else empty end) ] | join("; ")) }
       else
         { decision: "nothing",
           reason: ("nothing to do: " + incomplete($f)
             + (if $threads + $bodies == 0 then ", nothing unanswered"
                elif $kind == "address-review" then ", and this is address-review's own round"
                elif rounds >= 3 and stopped then ", and address-review stopped after 3 rounds"
                else ", nothing Address Review answers here" end)
             + ", nothing for Code Review to settle") }
       end
   end)
| . + { start: (.start // []), pull_request: $p.number, head: $p.headRefOid, base: $p.baseRefName, review: $f.review, behind: $behind }
