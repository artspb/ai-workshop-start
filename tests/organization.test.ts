// The decisions in spec/analysis.md#organization and spec/cli.md#organization, checked on what the
// real command prints for an organization and a user that GitHub answers from recordings below.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/commands.ts';
import { scanOrganization } from '../src/core/organization.ts';
import { openGitHub, openGitHubOwner, parseGitHubOwner, parseGitHubUrl, type Fetch } from '../src/core/github.ts';
import { type Recording } from '../src/core/replay.ts';
import { replayGraphQL } from './helpers.ts';
import { openStore } from '../src/store.ts';
import { filterRepositories } from '../src/web/public/filter.js';
import { addressRequest, historyView, scanSignals, storedOnPage } from '../src/web/public/history.js';
import { progressText, progressUrl, readAnswer, stoppedText } from '../src/web/public/progress.js';
import { createWebServer, listen } from '../src/web/server.ts';

const API = 'https://api.github.com';
const commitOf = (name: string) => name.padEnd(40, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 40);

type Fake = { name: string; branch?: string; skills?: Record<string, string>; answer?: Recording[string] };

/** A repository as GitHub answers it, at its default branch: its tree, and the bytes of each skill. */
function repository(owner: string, { name, branch = 'main', skills = {}, answer }: Fake): Recording {
  const id = `${owner}/${name}`;
  const commit = commitOf(name);
  const tree = Object.keys(skills).map((path) => ({ path, mode: '100644', type: 'blob', sha: '0' }));
  return {
    [`${API}/repos/${id}`]: { status: 200, body: { full_name: id, default_branch: branch } },
    [`${API}/repos/${id}/commits/${encodeURIComponent(branch)}`]: answer ?? { status: 200, body: { sha: commit } },
    [`${API}/repos/${id}/git/trees/${commit}?recursive=1`]: { status: 200, body: { truncated: false, tree } },
    ...Object.fromEntries(
      Object.entries(skills).map(([path, body]) => [`https://raw.githubusercontent.com/${id}/${commit}/${path}`, { status: 200, body }]),
    ),
  };
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;

/**
 * JetBrains: 101 repositories, two pages of the list. Three with skills, one of them with a
 * malformed one; an empty one; the rest without skills.
 */
const ORGANIZATION: Fake[] = [
  { name: 'zeta', skills: { '.claude/skills/release/SKILL.md': skill('release', 'Release zeta. Then announce it.') } },
  {
    name: 'Alpha',
    branch: 'release/2026',
    skills: {
      '.agents/skills/review/SKILL.md': skill('review', 'Review a change.'),
      '.claude/skills/review/SKILL.md': skill('review', 'Review a change.'),
      '.github/skills/broken/SKILL.md': 'no front matter',
    },
  },
  { name: 'beta', skills: { 'docs/SKILL.md': skill('not-a-skill', 'Outside a skill root.') } },
  { name: 'empty', answer: { status: 409, body: { message: 'Git Repository is empty.' } } },
  ...Array.from({ length: 96 }, (_, index) => ({ name: `repo-${String(index).padStart(2, '0')}` })),
  { name: 'kotlin', skills: { 'tools/.claude/skills/bump/SKILL.md': skill('bump', 'Bump a version.') } },
];

/** What GitHub answers for the organization JetBrains, the user artspb and the unknown owner nobody. */
function recording(overrides: Recording = {}): Recording {
  const listed = (owner: string, fakes: Fake[]) =>
    fakes.map(({ name, branch = 'main' }) => ({ full_name: `${owner}/${name}`, default_branch: branch }));
  return {
    [`${API}/users/JetBrains`]: { status: 200, body: { login: 'JetBrains', type: 'Organization' } },
    [`${API}/orgs/JetBrains/repos?type=all&per_page=100&page=1`]: { status: 200, body: listed('JetBrains', ORGANIZATION.slice(0, 100)) },
    [`${API}/orgs/JetBrains/repos?type=all&per_page=100&page=2`]: { status: 200, body: listed('JetBrains', ORGANIZATION.slice(100)) },
    ...Object.assign({}, ...ORGANIZATION.map((fake) => repository('JetBrains', fake))),
    [`${API}/users/artspb`]: { status: 200, body: { login: 'artspb', type: 'User' } },
    [`${API}/users/artspb/repos?type=owner&per_page=100&page=1`]: { status: 200, body: listed('artspb', [{ name: 'workshop' }]) },
    ...repository('artspb', { name: 'workshop', skills: { '.agents/skills/demo/SKILL.md': skill('demo', 'A demo.') } }),
    [`${API}/users/nobody`]: { status: 404, body: { message: 'Not Found' } },
    ...overrides,
  };
}

/** `skill-atlas <args>` as the CLI runs it, with a token, GitHub answering from the recording; every URL asked for. */
async function atlas(args: string[], { github = recording(), store = undefined as ReturnType<typeof openStore> | undefined } = {}) {
  const asked: string[] = [];
  const authorized: string[] = []; // the URLs asked for with the token
  const answers = replayGraphQL(github);
  const fetch: Fetch = (url, init) => {
    asked.push(url);
    if (init?.headers?.Authorization === 'Bearer test') authorized.push(url);
    return answers(url, init);
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    open: (input) => openGitHub(input, { fetch, token: 'test' }),
    openOrganization: (input) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token: 'test' }) : undefined),
    store,
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), asked, authorized };
}

test('an organization: every repository, both pages of the list; each one with skills as scan prints it, sorted by name', async () => {
  const scanned = await atlas(['scan', 'https://github.com/JetBrains/']);
  assert.equal(scanned.code, 0, scanned.stderr);
  const blob = (name: string) => `https://github.com/JetBrains/${name}/blob/${commitOf(name)}`;
  assert.equal(
    scanned.stdout,
    [
      'JetBrains · 101 repositories · 4 skills',
      '',
      'JetBrains/Alpha · 2 skills',
      'broken',
      `  ${blob('Alpha')}/.github/skills/broken/SKILL.md`,
      'review — Review a change.',
      `  ${blob('Alpha')}/.agents/skills/review/SKILL.md`,
      '  also in .claude/skills/review/SKILL.md',
      '',
      'JetBrains/kotlin · 1 skill',
      'bump — Bump a version.',
      `  ${blob('kotlin')}/tools/.claude/skills/bump/SKILL.md`,
      '',
      'JetBrains/zeta · 1 skill',
      'release — Release zeta.',
      `  ${blob('zeta')}/.claude/skills/release/SKILL.md`,
    ].join('\n'),
  );
  // An empty repository: a warning, the others go on. Each warning names its repository.
  assert.equal(
    scanned.stderr,
    [
      'warning: JetBrains/Alpha: .github/skills/broken/SKILL.md: no front matter; using the directory name',
      `warning: JetBrains/empty: GitHub answered 409 for ${API}/repos/JetBrains/empty/commits/main: Git Repository is empty.`,
    ].join('\n'),
  );
  // Each repository at its default branch, listed through its tree, even with a token: no code search.
  assert.ok(scanned.asked.includes(`${API}/repos/JetBrains/Alpha/git/trees/${commitOf('Alpha')}?recursive=1`));
  assert.deepEqual(scanned.asked.filter((url) => url.includes('/search/')), []);
});

test('a user: the repositories they own', async () => {
  const scanned = await atlas(['scan', 'github.com/artspb']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(
    scanned.stdout,
    [
      'artspb · 1 repository · 1 skill',
      '',
      'artspb/workshop · 1 skill',
      'demo — A demo.',
      `  https://github.com/artspb/workshop/blob/${commitOf('workshop')}/.agents/skills/demo/SKILL.md`,
    ].join('\n'),
  );
});

test('an owner without skills: only the counts', async () => {
  const scanned = await atlas(['scan', 'github.com/artspb'], {
    github: recording({ [`${API}/users/artspb/repos?type=owner&per_page=100&page=1`]: { status: 200, body: [] } }),
  });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, 'artspb · 0 repositories · 0 skills');
});

test('no such owner → a clear message, exit code 1', async () => {
  const scanned = await atlas(['scan', 'github.com/nobody']);
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'Organization or user not found: https://github.com/nobody');
});

test('the rate limit in one repository: the scan stops, exit code 1', async () => {
  const limited = { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } };
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    github: recording({ [`${API}/repos/JetBrains/repo-50/git/trees/${commitOf('repo-50')}?recursive=1`]: limited }),
  });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rate limit reached; try again later');
  // It stops: the repositories not started yet are not asked for, not even later.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!scanned.asked.includes(`${API}/repos/JetBrains/zeta/git/trees/${commitOf('zeta')}?recursive=1`), 'the last repository was not scanned');
});

test('a rate limit on a file read: the scan stops, exit code 1', async () => {
  const file = `https://raw.githubusercontent.com/JetBrains/zeta/${commitOf('zeta')}/.claude/skills/release/SKILL.md`;
  const scanned = await atlas(['scan', 'github.com/JetBrains'], { github: recording({ [file]: { status: 429, body: '429: Too Many Requests' } }) });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rate limit reached; try again later');
});

test('a rejected token: the scan stops, exit code 1', async () => {
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    github: recording({ [`${API}/repos/JetBrains/Alpha/git/trees/${commitOf('Alpha')}?recursive=1`]: { status: 401, body: { message: 'Bad credentials' } } }),
  });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rejected the token in GITHUB_TOKEN');
});

test('a token rejected by the time the files are read: the scan stops, exit code 1, the 404 is not "not found"', async (t) => {
  // raw.githubusercontent.com answers 404, not 401, for a token it does not accept; the API answers 401.
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  const file = `https://raw.githubusercontent.com/JetBrains/zeta/${commitOf('zeta')}/.claude/skills/release/SKILL.md`;
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    store,
    github: recording({
      [file]: { status: 404, body: '404: Not Found' },
      [`${API}/rate_limit`]: { status: 401, body: { message: 'Bad credentials' } },
    }),
  });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rejected the token in GITHUB_TOKEN');
  assert.ok(!(await store.list()).some((scan) => scan.repository.id === 'JetBrains/zeta'));
});

test('a file not found with a token the API accepts: a warning, as without a token', async () => {
  const file = `https://raw.githubusercontent.com/JetBrains/zeta/${commitOf('zeta')}/.claude/skills/release/SKILL.md`;
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    github: recording({
      [file]: { status: 404, body: '404: Not Found' },
      [`${API}/rate_limit`]: { status: 200, body: { resources: {} } },
    }),
  });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.ok(scanned.asked.includes(`${API}/rate_limit`));
  assert.ok(scanned.authorized.includes(`${API}/rate_limit`));
  assert.ok(
    scanned.stderr.includes('warning: JetBrains/zeta: .claude/skills/release/SKILL.md: listed, but not found at the scanned commit; skipped'),
    scanned.stderr,
  );
});

test('GitHub unreachable: the scan stops, exit code 1', async () => {
  const github = recording();
  delete github[`${API}/repos/JetBrains/beta/git/trees/${commitOf('beta')}?recursive=1`]; // not recorded: the fetch fails, as without a network
  const scanned = await atlas(['scan', 'github.com/JetBrains'], { github });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.match(scanned.stderr, /^Cannot reach GitHub: not recorded: /);
});

test('a branch gone since the list: a warning, the others go on', async () => {
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    github: recording({ [`${API}/repos/JetBrains/zeta/commits/main`]: { status: 404, body: { message: 'No commit found for SHA: main' } } }),
  });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout.split('\n')[0], 'JetBrains · 101 repositories · 3 skills');
  assert.ok(!scanned.stdout.includes('JetBrains/zeta'));
  assert.ok(scanned.stdout.includes('JetBrains/kotlin · 1 skill'));
  assert.ok(scanned.stderr.includes('warning: JetBrains/zeta: Not found in https://github.com/JetBrains/zeta: main'), scanned.stderr);
});

test('with a token, every request carries it, a file read too: a private repository is read', async () => {
  const scanned = await atlas(['scan', 'github.com/JetBrains']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.ok(scanned.asked.some((url) => url.startsWith('https://raw.githubusercontent.com/')));
  assert.deepEqual(
    scanned.asked.filter((url) => !scanned.authorized.includes(url)),
    [],
  );
  // A private repository's file answers 404 without the token: with it, the skill is read.
  const file = `https://raw.githubusercontent.com/JetBrains/zeta/${commitOf('zeta')}/.claude/skills/release/SKILL.md`;
  const answers = replayGraphQL(recording());
  const privately: Fetch = (url, init) =>
    url === file && init?.headers?.Authorization !== 'Bearer test'
      ? Promise.resolve(new Response('404: Not Found', { status: 404 }))
      : answers(url, init);
  const source = await openGitHub('github.com/JetBrains/zeta/tree/main', { fetch: privately, token: 'test' });
  assert.ok(await source.read('.claude/skills/release/SKILL.md'));
});

test('each repository is a stored scan of its own; the list of repositories is asked for every time', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  const first = await atlas(['scan', 'github.com/JetBrains'], { store });
  assert.equal(first.code, 0, first.stderr);
  // Every repository but the empty one is stored, each at its default branch.
  const stored = await store.list();
  assert.equal(stored.length, 100);
  assert.deepEqual(stored.find((scan) => scan.repository.id === 'JetBrains/Alpha')?.refs, ['release/2026']);

  const second = await atlas(['scan', 'github.com/JetBrains'], { store });
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stderr, first.stderr);
  assert.ok(second.asked.includes(`${API}/orgs/JetBrains/repos?type=all&per_page=100&page=1`));
  assert.deepEqual(second.asked.filter((url) => url.includes('/git/trees/') || url.startsWith('https://raw.')), []);
});

test('github.com/<owner> is an owner; github.com/<owner>/<repo> is a repository', () => {
  for (const input of ['github.com/JetBrains', 'https://github.com/JetBrains/', 'www.github.com/JetBrains']) {
    assert.equal(parseGitHubOwner(input), 'JetBrains', input);
    assert.equal(parseGitHubUrl(input), undefined, input);
  }
  assert.equal(parseGitHubOwner('github.com/JetBrains/kotlin'), undefined);
  assert.equal(parseGitHubOwner('github.com'), undefined);
});

test('a repository still scans as one, with an organization client', async () => {
  const scanned = await atlas(['scan', 'github.com/JetBrains/zeta/tree/main']);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout.split('\n')[0], 'JetBrains/zeta · 1 skill');
});

/**
 * `skill-atlas serve` as the CLI starts it, with a token, GitHub answering from the recording;
 * `get` asks /api/scan for an input.
 */
async function serve(t: { after(fn: () => unknown): void }, { github = recording(), store = undefined as ReturnType<typeof openStore> | undefined } = {}) {
  const fetch = replayGraphQL(github);
  const server = createWebServer({
    open: (input) => openGitHub(input, { fetch, token: 'test' }),
    openOrganization: (input) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token: 'test' }) : undefined),
    store,
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  return Object.assign(
    async (repo: string) => {
      const response = await globalThis.fetch(`${base}/api/scan?repo=${encodeURIComponent(repo)}`);
      return { status: response.status, body: (await response.json()) as any };
    },
    {
      /** /api/scan with `&progress`: its status, content type and every line of its body. */
      async progress(repo: string) {
        const response = await globalThis.fetch(`${base}/api/scan?repo=${encodeURIComponent(repo)}&progress`);
        const text = await response.text();
        const type = response.headers.get('content-type');
        const lines = type?.startsWith('application/x-ndjson') ? text.trimEnd().split('\n').map((line) => JSON.parse(line)) : [JSON.parse(text)];
        return { status: response.status, type, lines };
      },
      base,
    },
  );
}

test('the web view, an organization: the counts, each repository with skills as /api/scan answers it, sorted; the warnings with their repository', async (t) => {
  const get = await serve(t);
  const { status, body } = await get('https://github.com/JetBrains/');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.organization, { id: 'JetBrains', url: 'https://github.com/JetBrains', repositories: 101, skills: 4 });
  assert.deepEqual(
    body.repositories.map(({ repository, skills }: any) => [repository.id, skills.map((skill: any) => [skill.name, skill.link, skill.copies])]),
    [
      [
        'JetBrains/Alpha',
        [
          ['broken', `https://github.com/JetBrains/Alpha/blob/${commitOf('Alpha')}/.github/skills/broken/SKILL.md`, []],
          ['review', `https://github.com/JetBrains/Alpha/blob/${commitOf('Alpha')}/.agents/skills/review/SKILL.md`, ['.claude/skills/review/SKILL.md']],
        ],
      ],
      ['JetBrains/kotlin', [['bump', `https://github.com/JetBrains/kotlin/blob/${commitOf('kotlin')}/tools/.claude/skills/bump/SKILL.md`, []]]],
      ['JetBrains/zeta', [['release', `https://github.com/JetBrains/zeta/blob/${commitOf('zeta')}/.claude/skills/release/SKILL.md`, []]]],
    ],
  );
  // Each repository as /api/scan answers it: the whole description, its own warnings, not stored without a store.
  const zeta = body.repositories[2];
  assert.equal(zeta.skills[0].description, 'Release zeta. Then announce it.');
  assert.deepEqual(zeta.warnings, []);
  assert.equal(zeta.stored, null);
  assert.deepEqual(body.repositories[0].warnings, ['.github/skills/broken/SKILL.md: no front matter; using the directory name']);
  // The same as the CLI prints, an empty repository's warning too.
  const cli = await atlas(['scan', 'https://github.com/JetBrains/']);
  assert.deepEqual(body.warnings.map((warning: string) => `warning: ${warning}`).join('\n'), cli.stderr);
  assert.deepEqual(body.warnings, [
    'JetBrains/Alpha: .github/skills/broken/SKILL.md: no front matter; using the directory name',
    `JetBrains/empty: GitHub answered 409 for ${API}/repos/JetBrains/empty/commits/main: Git Repository is empty.`,
  ]);
});

test('the web view, a user: the repositories they own; an owner without skills: only the counts', async (t) => {
  const user = await (await serve(t))('github.com/artspb');
  assert.equal(user.status, 200);
  assert.deepEqual(user.body.organization, { id: 'artspb', url: 'https://github.com/artspb', repositories: 1, skills: 1 });
  assert.deepEqual(user.body.repositories.map(({ repository }: any) => repository.id), ['artspb/workshop']);
  const none = await (
    await serve(t, { github: recording({ [`${API}/users/artspb/repos?type=owner&per_page=100&page=1`]: { status: 200, body: [] } }) })
  )('github.com/artspb');
  assert.deepEqual(none, {
    status: 200,
    body: { organization: { id: 'artspb', url: 'https://github.com/artspb', repositories: 0, skills: 0 }, repositories: [], warnings: [] },
  });
});

test('the web view, an organization that cannot be scanned: no such owner, the rate limit, a rejected token, GitHub unreachable → 400 with the CLI message', async (t) => {
  assert.deepEqual(await (await serve(t))('github.com/nobody'), {
    status: 400,
    body: { error: 'Organization or user not found: https://github.com/nobody' },
  });
  const limited = { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } };
  assert.deepEqual(await (await serve(t, { github: recording({ [`${API}/repos/JetBrains/repo-50/git/trees/${commitOf('repo-50')}?recursive=1`]: limited }) }))('github.com/JetBrains'), {
    status: 400,
    body: { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt: null, token: true } },
  });
  const rejected = { status: 401, body: { message: 'Bad credentials' } };
  assert.deepEqual(await (await serve(t, { github: recording({ [`${API}/repos/JetBrains/Alpha/git/trees/${commitOf('Alpha')}?recursive=1`]: rejected }) }))('github.com/JetBrains'), {
    status: 400,
    body: { error: 'GitHub rejected the token in GITHUB_TOKEN' },
  });
  const github = recording();
  delete github[`${API}/repos/JetBrains/beta/git/trees/${commitOf('beta')}?recursive=1`];
  const unreachable = await (await serve(t, { github }))('github.com/JetBrains');
  assert.equal(unreachable.status, 400);
  assert.match(unreachable.body.error, /^Cannot reach GitHub: not recorded: /);
});

test('the web view, an organization: each repository is a stored scan of its own, shared with the CLI', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  const { status, body } = await (await serve(t, { store }))('github.com/JetBrains');
  assert.equal(status, 200);
  const stored = await store.list();
  assert.equal(stored.length, 100);
  for (const { repository, stored: id } of body.repositories) {
    assert.equal(stored.find((scan) => scan.id === id)?.repository.id, repository.id, repository.id);
  }
  // On the page, none of them is marked in Scanned before: the page holds many.
  assert.equal(storedOnPage(body), null);
  assert.ok(historyView(await store.list(), storedOnPage(body)).rows.every((row) => !row.current));
  // The CLI finds them stored: no tree, no file read again.
  const cli = await atlas(['scan', 'github.com/JetBrains'], { store });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(cli.asked.filter((url) => url.includes('/git/trees/') || url.startsWith('https://raw.')), []);
});

test('the web view, a repository still scans as one, with an organization client', async (t) => {
  const { status, body } = await (await serve(t))('github.com/JetBrains/zeta/tree/main');
  assert.equal(status, 200);
  assert.equal(body.repository.id, 'JetBrains/zeta');
  assert.equal(body.organization, undefined);
});

test('the web view, an organization under a filter: a repository heading keeps its whole skill count', async (t) => {
  const { body } = await (await serve(t))('github.com/JetBrains');
  assert.deepEqual(
    filterRepositories(body.repositories, 'review').map(({ repository, skills, total }: any) => [repository.id, skills.length, total]),
    [['JetBrains/Alpha', 1, 2]],
  );
});

test('the web view, an organization the page left: the repositories not started yet are not asked for', async (t) => {
  // 100 repositories without skills, GitHub answering in 20 ms each.
  const names = Array.from({ length: 100 }, (_, index) => ({ name: `slow-${String(index).padStart(3, '0')}` }));
  const answers = replayGraphQL({
    [`${API}/users/Slow`]: { status: 200, body: { login: 'Slow', type: 'Organization' } },
    [`${API}/orgs/Slow/repos?type=all&per_page=100&page=1`]: {
      status: 200,
      body: names.map(({ name }) => ({ full_name: `Slow/${name}`, default_branch: 'main' })),
    },
    [`${API}/orgs/Slow/repos?type=all&per_page=100&page=2`]: { status: 200, body: [] },
    ...Object.assign({}, ...names.map((fake) => repository('Slow', fake))),
  });
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push(url);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return answers(url, init);
  };
  const server = createWebServer({
    open: (input) => openGitHub(input, { fetch, token: 'test' }),
    openOrganization: (input) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token: 'test' }) : undefined),
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const started = () => new Set(asked.filter((url) => /\/repos\/Slow\/[^/]+\/git\/trees\//.test(url))).size;
  // Unaborted, every repository is scanned: the test would see the difference.
  // The page leaves the scan as it does on another scan or *back*: by asking for the next one's signal.
  const nextScan = scanSignals();
  const page = globalThis.fetch(`${base}/api/scan?repo=github.com%2FSlow`, { signal: nextScan() });
  await new Promise((resolve) => setTimeout(resolve, 150));
  nextScan();
  await assert.rejects(page, { name: 'AbortError' });
  const atAbort = started();
  assert.ok(atAbort > 0 && atAbort < 100, `started at the abort: ${atAbort}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // At most the 8 repositories being scanned at the abort, whose scans end; none started after.
  assert.ok(started() <= atAbort + 8, `started at the abort: ${atAbort}, later: ${started()}`);
  assert.ok(started() < 100, `started: ${started()}`);
});

test('the web view, an organization with &progress: NDJSON, the repositories scanned of how many, then the answer as without it', async (t) => {
  const get = await serve(t);
  const { status, type, lines } = await get.progress('github.com/JetBrains');
  assert.equal(status, 200);
  assert.equal(type, 'application/x-ndjson; charset=utf-8');
  // 0 first, then one more as each repository ends, scanned or skipped (the empty one too).
  assert.deepEqual(
    lines.slice(0, -1),
    Array.from({ length: 102 }, (_, scanned) => ({ progress: { scanned, repositories: 101 } })),
  );
  assert.deepEqual(lines.at(-1), (await get('github.com/JetBrains')).body);
  // A user too; an owner with no repository: only 0 of 0.
  const user = await get.progress('github.com/artspb');
  assert.deepEqual(user.lines.slice(0, -1), [{ progress: { scanned: 0, repositories: 1 } }, { progress: { scanned: 1, repositories: 1 } }]);
  const none = await (
    await serve(t, { github: recording({ [`${API}/users/artspb/repos?type=owner&per_page=100&page=1`]: { status: 200, body: [] } }) })
  ).progress('github.com/artspb');
  assert.deepEqual(none.lines, [
    { progress: { scanned: 0, repositories: 0 } },
    { organization: { id: 'artspb', url: 'https://github.com/artspb', repositories: 0, skills: 0 }, repositories: [], warnings: [] },
  ]);
});

test('the web view, &progress: no such owner, a repository → JSON, as without it; a scan failing on the way → its last line { error }', async (t) => {
  const get = await serve(t);
  assert.deepEqual(await get.progress('github.com/nobody'), {
    status: 400,
    type: 'application/json; charset=utf-8',
    lines: [{ error: 'Organization or user not found: https://github.com/nobody' }],
  });
  const repository = await get.progress('github.com/JetBrains/zeta/tree/main');
  assert.equal(repository.status, 200);
  assert.equal(repository.type, 'application/json; charset=utf-8');
  assert.deepEqual(repository.lines, [(await get('github.com/JetBrains/zeta/tree/main')).body]);
  const limited = { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } };
  const failed = await (await serve(t, { github: recording({ [`${API}/repos/JetBrains/repo-50/git/trees/${commitOf('repo-50')}?recursive=1`]: limited }) })).progress('github.com/JetBrains');
  assert.equal(failed.status, 200);
  assert.equal(failed.type, 'application/x-ndjson; charset=utf-8');
  assert.deepEqual(failed.lines[0], { progress: { scanned: 0, repositories: 101 } });
  assert.ok(failed.lines.slice(0, -1).every((line: any) => line.progress && line.progress.scanned < 101));
  assert.deepEqual(failed.lines.at(-1), { error: 'GitHub rate limit reached; try again later', rateLimit: { resetsAt: null, token: true } });
});

test('the page reads the progress, then the answer; a repository and a stored scan as JSON', async (t) => {
  const get = await serve(t);
  // The page asks with &progress for a scan, not for a stored scan.
  const request = addressRequest('?repo=github.com/JetBrains')!;
  assert.equal(progressUrl(request), '/api/scan?repo=github.com%2FJetBrains&progress');
  assert.equal(progressUrl(addressRequest('?scan=abc')!), '/api/scans/abc');
  const seen: unknown[] = [];
  const answer = await readAnswer(await globalThis.fetch(`${get.base}${progressUrl(request)}`), (progress) => seen.push(progress));
  assert.deepEqual(answer, (await get('github.com/JetBrains')).body);
  assert.equal(seen.length, 102);
  assert.deepEqual(seen.at(-1), { scanned: 101, repositories: 101 });
  const zeta = addressRequest('?repo=github.com/JetBrains/zeta')!;
  const one: any = await readAnswer(await globalThis.fetch(`${get.base}${progressUrl(zeta)}`), () => assert.fail('no progress for a repository'));
  assert.equal(one.repository.id, 'JetBrains/zeta');
  const failed = await readAnswer(
    await globalThis.fetch(`${(await serve(t, { github: recording({ [`${API}/repos/JetBrains/Alpha/git/trees/${commitOf('Alpha')}?recursive=1`]: { status: 401, body: {} } }) })).base}${progressUrl(request)}`),
  );
  assert.deepEqual(failed, { error: 'GitHub rejected the token in GITHUB_TOKEN' });
});

test('the page while a scan runs and once stopped: what it scans, how many repositories of how many', () => {
  assert.equal(progressText('github.com/JetBrains/kotlin'), 'Scanning github.com/JetBrains/kotlin…');
  assert.equal(progressText('github.com/JetBrains', { scanned: 37, repositories: 120 }), 'Scanning github.com/JetBrains… 37 of 120 repositories');
  assert.equal(progressText('github.com/artspb', { scanned: 0, repositories: 1 }), 'Scanning github.com/artspb… 0 of 1 repository');
  assert.equal(stoppedText('github.com/JetBrains/kotlin', null), 'Stopped scanning github.com/JetBrains/kotlin');
  assert.equal(
    stoppedText('github.com/JetBrains', { scanned: 37, repositories: 120 }),
    'Stopped scanning github.com/JetBrains at 37 of 120 repositories; the ones scanned are in Scanned before',
  );
});

test('the web view, Stop on an organization with &progress: no repository not started yet is asked for; the ones scanned are stored', async (t) => {
  // 100 repositories without skills, GitHub answering in 20 ms each.
  const names = Array.from({ length: 100 }, (_, index) => ({ name: `slow-${String(index).padStart(3, '0')}` }));
  const answers = replayGraphQL({
    [`${API}/users/Slow`]: { status: 200, body: { login: 'Slow', type: 'Organization' } },
    [`${API}/orgs/Slow/repos?type=all&per_page=100&page=1`]: {
      status: 200,
      body: names.map(({ name }) => ({ full_name: `Slow/${name}`, default_branch: 'main' })),
    },
    [`${API}/orgs/Slow/repos?type=all&per_page=100&page=2`]: { status: 200, body: [] },
    ...Object.assign({}, ...names.map((fake) => repository('Slow', fake))),
  });
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push(url);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return answers(url, init);
  };
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  const server = createWebServer({
    open: (input) => openGitHub(input, { fetch, token: 'test' }),
    openOrganization: (input) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token: 'test' }) : undefined),
    store,
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const started = () => new Set(asked.filter((url) => /\/repos\/Slow\/[^/]+\/git\/trees\//.test(url))).size;
  // Stop aborts the scan as the page does another scan: by asking for the next one's signal.
  const nextScan = scanSignals();
  const seen: { scanned: number; repositories: number }[] = [];
  const page = globalThis
    .fetch(`${base}${progressUrl(addressRequest('?repo=github.com/Slow')!)}`, { signal: nextScan() })
    .then((response) => readAnswer(response, (progress) => seen.push(progress)));
  const deadline = Date.now() + 5000;
  while (!seen.some(({ scanned }) => scanned >= 10)) {
    assert.ok(Date.now() < deadline, `progress seen: ${JSON.stringify(seen.at(-1))}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  nextScan();
  await assert.rejects(page, { name: 'AbortError' });
  const atStop = started();
  assert.ok(atStop < 100, `started at the stop: ${atStop}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // At most the 8 repositories being scanned at the stop, whose scans end; none started after.
  assert.ok(started() <= atStop + 8, `started at the stop: ${atStop}, later: ${started()}`);
  assert.ok(started() < 100, `started: ${started()}`);
  // Every repository scanned before the stop is a stored scan of its own, in Scanned before.
  const scanned = seen.at(-1)!.scanned;
  assert.ok((await store.list()).length >= scanned, `stored: ${(await store.list()).length}, scanned: ${scanned}`);
});

// The request budget, spec/analysis.md#the-request-budget: a rescan with every repository stored
// asks for the list and the commits, nothing else.

/** Big: 250 repositories without skills, three pages of the list, three GraphQL queries. */
const BIG: Fake[] = Array.from({ length: 250 }, (_, index) => ({ name: `big-${String(index).padStart(3, '0')}` }));

function bigRecording(overrides: Recording = {}): Recording {
  const page = (number: number) => BIG.slice((number - 1) * 100, number * 100).map(({ name }) => ({ full_name: `Big/${name}`, default_branch: 'main' }));
  return {
    [`${API}/users/Big`]: { status: 200, body: { login: 'Big', type: 'Organization' } },
    [`${API}/orgs/Big/repos?type=all&per_page=100&page=1`]: { status: 200, body: page(1) },
    [`${API}/orgs/Big/repos?type=all&per_page=100&page=2`]: { status: 200, body: page(2) },
    [`${API}/orgs/Big/repos?type=all&per_page=100&page=3`]: { status: 200, body: page(3) },
    ...Object.assign({}, ...BIG.map((fake) => repository('Big', fake))),
    ...overrides,
  };
}

const LISTED = [
  `${API}/users/Big`,
  `${API}/orgs/Big/repos?type=all&per_page=100&page=1`,
  `${API}/orgs/Big/repos?type=all&per_page=100&page=2`,
  `${API}/orgs/Big/repos?type=all&per_page=100&page=3`,
];

/** A store in a temporary directory, removed after the test. */
function temporaryStore(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return openStore(directory);
}

/** `skill-atlas scan github.com/Big` with or without a token; every request, and the GraphQL queries' bodies. */
async function scanBig(github: Recording, store: ReturnType<typeof openStore>, token: string | null = 'test') {
  const asked: string[] = [];
  const queries: string[] = [];
  const answers = replayGraphQL(github);
  const fetch: Fetch = (url, init) => {
    asked.push(url);
    if (url === `${API}/graphql`) queries.push(JSON.parse(init!.body!).query);
    return answers(url, init);
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const options = { fetch, token: token ?? undefined };
  const code = await run(['scan', 'github.com/Big'], {
    open: (input) => openGitHub(input, options),
    openOrganization: (input) => openGitHubOwner(input, options),
    store,
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), asked, queries };
}

test('a rescan of 250 repositories, all stored: the list pages and 3 GraphQL queries, no other request', async (t) => {
  const store = temporaryStore(t);
  const first = await scanBig(bigRecording(), store);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, 'Big · 250 repositories · 0 skills');
  // No repository lookup, cold too; each commit from GraphQL: no REST commit request.
  assert.deepEqual(first.asked.filter((url) => /\/repos\/Big\/[^/]+$/.test(url) || url.includes('/commits/')), []);
  assert.equal(first.asked.filter((url) => url.includes('/git/trees/')).length, 250);

  const second = await scanBig(bigRecording(), store);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(second.asked, [...LISTED, `${API}/graphql`, `${API}/graphql`, `${API}/graphql`]);
  // One query per 100 repositories, in the scan's order, each repository asked for by its own alias.
  assert.deepEqual(
    second.queries.map((query) => [...query.matchAll(/name: "([^"]+)"/g)].map(([, name]) => name)),
    [BIG.slice(0, 100), BIG.slice(100, 200), BIG.slice(200)].map((names) => names.map(({ name }) => name)),
  );
  assert.match(second.queries[0], /^query \{ r0: repository\(owner: "Big", name: "big-000"\) \{ defaultBranchRef \{ name target \{ oid \} \} \} r1: /);
});

test('a rescan of 250 repositories, 5 moved: only those 5 add their tree requests', async (t) => {
  const store = temporaryStore(t);
  assert.equal((await scanBig(bigRecording(), store)).code, 0);
  const moved = ['big-007', 'big-099', 'big-100', 'big-180', 'big-249'];
  const next = (name: string) => commitOf(`${name}-next`);
  const overrides: Recording = Object.fromEntries(
    moved.flatMap((name) => [
      [`${API}/repos/Big/${name}/commits/main`, { status: 200, body: { sha: next(name) } }],
      [`${API}/repos/Big/${name}/git/trees/${next(name)}?recursive=1`, { status: 200, body: { truncated: false, tree: [] } }],
    ]),
  );
  const scanned = await scanBig(bigRecording(overrides), store);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.deepEqual(scanned.asked.filter((url) => !LISTED.includes(url) && url !== `${API}/graphql`).sort(), moved.map((name) => `${API}/repos/Big/${name}/git/trees/${next(name)}?recursive=1`));
  assert.equal(scanned.asked.filter((url) => url === `${API}/graphql`).length, 3);
});

test('without a token: no GraphQL, no repository lookup; one commit request per repository, then only what is not stored', async (t) => {
  const store = temporaryStore(t);
  const first = await scanBig(bigRecording(), store, null);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(!first.asked.includes(`${API}/graphql`));
  const second = await scanBig(bigRecording(), store, null);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(second.asked, [...LISTED, ...BIG.map(({ name }) => `${API}/repos/Big/${name}/commits/main`)]);
});

test('GraphQL without a commit for a repository: the REST commit request for that one only, the same scan', async (t) => {
  const store = temporaryStore(t);
  const cold = await scanBig(bigRecording(), temporaryStore(t));
  // Not found (null), no default branch (empty), another default branch than the list's, an oid that is not one.
  const answers = replayGraphQL(bigRecording());
  const lagging: Fetch = async (url, init) => {
    const response = await answers(url, init);
    if (url !== `${API}/graphql`) return response;
    const { data } = (await response.json()) as { data: Record<string, unknown> };
    data.r1 = null;
    data.r2 = { defaultBranchRef: null };
    data.r3 = { defaultBranchRef: { name: 'old-main', target: { oid: commitOf('big-003') } } };
    data.r4 = { defaultBranchRef: { name: 'main', target: { oid: 'not a commit' } } };
    return Response.json({ data, errors: [{ type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve to a Repository' }] });
  };
  const asked: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: Fetch = (url, init) => (asked.push(url), lagging(url, init));
  const code = await run(['scan', 'github.com/Big'], {
    open: () => Promise.reject(new Error('not opened by input')),
    openOrganization: (input) => openGitHubOwner(input, { fetch, token: 'test' }),
    store,
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  assert.equal(code, 0, stderr.join('\n'));
  assert.equal(stdout.join('\n'), cold.stdout);
  const fallbacks = (index: number) => [1, 2, 3, 4].map((r) => `${API}/repos/Big/${BIG[index * 100 + r].name}/commits/main`);
  assert.deepEqual(asked.filter((url) => url.includes('/commits/')), [0, 1, 2].flatMap(fallbacks));
  // The stored scans are those of each repository at its commit: the next rescan asks for no tree.
  const again = await scanBig(bigRecording(), store);
  assert.deepEqual(again.asked.filter((url) => url.includes('/git/trees/')), []);
});

test('a GraphQL query GitHub fails: its repositories as without a token, the others from the other queries', async (t) => {
  const answers = replayGraphQL(bigRecording());
  let queries = 0;
  const failing: Fetch = (url, init) =>
    url === `${API}/graphql` && ++queries === 2
      ? Promise.resolve(Response.json({ message: 'Something went wrong' }, { status: 502 }))
      : answers(url, init);
  const asked: string[] = [];
  const stderr: string[] = [];
  const store = temporaryStore(t);
  const code = await run(['scan', 'github.com/Big'], {
    open: () => Promise.reject(new Error('not opened by input')),
    openOrganization: (input) => openGitHubOwner(input, { fetch: (url, init) => (asked.push(url), failing(url, init)), token: 'test' }),
    store,
    print: () => {},
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  assert.equal(code, 0, stderr.join('\n'));
  assert.equal(stderr.join('\n'), '');
  assert.equal(queries, 3);
  assert.deepEqual(
    asked.filter((url) => url.includes('/commits/')).sort(),
    BIG.slice(100, 200).map(({ name }) => `${API}/repos/Big/${name}/commits/main`),
  );
  assert.equal((await store.list()).length, 250);
});

test('GraphQL refused: the rate limit, RATE_LIMITED in its errors too, or a rejected token → the scan stops, exit code 1', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 20 * 60;
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) };
  const refusals: [Recording[string], string][] = [
    [{ status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers }, 'GitHub rate limit reached; it resets at'],
    [{ status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, headers }, 'GitHub rate limit reached; it resets at'],
    [{ status: 401, body: { message: 'Bad credentials' } }, 'GitHub rejected the token in GITHUB_TOKEN'],
  ];
  for (const [answer, message] of refusals) {
    const scanned = await scanBig(bigRecording({ [`${API}/graphql`]: answer }), temporaryStore(t));
    assert.equal(scanned.code, 1, message);
    assert.equal(scanned.stdout, '');
    assert.ok(scanned.stderr.startsWith(message), scanned.stderr);
    // No repository is scanned: each one waits for its commit.
    assert.deepEqual(scanned.asked.filter((url) => url.includes('/git/trees/') || url.includes('/commits/')), [], message);
  }
  // The rate limit's reset time, as for any request: the web view hears it.
  const get = await serve(t, { github: bigRecording({ [`${API}/graphql`]: refusals[1][0] }) });
  assert.deepEqual((await get('github.com/Big')).body, {
    error: 'GitHub rate limit reached; try again later',
    rateLimit: { resetsAt: new Date(reset * 1000).toISOString(), token: true },
  });
});

test('progress and Stop count every repository, a stored one too; a query is asked only once the scan reaches it', async (t) => {
  const store = temporaryStore(t);
  assert.equal((await scanBig(bigRecording(), store)).code, 0);
  const asked: string[] = [];
  const answers = replayGraphQL(bigRecording());
  const organization = await openGitHubOwner('github.com/Big', { fetch: (url, init) => (asked.push(url), answers(url, init)), token: 'test' });
  const seen: number[] = [];
  const all = await scanOrganization(organization, () => Promise.reject(new Error('not opened by input')), store, undefined, (scanned, of) => {
    assert.equal(of, 250);
    seen.push(scanned);
  });
  assert.deepEqual(seen, Array.from({ length: 251 }, (_, index) => index));
  assert.ok(all.every(({ result, stored }) => result && stored));
  // Stopped within the first 100: the other two queries are never asked.
  asked.length = 0;
  const again = await openGitHubOwner('github.com/Big', { fetch: (url, init) => (asked.push(url), answers(url, init)), token: 'test' });
  asked.length = 0;
  const stop = new AbortController();
  const stopped = scanOrganization(again, () => Promise.reject(new Error('not opened by input')), store, stop.signal, (scanned) => {
    if (scanned === 10) stop.abort(new Error('stopped'));
  });
  await assert.rejects(stopped, { message: 'stopped' });
  assert.deepEqual(asked, [`${API}/graphql`]);
});
