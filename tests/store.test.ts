// The decisions in spec/analysis.md#persistence, checked on the real commands and the web view with
// GitHub answering from a recording that counts the requests, and a store in a temporary directory.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { run } from '../src/commands.ts';
import { openGitHub, parseGitHubUrl } from '../src/core/github.ts';
import { replay, type Recording } from '../src/core/replay.ts';
import { scan } from '../src/core/scan.ts';
import { openDirectory } from '../src/local.ts';
import { cacheDirectory, openStore } from '../src/store.ts';
import { createWebServer, listen } from '../src/web/server.ts';
import { FIXTURE } from './helpers.ts';

const MAIN = '1111111111111111111111111111111111111111';
const NEXT = '2222222222222222222222222222222222222222';
const SKILL = '.claude/skills/commits/SKILL.md';

/**
 * JetBrains/example with main at `head`; the skill's description says which commit it is.
 * `large`: each tree is too large for one answer, so a token lists through code search.
 */
function github(head: string, { large = false } = {}): Recording {
  const raw = (commit: string, body: string) => ({ [`https://raw.githubusercontent.com/JetBrains/example/${commit}/${SKILL}`]: { status: 200, body } });
  const tree = (commit: string) => ({
    [`https://api.github.com/repos/JetBrains/example/git/trees/${commit}?recursive=1`]: {
      status: 200,
      body: large ? { truncated: true, tree: [] } : { truncated: false, tree: [{ path: SKILL, mode: '100644', type: 'blob', sha: '0' }] },
    },
    // Too large: the skill roots, one level at a time, then each root's whole tree.
    ...(large && {
      [`https://api.github.com/repos/JetBrains/example/git/trees/${commit}`]: {
        status: 200,
        body: { truncated: false, tree: [{ path: '.claude', mode: '040000', type: 'tree', sha: `claude-${commit}` }] },
      },
      [`https://api.github.com/repos/JetBrains/example/git/trees/claude-${commit}`]: {
        status: 200,
        body: { truncated: false, tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: `skills-${commit}` }] },
      },
      [`https://api.github.com/repos/JetBrains/example/git/trees/skills-${commit}?recursive=1`]: {
        status: 200,
        body: { truncated: false, tree: [{ path: 'commits/SKILL.md', mode: '100644', type: 'blob', sha: '0' }] },
      },
    }),
  });
  return {
    'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    'https://api.github.com/repos/JetBrains/example/commits/main': { status: 200, body: { sha: head } },
    [`https://api.github.com/repos/JetBrains/example/commits/${MAIN}`]: { status: 200, body: { sha: MAIN } },
    'https://api.github.com/repos/JetBrains/example/commits/v1.0': { status: 200, body: { sha: MAIN } },
    'https://api.github.com/repos/JetBrains/example/commits/v2.0': { status: 200, body: { sha: MAIN } },
    'https://api.github.com/search/code?q=filename:SKILL.md+repo:JetBrains/example&per_page=100&page=1': {
      status: 200,
      body: { total_count: 1, items: [{ path: SKILL }] },
    },
    ...tree(MAIN),
    ...tree(NEXT),
    ...raw(MAIN, '---\nname: commits\ndescription: As of the first commit.\n---\n'),
    ...raw(NEXT, '---\nname: commits\ndescription: As of the next commit.\n---\n'),
  };
}

/** A directory for the store, removed after the test. */
function storeDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * `skill-atlas <args>` as a new run of the CLI: a new store over the directory, GitHub answering
 * from the recording; what it printed, and every URL it asked GitHub for.
 */
async function atlas(args: string[], options: { directory: string; head?: string; token?: string; large?: boolean }) {
  const requests: string[] = [];
  const recorded = replay(github(options.head ?? MAIN, { large: options.large }));
  const fetch = (url: string) => (requests.push(url), recorded(url));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(args, {
    open: (input) => (parseGitHubUrl(input) ? openGitHub(input, { fetch, token: options.token }) : openDirectory(input)),
    store: openStore(options.directory),
    print: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    serve: () => Promise.reject(new Error('not served')),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), requests };
}

const RESOLVE = ['https://api.github.com/repos/JetBrains/example', 'https://api.github.com/repos/JetBrains/example/commits/main'];

test('the same repository at the same commit: stored, not scanned again, the same output', async (t) => {
  const directory = storeDirectory(t);
  const first = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /As of the first commit\./);
  assert.ok(first.requests.length > RESOLVE.length);
  assert.equal(readdirSync(directory).length, 1);

  // Another spelling of the same repository, in a new run: only the ref is resolved.
  const again = await atlas(['scan', 'https://github.com/JetBrains/example/'], { directory });
  assert.deepEqual(again.requests, RESOLVE);
  assert.deepEqual({ ...again, requests: [] }, { ...first, requests: [] });
});

test('the branch moved to another commit: scanned again', async (t) => {
  const directory = storeDirectory(t);
  await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  const moved = await atlas(['scan', 'github.com/JetBrains/example'], { directory, head: NEXT });
  assert.match(moved.stdout, /As of the next commit\./);
  assert.ok(moved.requests.some((url) => url.includes(`/trees/${NEXT}`)));
  assert.equal(readdirSync(directory).length, 2);
});

test('with a token, a default branch that fits in one tree: listed through the tree, not code search, and stored', async (t) => {
  const directory = storeDirectory(t);
  const first = await atlas(['scan', 'github.com/JetBrains/example'], { directory, token: 'test' });
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.requests.some((url) => url.includes(`/trees/${MAIN}`)));
  assert.ok(!first.requests.some((url) => url.includes('/search/code')));
  const again = await atlas(['scan', 'github.com/JetBrains/example'], { directory, token: 'test' });
  assert.deepEqual(again.requests, RESOLVE);
  assert.equal(again.stdout, first.stdout);
  assert.equal(readdirSync(directory).length, 1);
});

test('with a token, a default branch too large for one tree: code search, never stored, scanned every time', async (t) => {
  const directory = storeDirectory(t);
  for (let i = 0; i < 2; i++) {
    const searched = await atlas(['scan', 'github.com/JetBrains/example'], { directory, token: 'test', large: true });
    assert.match(searched.stdout, /As of the first commit\./);
    assert.equal(searched.stderr, '');
    assert.equal(searched.code, 0, searched.stderr);
    assert.ok(searched.requests.some((url) => url.includes('/search/code')));
  }
  assert.deepEqual(readdirSync(directory), []);
});

test('an index that caught up: the next code search finds the skill the last one missed', async (t) => {
  const store = openStore(storeDirectory(t));
  const search = 'https://api.github.com/search/code?q=filename:SKILL.md+repo:JetBrains/example&per_page=100&page=1';
  const lagging = github(MAIN, { large: true });
  lagging[search] = { status: 200, body: { total_count: 0, items: [] } };
  const open = (recording: Recording) => openGitHub('github.com/JetBrains/example', { fetch: replay(recording), token: 'test' });
  assert.equal((await scan(await open(lagging), store)).result.skills.length, 0);
  assert.equal((await scan(await open(github(MAIN, { large: true })), store)).result.skills.length, 1);
});

test('a tree in one answer: one stored scan for every ref, with a token or without', async (t) => {
  const directory = storeDirectory(t);
  const first = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.ok(first.requests.some((url) => url.includes(`/trees/${MAIN}`)));
  for (const [args, token] of [
    [['scan', 'github.com/JetBrains/example'], 'test'],
    [['scan', `github.com/JetBrains/example/tree/${MAIN}`], undefined],
    [['scan', 'github.com/JetBrains/example/tree/v1.0'], 'test'],
  ] as const) {
    const again = await atlas([...args], { directory, token });
    assert.equal(again.requests.length, 2, `${args.join(' ')}: only resolved`);
    assert.equal(again.stdout, first.stdout);
  }
  assert.deepEqual(
    (await openStore(directory).list()).map((stored) => stored.refs),
    [['main (default branch)', MAIN, 'v1.0']],
  );
});

test('a tree too large: the roots, stored apart for the default branch and a ref; with a token, code search, never stored', async (t) => {
  const directory = storeDirectory(t);
  const large = true;
  const hint = 'warning: the tree is too large to list at once; looked only in .agents/skills, .claude/skills, .github/skills, agent/skills';
  // Without a token: the roots, and a warning that a token would search everywhere.
  const roots = await atlas(['scan', 'github.com/JetBrains/example'], { directory, large });
  assert.match(roots.stdout, /As of the first commit\./);
  assert.equal(roots.stderr, `${hint} (GITHUB_TOKEN searches everywhere)`);
  assert.equal(readdirSync(directory).length, 1);
  // With a token: code search, not the stored roots, and not stored; every time.
  for (let i = 0; i < 2; i++) {
    const searched = await atlas(['scan', 'github.com/JetBrains/example'], { directory, large, token: 'test' });
    assert.ok(searched.requests.some((url) => url.includes('/search/code')));
    assert.equal(searched.stderr, '');
    assert.equal(readdirSync(directory).length, 1);
  }
  // Without a token again: the stored roots.
  const again = await atlas(['scan', 'github.com/JetBrains/example'], { directory, large });
  assert.deepEqual(again.requests, RESOLVE);
  assert.deepEqual([again.stdout, again.stderr], [roots.stdout, roots.stderr]);
  // A ref at the same commit: the roots, with the warning worded for a ref; stored apart, with a token too.
  const pinned = await atlas(['scan', `github.com/JetBrains/example/tree/${MAIN}`], { directory, large, token: 'test' });
  assert.ok(!pinned.requests.some((url) => url.includes('/search/code')));
  assert.equal(pinned.stderr, hint);
  assert.equal(readdirSync(directory).length, 2);
  assert.equal((await atlas(['scan', `github.com/JetBrains/example/tree/${MAIN}`], { directory, large })).requests.length, 2);
});

test('scans an earlier version stored, by ref and by default branch without a token, are found again', async (t) => {
  const directory = storeDirectory(t);
  const store = openStore(directory);
  // What the earlier version stored them under: the commit and how its tree was listed.
  const earlier = (listing: string, description: string) => {
    const repository = { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: MAIN };
    const skill = { id: `JetBrains/example:${SKILL}`, repository: repository.id, path: SKILL, name: 'commits', description, commit: MAIN, copies: [] };
    return store.set(JSON.stringify(['github', 'JetBrains/example', MAIN, listing]), { ref: '', result: { repository, skills: [skill], warnings: [] } });
  };
  await earlier('tree of the default branch', 'Stored for the default branch.');
  await earlier('tree', 'Stored for a ref.');
  const branch = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.deepEqual(branch.requests, RESOLVE);
  assert.match(branch.stdout, /Stored for the default branch\./);
  const pinned = await atlas(['scan', `github.com/JetBrains/example/tree/${MAIN}`], { directory });
  assert.equal(pinned.requests.length, 2);
  assert.match(pinned.stdout, /Stored for a ref\./);
});

test('a scan an earlier version stored of a tree in one answer: the one stored scan, for every ref, with a token or without', async (t) => {
  for (const [listing, ref] of [['tree of the default branch', 'main (default branch)'], ['tree', MAIN]] as const) {
    const directory = storeDirectory(t);
    const store = openStore(directory);
    const repository = { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: MAIN };
    const skill = { id: `JetBrains/example:${SKILL}`, repository: repository.id, path: SKILL, name: 'commits', description: 'Stored earlier.', commit: MAIN, copies: [] };
    await store.set(JSON.stringify(['github', 'JetBrains/example', MAIN, listing]), { ref, result: { repository, skills: [skill], warnings: [] } });
    for (const [args, token] of [
      [['scan', `github.com/JetBrains/example/tree/${MAIN}`], undefined],
      [['scan', 'github.com/JetBrains/example'], 'test'],
      [['scan', 'github.com/JetBrains/example'], undefined],
      [['scan', 'github.com/JetBrains/example/tree/v1.0'], 'test'],
    ] as const) {
      const again = await atlas([...args], { directory, token });
      assert.equal(again.requests.length, 2, `${listing}, ${args.join(' ')}: only resolved`);
      assert.match(again.stdout, /Stored earlier\./);
    }
    assert.deepEqual(
      (await store.list()).map((stored) => stored.refs),
      [[...new Set([ref, MAIN, 'main (default branch)', 'v1.0'])]],
    );
  }
});

test('a scan an earlier version stored of the roots: only for its own kind of input, never with a token', async (t) => {
  const directory = storeDirectory(t);
  const store = openStore(directory);
  const large = true;
  const repository = { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: MAIN };
  const warning = 'the tree is too large to list at once; looked only in .agents/skills, .claude/skills, .github/skills, agent/skills';
  await store.set(JSON.stringify(['github', 'JetBrains/example', MAIN, 'tree of the default branch']), {
    ref: 'main (default branch)',
    result: { repository, skills: [], warnings: [`${warning} (GITHUB_TOKEN searches everywhere)`] },
  });
  // Its own kind: the stored roots.
  const branch = await atlas(['scan', 'github.com/JetBrains/example'], { directory, large });
  assert.deepEqual(branch.requests, RESOLVE);
  // With a token: code search, not the stored roots.
  const searched = await atlas(['scan', 'github.com/JetBrains/example'], { directory, large, token: 'test' });
  assert.ok(searched.requests.some((url) => url.includes('/search/code')));
  assert.equal(searched.stderr, '');
  // A ref: its own roots, with the warning worded for a ref.
  const pinned = await atlas(['scan', `github.com/JetBrains/example/tree/${MAIN}`], { directory, large });
  assert.ok(pinned.requests.length > 2);
  assert.equal(pinned.stderr, `warning: ${warning}`);
  assert.equal(readdirSync(directory).length, 2);
});

test('two refs at one commit: one stored scan, scanned once, and both refs recorded, in order', async (t) => {
  const directory = storeDirectory(t);
  const store = openStore(directory);
  const open = (ref: string) => openGitHub(`github.com/JetBrains/example/tree/${ref}`, { fetch: replay(github(MAIN)) });
  const first = await scan(await open(MAIN), store);
  const second = await atlas(['scan', 'github.com/JetBrains/example/tree/v1.0'], { directory });
  assert.equal(second.requests.length, 2); // resolved; listed and read from the store
  await scan(await open('v1.0'), store); // already recorded: the same refs
  const again = await scan(await open(MAIN), store);
  assert.equal(again.stored, first.stored);
  const scans = await store.list();
  assert.deepEqual(scans.map((stored) => [stored.id, stored.refs]), [[first.stored, [MAIN, 'v1.0']]]);
});

test('refs at one commit scanned at the same time: none is lost, stored or not yet', async (t) => {
  const open = (ref: string) => openGitHub(`github.com/JetBrains/example/tree/${ref}`, { fetch: replay(github(MAIN)) });
  // Stored already: both refs are added to it.
  const stored = openStore(storeDirectory(t));
  await scan(await open(MAIN), stored);
  const [v1, v2] = await Promise.all([open('v1.0'), open('v2.0')]);
  const hits = await Promise.all([scan(v1, stored), scan(v2, stored)]);
  // The first ref first; the two at the same time in whichever order they arrive.
  const [[first, ...together]] = (await stored.list()).map((scan) => scan.refs);
  assert.deepEqual([first, together.sort()], [MAIN, ['v1.0', 'v2.0']]);
  // Not stored yet: both scan, and the second to finish adds its ref to the first's.
  const empty = openStore(storeDirectory(t));
  const misses = await Promise.all([scan(await open('v1.0'), empty), scan(await open('v2.0'), empty)]);
  assert.deepEqual((await empty.list()).map((scan) => [...scan.refs].sort()), [['v1.0', 'v2.0']]);
  // Every answer names the one stored scan.
  for (const answer of [...hits, ...misses]) assert.equal(answer.stored, misses[0].stored);
});

test('warnings are stored with the result', async (t) => {
  const directory = storeDirectory(t);
  const recording = github(MAIN);
  // The tree lists a skill the commit does not have.
  const url = `https://api.github.com/repos/JetBrains/example/git/trees/${MAIN}?recursive=1`;
  const missing = 'agent/skills/gone/SKILL.md';
  (recording[url].body as { tree: unknown[] }).tree.push({ path: missing, mode: '100644', type: 'blob', sha: '0' });
  recording[`https://raw.githubusercontent.com/JetBrains/example/${MAIN}/${missing}`] = { status: 404, body: '404: Not Found' };
  const store = openStore(directory);
  const open = () => openGitHub('github.com/JetBrains/example', { fetch: replay(recording) });
  const { result: first } = await scan(await open(), store);
  assert.deepEqual(first.warnings, [`${missing}: listed, but not found at the scanned commit; skipped`]);
  // Found again, with its warning, without listing.
  const { result: again, stored } = await scan(await open(), openStore(directory));
  assert.deepEqual(again, first);
  assert.ok(stored);
});

test('a failed scan is not stored', async (t) => {
  const directory = storeDirectory(t);
  const recording = github(MAIN);
  recording[`https://raw.githubusercontent.com/JetBrains/example/${MAIN}/${SKILL}`] = { status: 500, body: 'oops' };
  const store = openStore(directory);
  const failed = await run(['scan', 'github.com/JetBrains/example'], {
    open: (input) => openGitHub(input, { fetch: replay(recording) }),
    store,
    print: () => {},
    error: () => {},
    serve: () => Promise.reject(new Error('not served')),
  });
  assert.equal(failed, 1);
  assert.deepEqual(readdirSync(directory), []);
  const scanned = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.equal(scanned.code, 0, scanned.stderr);
});

test('a local directory is never stored: a changed file shows at once', async (t) => {
  const directory = storeDirectory(t);
  const root = join(storeDirectory(t), 'repository');
  mkdirSync(join(root, '.claude/skills/x'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/x/SKILL.md'), '---\nname: x\ndescription: Before.\n---\n');
  assert.match((await atlas(['scan', root], { directory })).stdout, /x — Before\./);
  writeFileSync(join(root, '.claude/skills/x/SKILL.md'), '---\nname: x\ndescription: After.\n---\n');
  assert.match((await atlas(['scan', root], { directory })).stdout, /x — After\./);
  assert.deepEqual(readdirSync(directory), []);
  // The fixture, too.
  cpSync(FIXTURE, join(root, 'fixture'), { recursive: true, verbatimSymlinks: true });
  await atlas(['scan', join(root, 'fixture')], { directory });
  assert.deepEqual(readdirSync(directory), []);
});

test('a corrupt stored file: scanned again, and replaced', async (t) => {
  const directory = storeDirectory(t);
  await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  const [file] = readdirSync(directory);
  writeFileSync(join(directory, file), '{ not json');
  const again = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.requests.length > RESOLVE.length);
  assert.equal((await atlas(['scan', 'github.com/JetBrains/example'], { directory })).requests.length, RESOLVE.length);
});

test('an unwritable store directory: the scan goes on, nothing is stored', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes anywhere');
  const parent = mkdtempSync(join(tmpdir(), 'skill-atlas-store-'));
  chmodSync(parent, 0o500);
  t.after(() => {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  });
  const directory = join(parent, 'store');
  const scanned = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.match(scanned.stdout, /As of the first commit\./);
  assert.equal((await atlas(['scan', 'github.com/JetBrains/example'], { directory })).code, 0);
  // Not stored, so the page is not told it is: stored is null.
  const { result, stored } = await scan(await openGitHub('github.com/JetBrains/example', { fetch: replay(github(MAIN)) }), openStore(directory));
  assert.equal(result.skills.length, 1);
  assert.equal(stored, null);
  const server = createWebServer({ open: (input) => openGitHub(input, { fetch: replay(github(MAIN)) }), store: openStore(directory) });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const body = (await (await fetch(`${base}/api/scan?repo=${encodeURIComponent('github.com/JetBrains/example')}`)).json()) as { stored: unknown };
  assert.equal(body.stored, null);
});

test('the web view shares the store with the CLI', async (t) => {
  const directory = storeDirectory(t);
  const cli = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  const requests: string[] = [];
  const recorded = replay(github(MAIN));
  const fetch = (url: string) => (requests.push(url), recorded(url));
  const server = createWebServer({ open: (input) => openGitHub(input, { fetch }), store: openStore(directory) });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const response = await globalThis.fetch(`${base}/api/scan?repo=${encodeURIComponent('github.com/JetBrains/example')}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { skills: { description: string }[] };
  assert.deepEqual(requests, RESOLVE);
  assert.equal(body.skills[0].description, 'As of the first commit.');
  assert.match(cli.stdout, /As of the first commit\./);
});

test('where the store is: SKILL_ATLAS_CACHE, else $XDG_CACHE_HOME/skill-atlas, else ~/.cache/skill-atlas', () => {
  assert.equal(cacheDirectory({ SKILL_ATLAS_CACHE: '/tmp/a', XDG_CACHE_HOME: '/tmp/b' }), '/tmp/a');
  assert.equal(cacheDirectory({ XDG_CACHE_HOME: '/tmp/b' }), '/tmp/b/skill-atlas');
  assert.match(cacheDirectory({}), /\/\.cache\/skill-atlas$/);
});

test('every stored scan, the latest first: repository, commit, what was asked for, counts and when', async (t) => {
  const directory = storeDirectory(t);
  let clock = Date.parse('2026-11-26T10:00:00Z');
  const store = openStore(directory, () => new Date(clock));
  assert.deepEqual(await store.list(), []);
  const open = (input: string, head: string) => openGitHub(input, { fetch: replay(github(head)) });
  await scan(await open(`github.com/JetBrains/example/tree/${MAIN}`, MAIN), store);
  clock += 60_000;
  await scan(await open('github.com/JetBrains/example', NEXT), store);
  clock += 60_000;
  await scan(await open('github.com/JetBrains/example', NEXT), store); // stored: not scanned again, its time stays
  await scan(await openDirectory(FIXTURE), store); // a local directory: not stored

  const scans = await store.list();
  assert.deepEqual(
    scans.map(({ id, ...rest }) => (assert.match(id, /^[0-9a-f]{64}$/), rest)),
    [
      {
        repository: { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: NEXT },
        refs: ['main (default branch)'],
        skills: 1,
        warnings: 0,
        scannedAt: '2026-11-26T10:01:00.000Z',
      },
      {
        repository: { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: MAIN },
        refs: [MAIN],
        skills: 1,
        warnings: 0,
        scannedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
  );
  // Each opens as stored, by its id; another id, none.
  assert.equal((await store.open(scans[1].id))?.skills[0].description, 'As of the first commit.');
  for (const id of ['0'.repeat(64), '../package', scans[0].id.toUpperCase()]) assert.equal(await store.open(id), undefined, id);
  // The id of a key, as the list has it.
  const { stored } = await scan(await open('github.com/JetBrains/example', NEXT), store);
  assert.equal(stored, scans[0].id);
});

test('the list skips what is not a stored scan: a corrupt file, another file', async (t) => {
  const directory = storeDirectory(t);
  await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  writeFileSync(join(directory, `${'a'.repeat(64)}.json`), '{ not json');
  writeFileSync(join(directory, 'notes.txt'), 'mine');
  const scans = await openStore(directory).list();
  assert.deepEqual(scans.map((stored) => stored.repository.commit), [MAIN]);
  assert.deepEqual(await openStore(join(directory, 'missing')).list(), []);
});

test('/api/scans: the stored scans; /api/scans/<id>: one, as /api/scan answers it, without GitHub', async (t) => {
  const directory = storeDirectory(t);
  const requests: string[] = [];
  const recorded = replay(github(MAIN));
  const fetch = (url: string) => (requests.push(url), recorded(url));
  const server = createWebServer({ open: (input) => openGitHub(input, { fetch }), store: openStore(directory) });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const get = async (path: string) => {
    const response = await globalThis.fetch(`${base}${path}`);
    return { status: response.status, type: response.headers.get('content-type'), body: (await response.json()) as any };
  };

  assert.deepEqual(await get('/api/scans'), { status: 200, type: 'application/json; charset=utf-8', body: { scans: [] } });
  const scanned = await get(`/api/scan?repo=${encodeURIComponent('github.com/JetBrains/example')}`);
  assert.equal(scanned.status, 200);
  const { scans } = (await get('/api/scans')).body;
  assert.equal(scans.length, 1);
  assert.deepEqual(Object.keys(scans[0]), ['id', 'repository', 'refs', 'skills', 'warnings', 'scannedAt']);
  assert.deepEqual(scans[0].refs, ['main (default branch)']);
  // /api/scan names the stored scan, so the page marks it; again, from the store, the same.
  assert.equal(scanned.body.stored, scans[0].id);
  assert.deepEqual(await get(`/api/scan?repo=${encodeURIComponent('github.com/JetBrains/example')}`), scanned);
  assert.equal(scans[0].repository.commit, MAIN);
  assert.equal(scans[0].skills, 1);
  assert.ok(!Number.isNaN(Date.parse(scans[0].scannedAt)));

  requests.length = 0;
  const opened = await get(`/api/scans/${scans[0].id}`);
  assert.deepEqual(opened, { ...scanned, type: 'application/json; charset=utf-8' });
  assert.deepEqual(requests, []);

  for (const id of ['0'.repeat(64), 'nope']) {
    assert.deepEqual(await get(`/api/scans/${id}`), { status: 404, type: 'application/json; charset=utf-8', body: { error: `No stored scan: ${id}` } });
  }
  assert.equal((await globalThis.fetch(`${base}/api/scans/..%2Fpackage`)).status, 404);
});

test('/api/scan, not stored: stored is null; /api/scans without a store: none', async (t) => {
  const directory = storeDirectory(t);
  const stored = createWebServer({
    open: (input) => (parseGitHubUrl(input) ? openGitHub(input, { fetch: replay(github(MAIN, { large: true })), token: 'test' }) : openDirectory(input)),
    store: openStore(directory),
  });
  const storedBase = await listen(stored, 0);
  t.after(() => stored.close());
  for (const repo of [FIXTURE, 'github.com/JetBrains/example']) {
    const body = (await (await fetch(`${storedBase}/api/scan?repo=${encodeURIComponent(repo)}`)).json()) as { stored: unknown };
    assert.equal(body.stored, null, repo);
  }
  assert.deepEqual(readdirSync(directory), []);

  const server = createWebServer({ open: openDirectory });
  const base = await listen(server, 0);
  t.after(() => server.close());
  assert.deepEqual(await (await fetch(`${base}/api/scans`)).json(), { scans: [] });
  assert.equal((await fetch(`${base}/api/scans/${'0'.repeat(64)}`)).status, 404);
});
