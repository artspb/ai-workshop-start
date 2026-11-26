// The decisions in spec/analysis.md#rate-limit, spec/cli.md#rate-limit and spec/web.md: when GitHub
// refuses for the rate limit, the CLI and the page say when it resets, as GitHub's answer says.
process.env.TZ = 'UTC'; // the CLI words the time in the terminal's time zone: one for every machine
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../src/commands.ts';
import { openGitHub, openGitHubOwner, parseGitHubOwner, type GitHubOptions } from '../src/core/github.ts';
import { replay, type Recorded, type Recording } from '../src/core/replay.ts';
import { errorText } from '../src/web/public/progress.js';
import { createWebServer, listen } from '../src/web/server.ts';

const API = 'https://api.github.com';
const REPOSITORY = `${API}/repos/JetBrains/example`;
const COMMIT = 'a'.repeat(40);
const FILE = `https://raw.githubusercontent.com/JetBrains/example/${COMMIT}/.claude/skills/commits/SKILL.md`;
const MINUTE = 60_000;

/** JetBrains/example with one skill, in the organization JetBrains; `overrides` answer instead. */
function recording(overrides: Recording = {}): Recording {
  return {
    [`${API}/users/JetBrains`]: { status: 200, body: { login: 'JetBrains', type: 'Organization' } },
    [`${API}/orgs/JetBrains/repos?type=all&per_page=100&page=1`]: {
      status: 200,
      body: [{ full_name: 'JetBrains/example', default_branch: 'main' }],
    },
    [REPOSITORY]: { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    [`${REPOSITORY}/commits/main`]: { status: 200, body: { sha: COMMIT } },
    [`${REPOSITORY}/git/trees/${COMMIT}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree: [{ path: '.claude/skills/commits/SKILL.md', mode: '100644', type: 'blob', sha: '0' }] },
    },
    [FILE]: { status: 200, body: '---\nname: commits\ndescription: Commits.\n---\n' },
    ...overrides,
  };
}

/** The primary limit refused: `x-ratelimit-reset` at `reset`, Unix seconds. */
const primary = (reset: number, headers: Record<string, string> = {}): Recorded => ({
  status: 403,
  body: { message: 'API rate limit exceeded for user ID 1.' },
  headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), ...headers },
});

/** A secondary limit refused: `retry-after`, seconds. */
const secondary = (seconds: number): Recorded => ({
  status: 403,
  body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
  headers: { 'retry-after': String(seconds), 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '1' },
});

/** `skill-atlas scan <input>` as the CLI runs it, with or without a token, GitHub answering from the recording. */
async function atlas(input: string, github: Recording, token = true) {
  const options: GitHubOptions = { fetch: replay(github), token: token ? 'test' : undefined };
  const stderr: string[] = [];
  const code = await run(['scan', input], {
    open: (repo) => openGitHub(repo, options),
    openOrganization: (repo) => (parseGitHubOwner(repo) ? openGitHubOwner(repo, options) : undefined),
    print: () => {},
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  return { code, stderr: stderr.join('\n') };
}

/** `HH:MM` in UTC, the minute rounded up, as the CLI shows a reset time here. */
const hhmm = (ms: number) => new Date(Math.ceil(ms / MINUTE) * MINUTE).toISOString().slice(11, 16);

/** Unix seconds 20 minutes from now: GitHub's reset time; the CLI then says "in 20 minutes". */
const inTwentyMinutes = () => Math.floor(Date.now() / 1000) + 20 * 60;

test('the primary limit, with GITHUB_TOKEN: x-ratelimit-reset, when it resets and in how long, exit code 1', async () => {
  const reset = inTwentyMinutes();
  const scanned = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: primary(reset) }));
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stderr, `GitHub rate limit reached; it resets at ${hhmm(reset * 1000)} (in 20 minutes)`);
});

test('a secondary limit: retry-after, not x-ratelimit-reset of a limit not reached', async () => {
  const before = Date.now();
  const scanned = await atlas('github.com/JetBrains/example', recording({ [`${REPOSITORY}/commits/main`]: secondary(20 * 60) }));
  assert.equal(scanned.code, 1);
  const time = /^GitHub rate limit reached; it resets at (\d\d:\d\d) \(in 20 minutes\)$/.exec(scanned.stderr)?.[1];
  assert.ok(time, scanned.stderr);
  // GitHub's answer came between `before` and now: the time is 20 minutes after it, rounded up.
  assert.ok([hhmm(before + 20 * MINUTE), hhmm(Date.now() + 20 * MINUTE)].includes(time), time);
});

test('without GITHUB_TOKEN: it still points at it, with the reset time too', async () => {
  const reset = inTwentyMinutes();
  const scanned = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: primary(reset) }), false);
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stderr, `GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at ${hhmm(reset * 1000)} (in 20 minutes)`);
});

test('no reset time in the answer: said plainly, none guessed; without GITHUB_TOKEN, set it', async () => {
  const limited: Recorded = { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } };
  const token = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: limited }));
  assert.deepEqual(token, { code: 1, stderr: 'GitHub rate limit reached; try again later' });
  const none = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: limited }), false);
  assert.deepEqual(none, { code: 1, stderr: 'GitHub rate limit reached; set GITHUB_TOKEN' });
  // x-ratelimit-reset of a limit with requests left is not the limit reached: no reset time either.
  const left = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: primary(inTwentyMinutes(), { 'x-ratelimit-remaining': '12' }) }));
  assert.deepEqual(left, { code: 1, stderr: 'GitHub rate limit reached; try again later' });
});

test('an organization, a 429 on a file read: the scan stops with the reset time', async () => {
  const reset = inTwentyMinutes();
  const refused: Recorded = { status: 429, body: '429: Too Many Requests', headers: { 'x-ratelimit-reset': String(reset) } };
  const scanned = await atlas('github.com/JetBrains', recording({ [FILE]: refused }));
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stderr, `GitHub rate limit reached; it resets at ${hhmm(reset * 1000)} (in 20 minutes)`);
});

test('rounded up to the minute, at least 1: a reset at hh:mm:20, or one already past', async () => {
  // 14:31:20 seen at 14:11:30: 19 minutes 50 seconds away.
  const reset = Date.UTC(2026, 10, 26, 14, 31, 20) / 1000;
  const page = (now: number, token = true) =>
    errorText({ error: 'unused', rateLimit: { resetsAt: new Date(reset * 1000).toISOString(), token } }, now, { locale: 'en-GB', timeZone: 'UTC' });
  assert.equal(page(Date.UTC(2026, 10, 26, 14, 11, 30)), 'GitHub rate limit reached; it resets at 14:32 (in 20 minutes)');
  assert.equal(page(Date.UTC(2026, 10, 26, 14, 31, 30)), 'GitHub rate limit reached; it resets at 14:32 (in 1 minute)');
  // The CLI rounds the same way.
  const scanned = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: primary(reset) }));
  assert.match(scanned.stderr, /^GitHub rate limit reached; it resets at \d\d:\d\d \(in \d+ minutes?\)$/);
});

test('a reset already past (a clock ahead of GitHub\'s): the next minute, in 1 minute, never a time behind the clock', async () => {
  // Seen at 14:24:10, 3 hours after GitHub's reset time, and 10 seconds after it.
  const now = Date.UTC(2026, 10, 26, 14, 24, 10);
  for (const resetsAt of [new Date(now - 3 * 60 * MINUTE), new Date(now - 10_000)]) {
    const page = errorText({ error: 'unused', rateLimit: { resetsAt: resetsAt.toISOString(), token: true } }, now, { locale: 'en-GB', timeZone: 'UTC' });
    assert.equal(page, 'GitHub rate limit reached; it resets at 14:25 (in 1 minute)');
  }
  // The CLI, on the clock: GitHub's reset 3 hours ago, or seconds ago.
  for (const past of [Math.floor(Date.now() / 1000) - 3 * 60 * 60, Math.floor(Date.now() / 1000) - 10]) {
    const before = Date.now();
    const scanned = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: primary(past) }));
    assert.equal(scanned.code, 1);
    const time = /^GitHub rate limit reached; it resets at (\d\d:\d\d) \(in 1 minute\)$/.exec(scanned.stderr)?.[1];
    assert.ok(time, scanned.stderr);
    const next = (ms: number) => new Date((Math.floor(ms / MINUTE) + 1) * MINUTE).toISOString().slice(11, 16);
    assert.ok([next(before), next(Date.now())].includes(time), time);
  }
});

test('a reset header out of a date\'s range: no reset time, none guessed; the web view answers 400', async (t) => {
  const huge = '99999999999999';
  const outOfRange: Recorded[] = [
    primary(0, { 'x-ratelimit-reset': huge }),
    { ...secondary(0), headers: { 'retry-after': huge } },
  ];
  for (const refused of outOfRange) {
    const scanned = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: refused }));
    assert.deepEqual(scanned, { code: 1, stderr: 'GitHub rate limit reached; try again later' });
    const anonymous = await atlas('github.com/JetBrains/example', recording({ [REPOSITORY]: refused }), false);
    assert.deepEqual(anonymous, { code: 1, stderr: 'GitHub rate limit reached; set GITHUB_TOKEN' });
    const answer = await (await serve(t, recording({ [REPOSITORY]: refused })))('github.com/JetBrains/example');
    assert.deepEqual(answer, {
      status: 400,
      last: { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt: null, token: true } },
    });
  }
});

test('the page: the reset time in the viewer\'s local time and format; without GITHUB_TOKEN, set it; none: the message', () => {
  const resetsAt = '2026-11-26T14:32:00.000Z';
  const now = Date.parse('2026-11-26T14:12:00.000Z');
  const answer = (token: boolean) => ({ error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt, token } });
  assert.equal(
    errorText(answer(true), now, { locale: 'en-GB', timeZone: 'Europe/Amsterdam' }),
    'GitHub rate limit reached; it resets at 15:32 (in 20 minutes)',
  );
  assert.equal(
    errorText(answer(true), now, { locale: 'en-US', timeZone: 'America/New_York' }),
    'GitHub rate limit reached; it resets at 09:32 AM (in 20 minutes)',
  );
  assert.equal(
    errorText(answer(false), now, { locale: 'en-GB', timeZone: 'UTC' }),
    'GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at 14:32 (in 20 minutes)',
  );
  const unknown = { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt: null, token: true } };
  assert.equal(errorText(unknown, now), 'GitHub rate limit reached; try again later');
  assert.equal(errorText({ error: 'Repository not found: https://github.com/JetBrains/nope' }, now), 'Repository not found: https://github.com/JetBrains/nope');
});

/** /api/scan on a web view whose GitHub answers from the recording; `progress` adds &progress. */
async function serve(t: { after(fn: () => unknown): void }, github: Recording, token = true) {
  const options: GitHubOptions = { fetch: replay(github), token: token ? 'test' : undefined };
  const server = createWebServer({
    open: (repo) => openGitHub(repo, options),
    openOrganization: (repo) => (parseGitHubOwner(repo) ? openGitHubOwner(repo, options) : undefined),
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  return async (repo: string, progress = false) => {
    const response = await fetch(`${base}/api/scan?repo=${encodeURIComponent(repo)}${progress ? '&progress' : ''}`);
    const lines = (await response.text()).trimEnd().split('\n').map((line) => JSON.parse(line));
    return { status: response.status, last: lines.at(-1) };
  };
}

test('/api/scan, the rate limit: 400, the message and rateLimit { resetsAt, token }; with &progress, its last line', async (t) => {
  const reset = inTwentyMinutes();
  const resetsAt = new Date(reset * 1000).toISOString();
  const repository = await (await serve(t, recording({ [REPOSITORY]: primary(reset) })))('github.com/JetBrains/example');
  assert.deepEqual(repository, {
    status: 400,
    last: { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt, token: true } },
  });
  const anonymous = await (await serve(t, recording({ [REPOSITORY]: primary(reset) }), false))('github.com/JetBrains/example');
  assert.deepEqual(anonymous.last, { error: 'GitHub rate limit reached; set GITHUB_TOKEN', rateLimit: { resetsAt, token: false } });
  const refused: Recorded = { status: 429, body: '429: Too Many Requests', headers: { 'x-ratelimit-reset': String(reset) } };
  const organization = await (await serve(t, recording({ [FILE]: refused })))('github.com/JetBrains', true);
  assert.deepEqual(organization, {
    status: 200,
    last: { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt, token: true } },
  });
  // The page words it: the reset time, in its viewer's time.
  assert.equal(errorText(organization.last, reset * 1000 - 20 * MINUTE, { locale: 'en-GB', timeZone: 'UTC' }), `GitHub rate limit reached; it resets at ${hhmm(reset * 1000)} (in 20 minutes)`);
});
