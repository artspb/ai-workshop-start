// The decisions in spec/web.md#requests-and-quota, checked on the real server: how many requests each scan
// made, by kind, and the quota GitHub's answers told, for a fresh scan, a stored one, an organization's
// progress, without GITHUB_TOKEN and with answers that carry no quota.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openGitHub, openGitHubOwner, parseGitHubOwner, parseGitHubUrl, type Fetch } from '../src/core/github.ts';
import type { Recording } from '../src/core/replay.ts';
import { meter, quotaBook } from '../src/core/requests.ts';
import { openDirectory } from '../src/local.ts';
import { openStore } from '../src/store.ts';
import { quotaText, readAnswer, requestsText } from '../src/web/public/progress.js';
import { createWebServer, listen } from '../src/web/server.ts';
import { FIXTURE, replayGraphQL } from './helpers.ts';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const commitOf = (name: string) => name.padEnd(40, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 40);
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}, as this repository does it.\n---\n`;

/** When GitHub says its limits reset: Unix seconds, an hour from now. */
const RESET = Math.floor(Date.now() / 1000) + 3600;
const RESETS_AT = new Date(RESET * 1000).toISOString();

/** A repository at its default branch, as GitHub answers it: its lookup, commit, tree and skills. */
function repository(id: string, skills: string[]): Recording {
  const commit = commitOf(id.split('/')[1]);
  const paths = skills.map((name) => `.claude/skills/${name}/SKILL.md`);
  return {
    [`${API}/repos/${id}`]: { status: 200, body: { full_name: id, default_branch: 'main' } },
    [`${API}/repos/${id}/commits/main`]: { status: 200, body: { sha: commit } },
    [`${API}/repos/${id}/git/trees/${commit}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree: paths.map((path) => ({ path, mode: '100644', type: 'blob', sha: '0' })) },
    },
    ...Object.fromEntries(paths.map((path, index) => [`${RAW}/${id}/${commit}/${path}`, { status: 200, body: skill(skills[index]) }])),
  };
}

/** Small: three repositories, three skills between them; one page of the list. */
const SMALL = { alpha: ['review', 'release'], beta: [], gamma: ['bump'] };
const GITHUB: Recording = {
  [`${API}/users/Small`]: { status: 200, body: { login: 'Small', type: 'Organization' } },
  [`${API}/orgs/Small/repos?type=all&per_page=100&page=1`]: {
    status: 200,
    body: Object.keys(SMALL).map((name) => ({ full_name: `Small/${name}`, default_branch: 'main' })),
  },
  ...Object.assign({}, ...Object.entries(SMALL).map(([name, skills]) => repository(`Small/${name}`, skills))),
};

/**
 * The web view as the CLI starts it, GitHub answering from GITHUB: each API answer with the quota headers
 * as GitHub sends them, `remaining` one less each time (`core` 5,000 an hour with the token, 60 without;
 * `graphql` its own), unless `headers` is false; a file read without them, as raw.githubusercontent.com.
 */
async function serve(t: { after(fn: () => unknown): void }, { token = true, headers = true, store = undefined as ReturnType<typeof openStore> | undefined } = {}) {
  const answers = replayGraphQL(GITHUB);
  const used = { core: 0, graphql: 0 };
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push(url);
    const answer = await answers(url, init);
    if (!headers || !url.startsWith(API)) return answer;
    const resource = url === `${API}/graphql` ? 'graphql' : 'core';
    const limit = resource === 'core' && !token ? 60 : 5000;
    const quota = {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(limit - ++used[resource]),
      'x-ratelimit-used': String(used[resource]),
      'x-ratelimit-reset': String(RESET),
      'x-ratelimit-resource': resource,
    };
    return new Response(await answer.arrayBuffer(), { status: answer.status, headers: { 'content-type': 'application/json', ...quota } });
  };
  const options = { fetch, token: token ? 'test' : undefined };
  const server = createWebServer({
    open: (input, counted) => (parseGitHubUrl(input) ? openGitHub(input, { ...options, meter: counted }) : openDirectory(input)),
    openOrganization: (input, counted) => (parseGitHubOwner(input) ? openGitHubOwner(input, { ...options, meter: counted }) : undefined),
    store,
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const get = async (path: string) => (await (await globalThis.fetch(`${base}${path}`)).json()) as any;
  return {
    asked,
    base,
    get,
    scan: (repo: string) => get(`/api/scan?repo=${encodeURIComponent(repo)}`),
    /** /api/scan with &progress: every line, as the page reads it. */
    async progress(repo: string) {
      const lines: any[] = [];
      const answer = await readAnswer(await globalThis.fetch(`${base}/api/scan?repo=${encodeURIComponent(repo)}&progress`), (_, line) => lines.push(line));
      return { lines, answer: answer as any };
    },
  };
}

const core = (remaining: number, limit = 5000) => ({ remaining, limit, resetsAt: RESETS_AT });

function temporaryStore(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return openStore(directory);
}

test('a fresh scan: its requests by kind, REST and file reads, and the quota its last answer told', async (t) => {
  const github = await serve(t);
  const answer = await github.scan('github.com/Small/alpha');
  assert.equal(answer.repository.id, 'Small/alpha');
  // The repository, its commit and its tree; its two skills' files, on no quota.
  assert.deepEqual(answer.requests, { rest: 3, graphql: 0, files: 2 });
  assert.deepEqual(answer.quota, { core: core(4997) });
  // The next scan's requests are its own; the quota, the latest.
  const next = await github.scan('github.com/Small/gamma');
  assert.deepEqual(next.requests, { rest: 3, graphql: 0, files: 1 });
  assert.deepEqual(next.quota, { core: core(4994) });
});

test('an organization: REST, GraphQL queries and file reads; each quota, REST core and GraphQL points', async (t) => {
  const answer = await (await serve(t)).scan('github.com/Small');
  assert.equal(answer.organization.skills, 3);
  // The owner, the list and three trees; one GraphQL query for the three commits; three files.
  assert.deepEqual(answer.requests, { rest: 5, graphql: 1, files: 3 });
  assert.deepEqual(answer.quota, { core: core(4995), graphql: core(4999) });
});

test('an organization\'s progress: each line carries the requests so far and the quota, so Stop can come first', async (t) => {
  const { lines, answer } = await (await serve(t)).progress('github.com/Small');
  assert.deepEqual(lines.map(({ progress }) => progress.scanned), [0, 1, 2, 3]);
  // 0 scanned: the owner and the list, nothing else yet.
  assert.deepEqual(lines[0].requests, { rest: 2, graphql: 0, files: 0 });
  assert.deepEqual(lines[0].quota, { core: core(4998) });
  // As the repositories end, the counts only grow, and the quota only falls.
  for (const [before, after] of lines.slice(1).map((line, index) => [lines[index], line])) {
    for (const kind of ['rest', 'graphql', 'files']) assert.ok(after.requests[kind] >= before.requests[kind], kind);
    assert.ok(after.quota.core.remaining <= before.quota.core.remaining);
  }
  assert.deepEqual(lines.at(-1).requests, answer.requests);
  assert.deepEqual(answer.requests, { rest: 5, graphql: 1, files: 3 });
});

test('without GITHUB_TOKEN: the same counts, against the 60 an hour; no GraphQL, a commit request per repository instead', async (t) => {
  const github = await serve(t, { token: false });
  const one = await github.scan('github.com/Small/alpha');
  assert.deepEqual(one.requests, { rest: 3, graphql: 0, files: 2 });
  assert.deepEqual(one.quota, { core: core(57, 60) });
  const organization = await github.scan('github.com/Small');
  assert.deepEqual(organization.requests, { rest: 8, graphql: 0, files: 3 });
  assert.deepEqual(organization.quota, { core: core(49, 60) });
  assert.equal(requestsText(organization, Date.parse(RESETS_AT) - 20 * 60_000, { locale: 'en-GB', timeZone: 'UTC' }),
    `8 REST requests, 0 GraphQL queries, 3 file reads · 49 of 60 left, resets at ${clock(RESET)}`);
});

test('a stored scan: 0 requests, from the store; the quota last seen; GitHub not asked', async (t) => {
  const github = await serve(t, { store: temporaryStore(t) });
  const scanned = await github.scan('github.com/Small/alpha');
  assert.ok(scanned.stored);
  const asked = github.asked.length;
  const stored = await github.get(`/api/scans/${scanned.stored}`);
  assert.equal(github.asked.length, asked, 'GitHub is not asked for a stored scan');
  assert.deepEqual(stored.requests, { rest: 0, graphql: 0, files: 0 });
  assert.deepEqual(stored.quota, { core: core(4997) });
  assert.equal(requestsText(stored, Date.parse(RESETS_AT) - 20 * 60_000, { locale: 'en-GB', timeZone: 'UTC' }), `0 requests, from the store · 4,997 of 5,000 left, resets at ${clock(RESET)}`);
  // Scanned again at the same commit: only the commit is asked for, the rest is the store's.
  const again = await github.scan('github.com/Small/alpha');
  assert.deepEqual(again.requests, { rest: 2, graphql: 0, files: 0 });
});

test('answers without the quota headers: the counts, and no quota; a quota seen before is kept', async (t) => {
  const github = await serve(t, { headers: false });
  const answer = await github.scan('github.com/Small/alpha');
  assert.deepEqual(answer.requests, { rest: 3, graphql: 0, files: 2 });
  assert.equal(answer.quota, null);
  assert.equal(requestsText(answer, Date.now(), { locale: 'en-US' }), '3 REST requests, 0 GraphQL queries, 2 file reads');
  assert.deepEqual(await github.get('/api/quota'), { quota: null });
  // A local directory asks GitHub nothing: 0 requests, no quota.
  const local = await github.scan(FIXTURE);
  assert.deepEqual([local.requests, local.quota], [{ rest: 0, graphql: 0, files: 0 }, null]);
  assert.equal(requestsText(local), '0 requests');
  // Answers with some of the headers, or a value that is not a number: not a quota; one seen before stays.
  const book = quotaBook();
  book.record(new Headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(RESET) }));
  book.record(new Headers({ 'x-ratelimit-remaining': 'x', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(RESET), 'x-ratelimit-resource': 'core' }));
  assert.equal(book.current(), null);
  book.record(new Headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': String(RESET), 'x-ratelimit-resource': 'core' }));
  book.record(new Headers());
  assert.deepEqual(book.current(), { core: core(10, 60) });
});

test('the quota, from answers out of order: the lowest left in a window; a later window replaces it', () => {
  const book = quotaBook();
  const answer = (remaining: number, reset: number) =>
    new Headers({ 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' });
  book.record(answer(4000, RESET));
  book.record(answer(4002, RESET)); // an answer that came late
  assert.deepEqual(book.current(), { core: core(4000) });
  book.record(answer(4999, RESET - 3600)); // the window before
  assert.deepEqual(book.current(), { core: core(4000) });
  book.record(answer(4999, RESET + 3600)); // the next window
  assert.deepEqual(book.current(), { core: { remaining: 4999, limit: 5000, resetsAt: new Date((RESET + 3600) * 1000).toISOString() } });
  // A meter counts only what GitHub answered: a request that failed is not counted.
  const counted = meter(book);
  const failing = counted.wrap(() => Promise.reject(new TypeError('fetch failed')));
  return assert.rejects(failing(`${API}/repos/a/b`)).then(() => assert.deepEqual(counted.requests(), { rest: 0, graphql: 0, files: 0 }));
});

test('before any scan: /api/quota is null; after one, the quota it saw; GitHub is never asked just to show it', async (t) => {
  const github = await serve(t);
  assert.deepEqual(await github.get('/api/quota'), { quota: null });
  assert.deepEqual(github.asked, []);
  await github.scan('github.com/Small');
  const asked = github.asked.length;
  assert.deepEqual(await github.get('/api/quota'), { quota: { core: core(4995), graphql: core(4999) } });
  assert.equal(github.asked.length, asked);
});

/** `HH:MM` of Unix seconds in UTC, rounded up to the minute. */
function clock(seconds: number) {
  return new Date(Math.ceil(seconds / 60) * 60_000).toISOString().slice(11, 16);
}

test('the page: the counts and the quota in the viewer\'s local time and number format; none seen, the counts alone', () => {
  const now = Date.parse('2026-11-26T17:13:00.000Z');
  const quota = { core: { remaining: 4059, limit: 5000, resetsAt: '2026-11-26T17:32:20.000Z' } };
  const answer = { requests: { rest: 312, graphql: 26, files: 1904 }, quota };
  assert.equal(requestsText(answer, now, { locale: 'en-GB', timeZone: 'UTC' }), '312 REST requests, 26 GraphQL queries, 1,904 file reads · 4,059 of 5,000 left, resets at 17:33');
  assert.equal(requestsText(answer, now, { locale: 'de-DE', timeZone: 'Europe/Berlin' }), '312 REST requests, 26 GraphQL queries, 1.904 file reads · 4.059 of 5.000 left, resets at 18:33');
  // One of each; GraphQL's points after REST's.
  const graphql = { remaining: 4974, limit: 5000, resetsAt: '2026-11-26T17:40:00.000Z' };
  assert.equal(
    requestsText({ requests: { rest: 1, graphql: 1, files: 1 }, quota: { ...quota, graphql } }, now, { locale: 'en-US', timeZone: 'UTC' }),
    '1 REST request, 1 GraphQL query, 1 file read · 4,059 of 5,000 left, resets at 05:33 PM · GraphQL: 4,974 of 5,000 points left, resets at 05:40 PM',
  );
  // A limit whose reset is past has reset since: all of it left.
  assert.equal(requestsText({ requests: { rest: 0, graphql: 0, files: 0 }, quota, stored: 'abc' }, Date.parse('2026-11-26T18:00:00.000Z'), { locale: 'en-GB' }), '0 requests, from the store · 5,000 of 5,000 left');
  // Before any scan: the quota alone, or nothing.
  assert.equal(quotaText(quota, now, { locale: 'en-GB', timeZone: 'UTC' }), 'GitHub quota: 4,059 of 5,000 left, resets at 17:33');
  assert.equal(quotaText({ core: { remaining: 58, limit: 60, resetsAt: '2026-11-26T17:32:20.000Z' } }, now, { locale: 'en-GB', timeZone: 'UTC' }), 'GitHub quota: 58 of 60 left, resets at 17:33');
  assert.equal(quotaText(null, now), '');
  assert.equal(requestsText({ error: 'boom' } as any, now), '');
});

test('the page: the requests line under the box, under the status', async (t) => {
  const { base } = await serve(t);
  const html = await (await globalThis.fetch(`${base}/`)).text();
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(header.indexOf('id="status"') < header.indexOf('<p id="requests" hidden></p>'), 'the requests line, under the status, in the header');
});
