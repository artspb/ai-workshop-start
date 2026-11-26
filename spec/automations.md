# Review automations
Three Air automations work on pull requests: **Code Review** (`code-review`), **Address Review** (`address-review`)
and **Merge Reviewed** (`merge-when-reviewed`). The *Automations* workflow, `.github/workflows/automations.yml`,
starts one only when there is work for it, and merges or brings a branch up to date itself, without an agent.
## Events
- `pull_request_target`: `opened`, `synchronize`, `reopened`; `pull_request_review`: `submitted`
  - `pull_request_target`, not `pull_request`: GitHub runs no `pull_request` workflow on a pull request that conflicts
    with its base, so a new head there would start no Code Review. It runs `main`'s copy of the workflow, never the
    pull request's, on a fork's pull request too
- `workflow_dispatch`, with a pull request's number: the same decision, by hand
- One read of the pull request, `scripts/pull-request.graphql`; the decision, `scripts/decide.jq`
- The rules are the skills': `scripts/review.jq`, which the skills run too (`scripts/merge-when-reviewed.jq`, `scripts/unanswered.jq`)
## Decisions
The first that applies:
- Closed or merged → *nothing*
- A new head (`opened`, `synchronize`) → start **Code Review**
- **The review is completed**: merge-when-reviewed's checks 1–5 hold (the bot's open pull request, not a draft nor a fork;
  Code Review's latest review on the head, starting `Nothing blocks`, no inline finding; every thread resolved;
  only the bot and the workflow commented; no pending review)
  - its summary names a `path:line` or a label → start **Merge Reviewed**: whether it is a finding needs judgement
  - a summary with neither is taken as it is: a finding it states in words only, or with a path and no line, is merged
  - the conflict on this head is already handed over (merge-when-reviewed's `conflict:<head>` marker) → *nothing*
  - a check fails → *nothing*
  - the checks run, or GitHub's merge state is `UNKNOWN` → *wait*: read again every 20 seconds, up to 15 minutes; then *nothing*
  - it conflicts (`CONFLICTING`, `DIRTY`) → start **Merge Reviewed**: resolving needs judgement
  - clean and up to date → **merge**, without an agent
  - clean and behind the base → **bring it up to date**, without an agent
  - another merge state → *nothing*
- Otherwise, start each automation that has work; none has → *nothing*
  - **Address Review**: something is unanswered (address-review, section 0), not a draft, not a fork
    - never for its own round's review (a review with address-review's marker)
    - not after 3 rounds of `Address review` commits once its stop line is posted
  - **Code Review**: its latest review is on the head and an address-review answer is newer: a reply in an open thread
    it started (a **Not changed**, an answer to its question, a **Fixed in** it has not seen), or a round that answers its review body
    - never for its own review
    - on a head it has not reviewed: a review event starts nothing, the push started it already; `workflow_dispatch`
      and `reopened` start it
- *Unanswered* review body: one without address-review's marker, not named by an `answers:` marker, that does not start
  with `Nothing blocks` or has a label (`**blocking**`, `**suggestion**`, `**question**`)
## Checks
"The checks" are every check on the head but the workflow's own, which runs while it decides:
a check of the workflow `Automations`, or one named `automations: …`.
- One has failed → *failure*; else one runs, or none has started → *pending*; else *success*
- *Clean*: `mergeable` `MERGEABLE` and `mergeStateStatus` `CLEAN`, or `UNSTABLE`: GitHub's word for a check that has
  not passed, the workflow's own included
## Merge
- Read the pull request again right before: still a merge, on the same head; `gh pr merge --rebase --delete-branch --match-head-commit <head>`
- Merged → merge-when-reviewed's comment, `Merged with rebase: …`
- Refused with the pull request still open on the reviewed head (the token may not merge a change to `.github/workflows`)
  → start **Merge Reviewed**; refused otherwise (a new head, or merged meanwhile) → *nothing*
## Bring up to date
- The reviewed head is rebased onto the base's commit with git only, committer `github-actions[bot]` with the base
  commit's date: the same input makes the same commits, in any job
- **Verify**, a job without a write token or a secret: `npm ci`, the typecheck, the tests, the smoke scan
  - It conflicts → start **Merge Reviewed**
  - A check fails → merge-when-reviewed's hand-over comment, `Not rebased: <head> fails <check> …`, with the owner from
    [AGENTS.md](../AGENTS.md#owner) and the `conflict:<head>` marker: nothing again on this head
  - The branch moved from the reviewed head → *nothing*
- **Push**, a job that runs none of the pull request's code: read again (still a rebase, on the same head), rebase again,
  push only the commit Verify tested, `--force-with-lease=<branch>:<reviewed head>`
  - merge-when-reviewed's comment, `Rebased onto …`
  - start CI on the branch (`workflow_dispatch`) and **Code Review**: a push with the workflow's token starts no workflow
  - Refused with the branch still on the reviewed head (the token may not push a change to `.github/workflows`) → start **Merge Reviewed**
## Starting an automation
- `POST { pull_request: <number>, reason: <one line> }` to its webhook, a repository secret ([AGENTS.md](../AGENTS.md#automations))
- A secret that is not set: a warning, not started; the job is still green
- The skills work started by either, a GitHub event or the webhook
## Job summary
One line: `#<n>: <decision>: <why>`, e.g. `#54: start Address Review: 2 unanswered threads and 0 review bodies: Address Review answers them`
## Secrets
- `scripts/decide.sh` not on `main` yet (the pull request that adds it) → *nothing*, and the job is green
- The decision checks out `main`, not the pull request; the pull request's code runs only in Verify, without a secret
- One run at a time per pull request and kind of event: a review never replaces a waiting new head
