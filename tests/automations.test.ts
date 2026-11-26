// The decisions of .github/workflows/automations.yml (spec/automations.md), on recorded pull requests: what GitHub's GraphQL
// API answered for scripts/pull-request.graphql, in tests/automations/pr-<n>.json. A case at an earlier moment of a
// pull request is its recording cut at that time (`at`): the reviews, comments and thread replies up to it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = `${REPOSITORY}scripts/`;

// The recordings' GraphQL answers: only the fields the scripts read are typed.
type Author = { login: string; __typename: string };
type Comment = { author: Author; body: string; createdAt: string; databaseId?: number };
type Review = { databaseId: number; author: Author; state: string; body: string; submittedAt: string; commit: { oid: string };
  comments: { nodes: { replyTo: { id: string } | null }[] } };
type Context = Record<string, unknown>;
type PullRequest = {
  number: number; state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; headRefOid: string;
  head: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts: { nodes: Context[] } } } }[] };
  commits: { nodes: { commit: { messageHeadline: string } }[] };
  comments: { nodes: Comment[] };
  reviews: { nodes: Review[] };
  reviewThreads: { nodes: { isResolved: boolean; path: string; comments: { nodes: Comment[] } }[] };
};
type Answer = { data: { repository: { pullRequest: PullRequest } } };

const recording = (n: number): Answer => JSON.parse(readFileSync(`${REPOSITORY}tests/automations/pr-${n}.json`, 'utf8'));

/** The recording of pull request `n`, changed by `change`. */
function recorded(n: number, change: (pr: PullRequest) => void = () => {}): Answer {
  const answer = recording(n);
  change(answer.data.repository.pullRequest);
  return answer;
}

/** Pull request `n` as it was at `time`, open, on `head`: what was posted after it is left out, and every thread is open. */
function at(n: number, time: string, head: string, change: (pr: PullRequest) => void = () => {}): Answer {
  return recorded(n, (pr) => {
    Object.assign(pr, { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head });
    pr.head.nodes[0].commit.oid = head;
    pr.reviews.nodes = pr.reviews.nodes.filter((r) => r.submittedAt <= time);
    pr.comments.nodes = pr.comments.nodes.filter((c) => c.createdAt <= time);
    pr.reviewThreads.nodes = pr.reviewThreads.nodes
      .map((t) => ({ ...t, isResolved: false, comments: { nodes: t.comments.nodes.filter((c) => c.createdAt <= time) } }))
      .filter((t) => t.comments.nodes.length > 0);
    change(pr);
  });
}

type Event = { event?: string; action?: string; review?: number; behind?: number };
type Decision = { decision: string; start: string[]; reason: string; pull_request: number; head: string; review: number | null };

/** `jq -f scripts/<script>` on `answer`, as the workflow and the skills run it. */
function jq(script: string, answer: Answer, args: string[] = []): any {
  return JSON.parse(execFileSync('jq', ['-f', `${SCRIPTS}${script}`, ...args], { input: JSON.stringify(answer), encoding: 'utf8' }));
}

/** The workflow's decision for `event` on `answer`: a submitted review by default. */
function decide(answer: Answer, { event = 'pull_request_review', action = 'submitted', review, behind }: Event = {}): Decision {
  return jq('decide.jq', answer, ['--arg', 'event', event, '--arg', 'action', action,
    '--arg', 'review', review === undefined ? '' : String(review), '--arg', 'behind', behind === undefined ? '' : String(behind)]);
}

const AIR: Author = { login: 'jetbrains-air', __typename: 'Bot' };
const ACTIONS: Author = { login: 'github-actions', __typename: 'Bot' };
const PERSON: Author = { login: 'artspb', __typename: 'User' };
const check = (name: string, workflow: string, status: string, conclusion: string | null): Context =>
  ({ __typename: 'CheckRun', name, status, conclusion, checkSuite: { workflowRun: { workflow: { name: workflow } } } });

// #54: Code Review's light check of a rebase, 6077083340, found nothing on 36ecf14; every thread resolved, CI green.
const COMPLETED = 54;
const LIGHT_CHECK = 6077083340;
// #55 and #49 at earlier moments, each on the head it had then.
const PR55_FIRST_REVIEW = { time: '2026-11-26T15:40:30Z', head: 'd29eba5e9c1ce8b594e5d725a8ff8cd5a881af36', review: 6076917270 };
const PR55_ROUND = { time: '2026-11-26T15:42:50Z', head: '7b2276cb95cedd38eeb45ea09287ad9d8d217b44', review: 6076948895 };
const PR49_ROUND_NOT_CHANGED = { time: '2026-11-26T15:07:15Z', head: '76208a2926968adb719adaf4da06321755134ebc', review: 6076461997 };
const PR49_STAYS_OPEN = { time: '2026-11-26T15:07:45Z', head: '76208a2926968adb719adaf4da06321755134ebc', review: 6076470994 };
const PR49_PERSON = { time: '2026-11-26T15:17:30Z', head: '76208a2926968adb719adaf4da06321755134ebc', review: 6076605834 };
const PR49_ROUND_FIXED = { time: '2026-11-26T15:20:15Z', head: '8a2b8c15a9e2dafeb801e8ccd942311e64f2f159', review: 6076649698 };

test('merge, without an agent: the review is completed and the branch is up to date', () => {
  const d = decide(recorded(COMPLETED), { review: LIGHT_CHECK, behind: 0 });
  assert.equal(d.decision, 'merge', d.reason);
  assert.deepEqual(d.start, []);
  assert.equal(d.head, '36ecf1410e98e38607bd10025b9bdae11c5ed3d3');
  assert.equal(d.review, LIGHT_CHECK);
});

test('the Automations workflow\'s own check, running while it decides, and its own comments do not hold a merge back', () => {
  const answer = recorded(COMPLETED, (pr) => {
    pr.mergeStateStatus = 'UNSTABLE'; // what GitHub says while a check runs, the workflow's own too
    pr.head.nodes[0].commit.statusCheckRollup.state = 'PENDING';
    pr.head.nodes[0].commit.statusCheckRollup.contexts.nodes.push(check('automations: decide', 'Automations', 'IN_PROGRESS', null));
    pr.comments.nodes.push({ author: ACTIONS, body: 'Rebased onto main (9c01e86): …', createdAt: '2026-11-26T15:50:00Z' });
  });
  assert.equal(decide(answer, { review: LIGHT_CHECK, behind: 0 }).decision, 'merge');
});

test('bring up to date, without an agent: the review is completed, but the branch is behind', () => {
  const d = decide(recorded(COMPLETED), { review: LIGHT_CHECK, behind: 3 });
  assert.equal(d.decision, 'rebase', d.reason);
  assert.match(d.reason, /3 commits behind main/);
});

test('start Merge Reviewed: the review is completed, but the branch conflicts', () => {
  const answer = recorded(COMPLETED, (pr) => Object.assign(pr, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
  const d = decide(answer, { review: LIGHT_CHECK, behind: 3 });
  assert.equal(d.decision, 'start', d.reason);
  assert.deepEqual(d.start, ['merge-when-reviewed']);
});

test('a conflict already handed over to a person on this head: nothing', () => {
  const answer = recorded(COMPLETED, (pr) => {
    Object.assign(pr, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    pr.comments.nodes.push({ author: ACTIONS, createdAt: '2026-11-26T15:55:00Z',
      body: `Not rebased: 36ecf14 fails the tests.\n\n<!-- merge-when-reviewed conflict:${pr.headRefOid} -->` });
  });
  assert.equal(decide(answer, { review: LIGHT_CHECK }).decision, 'nothing');
});

test('start Merge Reviewed: a completed review whose summary names a path:line, for the agent to read', () => {
  const answer = recorded(COMPLETED, (pr) => {
    pr.reviews.nodes.at(-1)!.body = 'Nothing blocks the merge. The earlier thread on `src/web/public/style.css:12` is fixed.';
  });
  const d = decide(answer, { review: LIGHT_CHECK, behind: 0 });
  assert.equal(d.decision, 'start', d.reason);
  assert.deepEqual(d.start, ['merge-when-reviewed']);
});

test('a completed review waits for the checks and the merge state; a failing check: nothing', () => {
  const running = recorded(COMPLETED, (pr) => pr.head.nodes[0].commit.statusCheckRollup.contexts.nodes.push(check('test', 'CI', 'IN_PROGRESS', null)));
  assert.equal(decide(running, { review: LIGHT_CHECK, behind: 0 }).decision, 'wait');
  const unknown = recorded(COMPLETED, (pr) => Object.assign(pr, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
  assert.equal(decide(unknown, { review: LIGHT_CHECK, behind: 0 }).decision, 'wait');
  const failed = recorded(COMPLETED, (pr) => pr.head.nodes[0].commit.statusCheckRollup.contexts.nodes.push(check('test', 'CI', 'COMPLETED', 'FAILURE')));
  assert.equal(decide(failed, { review: LIGHT_CHECK, behind: 0 }).decision, 'nothing');
});

test('a person commented on the bot\'s completed pull request: no merge, it is theirs', () => {
  const answer = recorded(COMPLETED, (pr) => pr.comments.nodes.push({ author: PERSON, body: 'Wait for me.', createdAt: '2026-11-26T15:54:00Z' }));
  const d = decide(answer, { review: LIGHT_CHECK, behind: 0 });
  assert.equal(d.decision, 'nothing', d.reason);
  assert.match(d.reason, /a person commented/);
});

test('start Code Review on a new head: opened, synchronize', () => {
  for (const action of ['opened', 'synchronize']) {
    const d = decide(recording(55), { event: 'pull_request', action });
    assert.equal(d.decision, 'start', action);
    assert.deepEqual(d.start, ['code-review']);
  }
});

test('start Address Review: Code Review\'s review left an unanswered thread', () => {
  const { time, head, review } = PR55_FIRST_REVIEW;
  const d = decide(at(55, time, head), { review });
  assert.equal(d.decision, 'start', d.reason);
  assert.deepEqual(d.start, ['address-review']);
});

test('start Address Review: a person\'s review', () => {
  const { time, head, review } = PR49_PERSON;
  const d = decide(at(49, time, head), { review });
  assert.equal(d.decision, 'start', d.reason);
  assert.deepEqual(d.start, ['address-review']);
});

test('start Code Review: address-review\'s round answered its thread with a Not changed, no commit', () => {
  const { time, head, review } = PR49_ROUND_NOT_CHANGED;
  const d = decide(at(49, time, head), { review });
  assert.equal(d.decision, 'start', d.reason);
  assert.deepEqual(d.start, ['code-review']);
});

test('nothing: address-review\'s round with a commit, which started Code Review already', () => {
  for (const [n, { time, head, review }] of [[55, PR55_ROUND], [49, PR49_ROUND_FIXED]] as const) {
    const d = decide(at(n, time, head), { review });
    assert.equal(d.decision, 'nothing', `#${n}: ${d.reason}`);
  }
});

test('nothing: Code Review\'s own review, which leaves a thread open for a person', () => {
  const { time, head, review } = PR49_STAYS_OPEN;
  const d = decide(at(49, time, head), { review });
  assert.equal(d.decision, 'nothing', d.reason);
});

test('nothing for Address Review after 3 rounds, once the stop is posted; nothing on a draft', () => {
  const { time, head, review } = PR55_FIRST_REVIEW;
  const stopped = at(55, time, head, (pr) => {
    pr.commits.nodes = ['Address review: a', 'Address review: b', 'Address review: c'].map((messageHeadline) => ({ commit: { messageHeadline } }));
    pr.comments.nodes.push({ author: AIR, createdAt: time,
      body: 'Stopped after 3 rounds of review fixes; the open threads are for a person.\n\n<!-- address-review -->' });
  });
  assert.equal(decide(stopped, { review }).decision, 'nothing');
  assert.equal(decide(at(55, time, head, (pr) => { pr.isDraft = true; }), { review }).decision, 'nothing');
});

test('nothing on a closed or merged pull request', () => {
  const d = decide(recording(57), { review: 6077059626, behind: 0 });
  assert.equal(d.decision, 'nothing');
  assert.match(d.reason, /merged/);
});

test('workflow_dispatch on a head Code Review has not reviewed: start Code Review; a review event on it: nothing', () => {
  const answer = recording(55); // rebased onto main after Code Review found nothing on 7b2276c
  assert.deepEqual(decide(answer, { event: 'workflow_dispatch', action: '' }).start, ['code-review']);
  assert.equal(decide(answer, { review: 6076969901 }).decision, 'nothing');
});

test('the skills\' scripts read the same pull request: merge-when-reviewed\'s flags and address-review\'s unanswered', () => {
  const flags = jq('merge-when-reviewed.jq', recorded(COMPLETED));
  for (const flag of ['bot_pr', 'on_head', 'nothing', 'no_inline', 'no_named', 'resolved', 'bot_only', 'no_pending', 'green'])
    assert.equal(flags[flag], true, flag);
  assert.equal(flags.review, LIGHT_CHECK);
  const { time, head } = PR49_PERSON;
  const unanswered = jq('unanswered.jq', at(49, time, head));
  assert.equal(unanswered.threads.length, 2);
  assert.deepEqual(unanswered.bodies.map((b: { databaseId: number }) => b.databaseId), [6076605834]);
  assert.equal(jq('unanswered.jq', at(49, PR49_STAYS_OPEN.time, PR49_STAYS_OPEN.head)).threads.length, 0);
});

test('the skills and the workflow run the shared scripts, and the workflow decides on main, not on the pull request', () => {
  const skill = (name: string) => readFileSync(`${REPOSITORY}.agents/skills/${name}/SKILL.md`, 'utf8');
  assert.match(skill('merge-when-reviewed'), /scripts\/pull-request\.graphql/);
  assert.match(skill('merge-when-reviewed'), /jq -f scripts\/merge-when-reviewed\.jq/);
  assert.match(skill('address-review'), /scripts\/pull-request\.graphql/);
  assert.match(skill('address-review'), /jq -f scripts\/unanswered\.jq/);
  const workflow = readFileSync(`${REPOSITORY}.github/workflows/automations.yml`, 'utf8');
  assert.match(workflow, /scripts\/decide\.sh/);
  const decide = readFileSync(`${SCRIPTS}decide.sh`, 'utf8');
  assert.match(decide, /pull-request\.graphql/);
  assert.match(decide, /decide\.jq/);
  assert.match(workflow, /ref: main/);
  for (const secret of ['AIR_WEBHOOK_CODE_REVIEW', 'AIR_WEBHOOK_ADDRESS_REVIEW', 'AIR_WEBHOOK_MERGE']) assert.match(workflow, new RegExp(secret));
});
