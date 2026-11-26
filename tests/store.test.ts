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

/** JetBrains/example with main at `head`; the skill's description says which commit it is. */
function github(head: string): Recording {
  const raw = (commit: string, body: string) => ({ [`https://raw.githubusercontent.com/JetBrains/example/${commit}/${SKILL}`]: { status: 200, body } });
  const tree = (commit: string) => ({
    [`https://api.github.com/repos/JetBrains/example/git/trees/${commit}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree: [{ path: SKILL, mode: '100644', type: 'blob', sha: '0' }] },
    },
  });
  return {
    'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    'https://api.github.com/repos/JetBrains/example/commits/main': { status: 200, body: { sha: head } },
    [`https://api.github.com/repos/JetBrains/example/commits/${MAIN}`]: { status: 200, body: { sha: MAIN } },
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
async function atlas(args: string[], options: { directory: string; head?: string; token?: string }) {
  const requests: string[] = [];
  const recorded = replay(github(options.head ?? MAIN));
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

test('the key is the commit and how it was listed: search and tree are stored apart', async (t) => {
  const directory = storeDirectory(t);
  const searched = await atlas(['scan', 'github.com/JetBrains/example'], { directory, token: 'test' });
  assert.ok(searched.requests.some((url) => url.includes('/search/code')));
  const listed = await atlas(['scan', 'github.com/JetBrains/example'], { directory });
  assert.ok(listed.requests.some((url) => url.includes(`/trees/${MAIN}`)));
  // The same commit through /tree/<ref>: listed through its tree, its own warning wording; scanned once more.
  const pinned = await atlas(['scan', `github.com/JetBrains/example/tree/${MAIN}`], { directory });
  assert.ok(pinned.requests.some((url) => url.includes(`/trees/${MAIN}`)));
  assert.equal(readdirSync(directory).length, 3);
  for (const args of [['scan', 'github.com/JetBrains/example'], ['scan', `github.com/JetBrains/example/tree/${MAIN}`]]) {
    assert.equal((await atlas(args, { directory })).requests.length, 2, args.join(' '));
  }
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
  const first = await scan(await open(), store);
  assert.deepEqual(first.warnings, [`${missing}: listed, but not found at the scanned commit; skipped`]);
  const again = await openStore(directory).get((await open()).key!);
  assert.deepEqual(again, first);
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
