// The decisions of .github/workflows/automations.yml (spec/automations.md), on recorded pull requests: what GitHub's GraphQL
// API answered for scripts/pull-request.graphql, in tests/automations/pr-<n>.json. A case at an earlier moment of a
// pull request is its recording cut at that time (`at`): the reviews, comments and thread replies up to it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

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

test('start Code Review on a new head: opened, synchronize, a conflicting pull request too', () => {
  const conflicting = recorded(55, (pr) => Object.assign(pr, { state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
  for (const answer of [recording(55), conflicting]) {
    for (const action of ['opened', 'synchronize']) {
      const d = decide(answer, { event: 'pull_request_target', action });
      assert.equal(d.decision, 'start', action);
      assert.deepEqual(d.start, ['code-review']);
    }
  }
});

test('reopened: start Code Review on a head it has not reviewed; merge a completed review', () => {
  assert.deepEqual(decide(recording(55), { event: 'pull_request_target', action: 'reopened' }).start, ['code-review']);
  assert.equal(decide(recorded(COMPLETED), { event: 'pull_request_target', action: 'reopened', behind: 0 }).decision, 'merge');
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
  const closed = decide(recorded(57, (pr) => { pr.state = 'CLOSED'; }), { review: 6077059626, behind: 0 });
  assert.equal(closed.decision, 'nothing');
  assert.match(closed.reason, /closed/);
});

test('nothing for Address Review on a fork\'s pull request, though a thread is unanswered', () => {
  const { time, head, review } = PR55_FIRST_REVIEW;
  const d = decide(at(55, time, head, (pr) => Object.assign(pr, { isCrossRepository: true })), { review });
  assert.equal(d.decision, 'nothing', d.reason);
});

test('a completed review in another merge state: nothing; how far behind unknown: wait', () => {
  const blocked = recorded(COMPLETED, (pr) => Object.assign(pr, { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }));
  const d = decide(blocked, { review: LIGHT_CHECK, behind: 0 });
  assert.equal(d.decision, 'nothing', d.reason);
  assert.match(d.reason, /MERGEABLE, BLOCKED/);
  assert.equal(decide(recorded(COMPLETED), { review: LIGHT_CHECK }).decision, 'wait');
});

test('a completed review whose summary states a finding with no path:line and no label is merged as it is, a file named without a line too', () => {
  const answer = recorded(COMPLETED, (pr) => {
    pr.reviews.nodes.at(-1)!.body = 'Nothing blocks the merge. The main risk is small: a long name may wrap in the panel.';
  });
  assert.equal(decide(answer, { review: LIGHT_CHECK, behind: 0 }).decision, 'merge');
  // The owner's choice (#62): a file named without a line is merged too; Code Review labels a finding instead.
  const file = recorded(COMPLETED, (pr) => {
    pr.reviews.nodes.at(-1)!.body = 'Nothing blocks the merge. `spec/web.md` and `tests/visual/page-linux.png` are unchanged.';
  });
  assert.equal(decide(file, { review: LIGHT_CHECK, behind: 0 }).decision, 'merge');
  const labelled = recorded(COMPLETED, (pr) => {
    pr.reviews.nodes.at(-1)!.body = 'Nothing blocks the merge. **suggestion** `tests/visual/page-linux.png` also moved the footer.';
  });
  assert.deepEqual(decide(labelled, { review: LIGHT_CHECK, behind: 0 }).start, ['merge-when-reviewed']);
  const review = readFileSync(`${REPOSITORY}.agents/skills/code-review/SKILL.md`, 'utf8');
  assert.match(review, /\*\*A finding in the summary\*\* starts with its label too/);
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

/** A directory for a fake `gh` (answering with `answer`, `behind` commits) and a `sleep` that returns at once. */
function fakes(answer: Answer, behind: number): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'decide-'));
  const log = join(dir, 'gh.log');
  writeFileSync(join(dir, 'pr.answer.json'), JSON.stringify(answer));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$*" >> '${log}'
case "$2" in
  graphql) cat '${dir}/pr.answer.json' ;;
  */git/ref/*) echo 9c01e86b09f4a2f5c1d0e6e8d1c4b2a3f5e6d7c8 ;;
  */compare/*) echo ${behind} ;;
esac
`);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n');
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
  return { dir, log };
}

/** `scripts/decide.sh` with the fakes: its decision and how many times it read the pull request. */
function decideSh(answer: Answer, behind: number, tries: number): { decision: Decision & { base_sha: string }; reads: number } {
  const { dir, log } = fakes(answer, behind);
  const out = execFileSync(`${SCRIPTS}decide.sh`, ['54', 'pull_request_review', 'submitted', String(LIGHT_CHECK)], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'artspb/ai-workshop-start', TRIES: String(tries) },
  });
  const reads = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('api graphql')).length;
  return { decision: JSON.parse(out), reads };
}

test('decide.sh: one read, the decision with the base commit; a wait that lasts every read becomes nothing', () => {
  const merge = decideSh(recorded(COMPLETED), 0, 3);
  assert.equal(merge.decision.decision, 'merge', merge.decision.reason);
  assert.equal(merge.decision.base_sha, '9c01e86b09f4a2f5c1d0e6e8d1c4b2a3f5e6d7c8');
  assert.equal(merge.reads, 1);
  const running = recorded(COMPLETED, (pr) => pr.head.nodes[0].commit.statusCheckRollup.contexts.nodes.push(check('test', 'CI', 'IN_PROGRESS', null)));
  const waited = decideSh(running, 0, 3);
  assert.equal(waited.decision.decision, 'nothing');
  assert.match(waited.decision.reason, /^still waiting: the review is completed, the checks on 36ecf14 are running$/);
  assert.equal(waited.reads, 3);
});

/** git in `cwd`, as a person named `name`, with no global configuration. */
function git(cwd: string, args: string[], name = 'Someone'): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.com`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.com` } }).trim();
}

/** `scripts/rebase.sh` in `cwd`: its exit code and the new head it printed. */
function rebase(cwd: string, name: string, branch: string, head: string, base: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(`${SCRIPTS}rebase.sh`, [branch, head, base], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.com` } }).trim() };
  } catch (error) {
    const e = error as { status: number; stdout: string };
    return { code: e.status, out: e.stdout.trim() };
  }
}

test('rebase.sh: the same commits in two clones; a conflict exits 2, aborted; a moved branch exits 3; the lease refuses another head', () => {
  const root = mkdtempSync(join(tmpdir(), 'rebase-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, work]);
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(work, file), text);
    git(work, ['add', file]);
    git(work, ['commit', '-q', '-m', message]);
    return git(work, ['rev-parse', 'HEAD']);
  };
  git(work, ['checkout', '-q', '-b', 'main']);
  commit('a.txt', 'a\n', 'A');
  git(work, ['push', '-q', 'origin', 'main']);
  git(work, ['checkout', '-q', '-b', 'feat']);
  const feat = commit('f.txt', 'f\n', 'F');
  git(work, ['checkout', '-q', 'main']);
  git(work, ['checkout', '-q', '-b', 'conf']);
  const conf = commit('a.txt', 'conf\n', 'C');
  git(work, ['checkout', '-q', 'main']);
  const base = commit('a.txt', 'b\n', 'B');
  git(work, ['push', '-q', 'origin', 'main', 'feat', 'conf']);

  const clones = ['One', 'Two'].map((name) => {
    const clone = join(root, name);
    git(root, ['clone', '-q', origin, clone], name);
    return { clone, name };
  });
  const heads = clones.map(({ clone, name }) => rebase(clone, name, 'feat', feat, base));
  for (const { code } of heads) assert.equal(code, 0);
  assert.match(heads[0].out, /^[0-9a-f]{40}$/);
  assert.equal(heads[0].out, heads[1].out, 'the same commit in both clones');
  const [{ clone }] = clones;
  assert.equal(git(clone, ['rev-parse', `${heads[0].out}^`]), base);

  assert.equal(rebase(clone, 'One', 'conf', conf, base).code, 2);
  assert.equal(existsSync(join(clone, '.git', 'rebase-merge')) || existsSync(join(clone, '.git', 'rebase-apply')), false, 'aborted');
  assert.equal(rebase(clone, 'One', 'feat', conf, base).code, 3);

  git(clone, ['checkout', '-q', '--detach', heads[0].out]);
  assert.throws(() => git(clone, ['push', '-q', `--force-with-lease=feat:${conf}`, 'origin', 'HEAD:refs/heads/feat']));
  git(clone, ['push', '-q', `--force-with-lease=feat:${feat}`, 'origin', 'HEAD:refs/heads/feat']);
  assert.equal(git(origin, ['rev-parse', 'refs/heads/feat']), heads[0].out);
});

test('the workflow: a new head is pull_request_target; a merge the token may not make starts Merge Reviewed', () => {
  const workflow = parse(readFileSync(`${REPOSITORY}.github/workflows/automations.yml`, 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['pull_request_target', 'pull_request_review', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.pull_request_target.types, ['opened', 'synchronize', 'reopened']);
  const [merge] = workflow.jobs.merge.steps.filter((step: { name?: string }) => step.name === 'Merge');
  assert.equal(merge.env.AIR_WEBHOOK_MERGE, '${{ secrets.AIR_WEBHOOK_MERGE }}');
  assert.match(merge.run, /if \[ "\$now" = "OPEN \$HEAD" \]; then[\s\S]*"\$AIR_WEBHOOK_MERGE"/);
  for (const job of Object.values(workflow.jobs) as { steps: { uses?: string; with?: { ref?: string } }[] }[])
    for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout'))) assert.equal(step.with?.ref, 'main');
});
