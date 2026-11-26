// The decisions in spec/analysis.md#organization and spec/cli.md#organization, checked on what the
// real command prints for an organization and a user that GitHub answers from recordings below.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/commands.ts';
import { openGitHub, openGitHubOwner, parseGitHubOwner, parseGitHubUrl, type Fetch } from '../src/core/github.ts';
import { replay, type Recording } from '../src/core/replay.ts';
import { openStore } from '../src/store.ts';
import { filterRepositories } from '../src/web/public/filter.js';
import { historyView, storedOnPage } from '../src/web/public/history.js';
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
  const answers = replay(github);
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
  assert.ok(scanned.asked.includes(`${API}/repos/JetBrains/Alpha/commits/release%2F2026`));
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
    github: recording({ [`${API}/repos/JetBrains/repo-50`]: limited }),
  });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rate limit reached; try again in a minute');
  // It stops: the repositories not started yet are not asked for, not even later.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!scanned.asked.includes(`${API}/repos/JetBrains/zeta`), 'the last repository was not scanned');
});

test('a rate limit on a file read: the scan stops, exit code 1', async () => {
  const file = `https://raw.githubusercontent.com/JetBrains/zeta/${commitOf('zeta')}/.claude/skills/release/SKILL.md`;
  const scanned = await atlas(['scan', 'github.com/JetBrains'], { github: recording({ [file]: { status: 429, body: '429: Too Many Requests' } }) });
  assert.equal(scanned.code, 1);
  assert.equal(scanned.stdout, '');
  assert.equal(scanned.stderr, 'GitHub rate limit reached; try again in a minute');
});

test('a rejected token: the scan stops, exit code 1', async () => {
  const scanned = await atlas(['scan', 'github.com/JetBrains'], {
    github: recording({ [`${API}/repos/JetBrains/Alpha`]: { status: 401, body: { message: 'Bad credentials' } } }),
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
  delete github[`${API}/repos/JetBrains/beta`]; // not recorded: the fetch fails, as without a network
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
  const answers = replay(recording());
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
  const fetch = replay(github);
  const server = createWebServer({
    open: (input) => openGitHub(input, { fetch, token: 'test' }),
    openOrganization: (input) => (parseGitHubOwner(input) ? openGitHubOwner(input, { fetch, token: 'test' }) : undefined),
    store,
  });
  const base = await listen(server, 0);
  t.after(() => server.close());
  return async (repo: string) => {
    const response = await globalThis.fetch(`${base}/api/scan?repo=${encodeURIComponent(repo)}`);
    return { status: response.status, body: (await response.json()) as any };
  };
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
  assert.deepEqual(await (await serve(t, { github: recording({ [`${API}/repos/JetBrains/repo-50`]: limited }) }))('github.com/JetBrains'), {
    status: 400,
    body: { error: 'GitHub rate limit reached; try again in a minute' },
  });
  const rejected = { status: 401, body: { message: 'Bad credentials' } };
  assert.deepEqual(await (await serve(t, { github: recording({ [`${API}/repos/JetBrains/Alpha`]: rejected }) }))('github.com/JetBrains'), {
    status: 400,
    body: { error: 'GitHub rejected the token in GITHUB_TOKEN' },
  });
  const github = recording();
  delete github[`${API}/repos/JetBrains/beta`];
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
  const answers = replay({
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
  const started = () => new Set(asked.filter((url) => /\/repos\/Slow\/[^/]+$/.test(url))).size;
  // Unaborted, every repository is scanned: the test would see the difference.
  const leaving = new AbortController();
  const page = globalThis.fetch(`${base}/api/scan?repo=github.com%2FSlow`, { signal: leaving.signal });
  await new Promise((resolve) => setTimeout(resolve, 150));
  leaving.abort();
  await assert.rejects(page);
  const atAbort = started();
  assert.ok(atAbort > 0 && atAbort < 100, `started at the abort: ${atAbort}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // At most the 8 repositories being scanned at the abort, whose scans end; none started after.
  assert.ok(started() <= atAbort + 8, `started at the abort: ${atAbort}, later: ${started()}`);
  assert.ok(started() < 100, `started: ${started()}`);
});
