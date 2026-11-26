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
  const answers = replay(github);
  const fetch: Fetch = (url, init) => (asked.push(url), answers(url, init));
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
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), asked };
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
