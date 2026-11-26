// The search across stored scans in spec/web.md, checked on the real server over a store in a
// temporary directory, with GitHub never asked: the search answers from the store only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import type { ScanResult } from '../src/core/scan.ts';
import { openStore } from '../src/store.ts';
import { createWebServer, listen } from '../src/web/server.ts';
import { SEARCH_PAUSE, searchAsker, searchView } from '../src/web/public/history.js';

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const KOTLIN = '3333333333333333333333333333333333333333';

/** A stored result of `owner/name` at `commit`, with the skills given as [name, description, path?]. */
function result(id: string, commit: string, skills: [string, string, string?][]): ScanResult {
  const [organization, name] = id.split('/');
  return {
    repository: { id, organization, name, url: `https://github.com/${id}`, commit },
    skills: skills.map(([skill, description, path = `.claude/skills/${skill}/SKILL.md`]) => ({
      id: `${id}:${path}`,
      repository: id,
      path,
      name: skill,
      description,
      commit,
      copies: [],
    })),
    warnings: [],
  };
}

/**
 * A store holding, oldest first: JetBrains/example at OLD, JetBrains/kotlin, then JetBrains/example
 * at NEW; and a server over it whose GitHub fails every request, counted.
 */
async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-26T10:00:00Z');
  const store = openStore(directory, () => new Date(clock));
  await store.set(`example@${OLD}`, {
    ref: 'main (default branch)',
    result: result('JetBrains/example', OLD, [
      ['commits', 'Write commit messages the way this repository does. Use for every commit.'],
      ['old-only', 'A skill removed since. Gone at the next commit.'],
    ]),
  });
  clock += 60_000;
  await store.set(`kotlin@${KOTLIN}`, {
    ref: 'master (default branch)',
    result: result('JetBrains/kotlin', KOTLIN, [
      ['bump', 'Bump the Kotlin version! Then run the tests.'],
      ['commits', 'Commit messages, Kotlin style.'],
      ['empty', ''],
    ]),
  });
  clock += 60_000;
  await store.set(`example@${NEW}`, {
    ref: 'main (default branch)',
    result: result('JetBrains/example', NEW, [
      ['commits', 'Write commit messages the way this repository does now. Use for every commit.'],
      ['review', 'Review a Pull Request.\nCheck the tests.'],
    ]),
  });
  await store.addRef(`example@${NEW}`, 'v2.0');
  const scans = await store.list();
  const requests: string[] = [];
  const server = createWebServer({ open: (input) => (requests.push(input), Promise.reject(new Error('offline'))), store });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const search = async (q: string | undefined) => {
    const response = await fetch(`${base}/api/search${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`);
    return { status: response.status, type: response.headers.get('content-type'), body: (await response.json()) as any };
  };
  const ids = (repository: string, commit: string) => scans.find((scan) => scan.repository.id === repository && scan.repository.commit === commit)!.id;
  return { search, requests, base, scan: { example: ids('JetBrains/example', NEW), old: ids('JetBrains/example', OLD), kotlin: ids('JetBrains/kotlin', KOTLIN) } };
}

const found = (body: { results: { name: string; repository: { id: string } }[] }) => body.results.map((r) => `${r.repository.id} ${r.name}`);

test('/api/search: each result its name, first sentence, repository, commit and refs, pinned link and stored scan', async (t) => {
  const { search, scan } = await serve(t);
  const { status, type, body } = await search('review');
  assert.equal(status, 200);
  assert.equal(type, 'application/json; charset=utf-8');
  assert.deepEqual(body, {
    results: [
      {
        id: 'JetBrains/example:.claude/skills/review/SKILL.md',
        name: 'review',
        sentence: 'Review a Pull Request.',
        link: `https://github.com/JetBrains/example/blob/${NEW}/.claude/skills/review/SKILL.md`,
        repository: { id: 'JetBrains/example', organization: 'JetBrains', name: 'example', url: 'https://github.com/JetBrains/example', commit: NEW },
        refs: ['main (default branch)', 'v2.0'],
        scan: scan.example,
      },
    ],
    more: 0,
  });
  // The first sentence as scan prints it: up to its . ! or ?; none, empty.
  assert.deepEqual((await search('bump')).body.results.map((r: { sentence: string }) => r.sentence), ['Bump the Kotlin version!']);
  assert.deepEqual((await search('empty')).body.results.map((r: { sentence: string }) => r.sentence), ['']);
});

test('/api/search: matches as the filter does, every word, case-insensitive, in the name or the description', async (t) => {
  const { search } = await serve(t);
  assert.deepEqual(found((await search('COMMIT')).body), ['JetBrains/example commits', 'JetBrains/kotlin commits']);
  assert.deepEqual(found((await search('commit kotlin')).body), ['JetBrains/kotlin commits']);
  assert.deepEqual(found((await search('  version   KOTLIN ')).body), ['JetBrains/kotlin bump']);
  assert.deepEqual(found((await search('check tests')).body), ['JetBrains/example review']);
  assert.deepEqual(found((await search('commit gradle')).body), []);
});

test('/api/search: a word in the repository, <owner>/<repo>, finds its skills too', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  // The issue's case: a skill whose name and description do not hold `junie-slack`, its repository does.
  await store.set(`junie-slack-bot-youtrack@${NEW}`, {
    ref: 'main (default branch)',
    result: result('JetBrains/junie-slack-bot-youtrack', NEW, [['triage', 'Triage a YouTrack ticket.']]),
  });
  await store.set(`junie-sre@${OLD}`, {
    ref: 'main (default branch)',
    result: result('JetBrains/junie-sre', OLD, [['incident', 'Open an incident for Slack.']]),
  });
  const server = createWebServer({ open: () => Promise.reject(new Error('offline')), store });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const search = async (q: string) => found((await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`)).json()) as any);
  assert.deepEqual(await search('junie-slack'), ['JetBrains/junie-slack-bot-youtrack triage']);
  assert.deepEqual(await search('JETBRAINS/JUNIE-SRE'), ['JetBrains/junie-sre incident']);
  assert.deepEqual(await search('junie'), ['JetBrains/junie-sre incident', 'JetBrains/junie-slack-bot-youtrack triage']);
  // Every word, each in the name, the description or the repository.
  assert.deepEqual(await search('junie slack'), ['JetBrains/junie-sre incident', 'JetBrains/junie-slack-bot-youtrack triage']);
  assert.deepEqual(await search('junie-slack triage'), ['JetBrains/junie-slack-bot-youtrack triage']);
  assert.deepEqual(await search('junie-slack incident'), []);
  // A word does not span the repository and the name.
  assert.deepEqual(await search('youtracktriage'), []);
});

test('/api/search: a repository matched, only its latest stored scan', async (t) => {
  const { search } = await serve(t);
  assert.deepEqual(found((await search('jetbrains/example')).body), ['JetBrains/example commits', 'JetBrains/example review']);
  assert.deepEqual((await search('example old-only')).body, { results: [], more: 0 });
});

test('/api/search: sorted by name, then repository, then path', async (t) => {
  const { search } = await serve(t);
  // Every skill of the latest scans has an "e": the order of them all.
  assert.deepEqual(found((await search('e')).body), [
    'JetBrains/kotlin bump',
    'JetBrains/example commits',
    'JetBrains/kotlin commits',
    'JetBrains/kotlin empty',
    'JetBrains/example review',
  ]);
});

test('/api/search: skills of one name in one repository, sorted by path', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  // Stored out of path order, so the order found is the sort's, not the store's.
  await store.set(`example@${NEW}`, {
    ref: 'main (default branch)',
    result: result('JetBrains/example', NEW, [
      ['commits', 'Commit messages, for Claude.', '.claude/skills/commits/SKILL.md'],
      ['commits', 'Commit messages, for every agent.', '.agents/skills/commits/SKILL.md'],
    ]),
  });
  const server = createWebServer({ open: () => Promise.reject(new Error('offline')), store });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const { results } = (await (await fetch(`${base}/api/search?q=commits`)).json()) as { results: { id: string }[] };
  assert.deepEqual(
    results.map((r) => r.id),
    ['JetBrains/example:.agents/skills/commits/SKILL.md', 'JetBrains/example:.claude/skills/commits/SKILL.md'],
  );
});

test('/api/search: a repository scanned at several commits shows its skills once, from its latest stored scan', async (t) => {
  const { search, scan } = await serve(t);
  const { results } = (await search('commits')).body;
  const example = results.filter((r: { repository: { id: string } }) => r.repository.id === 'JetBrains/example');
  assert.equal(example.length, 1);
  assert.equal(example[0].repository.commit, NEW);
  assert.equal(example[0].scan, scan.example);
  assert.equal(example[0].sentence, 'Write commit messages the way this repository does now.');
  // A skill only in an older scan is not found.
  assert.deepEqual((await search('old-only')).body, { results: [], more: 0 });
  assert.deepEqual((await search('removed')).body, { results: [], more: 0 });
});

test('/api/search: from the store only, GitHub never asked; a result opens its scan as stored', async (t) => {
  const { search, requests, base, scan } = await serve(t);
  const { results } = (await search('commit')).body;
  assert.deepEqual(requests, []);
  const kotlin = results.find((r: { repository: { id: string } }) => r.repository.id === 'JetBrains/kotlin');
  assert.equal(kotlin.scan, scan.kotlin);
  const opened = (await (await fetch(`${base}/api/scans/${kotlin.scan}`)).json()) as { repository: { commit: string }; stored: string };
  assert.equal(opened.repository.commit, KOTLIN);
  assert.equal(opened.stored, scan.kotlin);
  assert.deepEqual(requests, []);
});

test('/api/search: no word, or no store: no results', async (t) => {
  const { search } = await serve(t);
  for (const q of [undefined, '', '   ']) assert.deepEqual(await search(q), { status: 200, type: 'application/json; charset=utf-8', body: { results: [], more: 0 } }, String(q));
  const server = createWebServer({ open: () => Promise.reject(new Error('offline')) });
  const base = await listen(server, 0);
  t.after(() => server.close());
  assert.deepEqual(await (await fetch(`${base}/api/search?q=commit`)).json(), { results: [], more: 0 });
});

test('the page: a search box in Scanned before, above its list', async (t) => {
  const { base } = await serve(t);
  const html = await (await fetch(`${base}/`)).text();
  const history = html.slice(html.indexOf('<details id="history"'), html.indexOf('</details>'));
  const box = history.indexOf('<input id="search" type="search"');
  assert.ok(box > 0, 'the search box is in Scanned before');
  assert.ok(box < history.indexOf('<ul id="scans">'), 'above its list');
  assert.ok(history.includes('<ul id="found" hidden>'), 'the results, hidden at first');
  assert.ok(history.includes('No skill in a stored scan matches.'));
});

test('the page, a search: no word, the list; else the results in its place, each opening its scan as stored', async (t) => {
  const { search, scan } = await serve(t);
  assert.deepEqual(searchView('  ', []), { searching: false, empty: false, rows: [], more: '' });
  assert.deepEqual(searchView('nothing', []), { searching: true, empty: true, rows: [], more: '' });
  const view = searchView('review', (await search('review')).body.results);
  assert.deepEqual(view, {
    searching: true,
    empty: false,
    rows: [
      {
        name: 'review',
        sentence: 'Review a Pull Request.',
        link: `https://github.com/JetBrains/example/blob/${NEW}/.claude/skills/review/SKILL.md`,
        repository: 'JetBrains/example',
        href: `/?scan=${scan.example}`,
        scan: scan.example,
        commit: NEW,
        short: NEW.slice(0, 12),
        refs: 'main (default branch), v2.0',
      },
    ],
    more: '',
  });
});

/** A store of `count` repositories, each with one skill matching "skill", and a server over it. */
async function serveMany(t: TestContext, count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-search-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = openStore(directory);
  // Stored in reverse, so the order found is the sort's, not the store's.
  for (let i = count - 1; i >= 0; i--) {
    const id = `JetBrains/repo-${String(i).padStart(3, '0')}`;
    await store.set(`${id}@${NEW}`, { ref: 'main (default branch)', result: result(id, NEW, [[`skill-${String(i).padStart(3, '0')}`, 'A skill.']]) });
  }
  const server = createWebServer({ open: () => Promise.reject(new Error('offline')), store });
  const base = await listen(server, 0);
  t.after(() => server.close());
  const search = async (q: string) => (await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`)).json()) as { results: { name: string }[]; more: number };
  return { directory, search };
}

test('/api/search: the first 50 results, in order, and how many more match', async (t) => {
  const { search } = await serveMany(t, 60);
  const { results, more } = await search('skill');
  assert.equal(results.length, 50);
  assert.deepEqual(
    results.map((r) => r.name),
    Array.from({ length: 50 }, (_, i) => `skill-${String(i).padStart(3, '0')}`),
  );
  assert.equal(more, 10);
  // Fewer matches than the cap: all of them, none more.
  const one = await search('skill-059');
  assert.deepEqual([one.results.map((r) => r.name), one.more], [['skill-059'], 0]);
});

test('/api/search: exactly 50 matches, all of them, none more', async (t) => {
  const { search } = await serveMany(t, 50);
  const { results, more } = await search('skill');
  assert.deepEqual([results.length, more], [50, 0]);
});

test('/api/search: each stored file read once a search', async (t) => {
  const { directory, search } = await serveMany(t, 5);
  const reads: string[] = [];
  const readFile = fs.readFile;
  mock.method(fs, 'readFile', function (this: unknown, ...args: Parameters<typeof fs.readFile>) {
    if (String(args[0]).startsWith(directory)) reads.push(String(args[0]));
    return readFile.apply(this, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal((await search('skill')).results.length, 5);
  assert.equal(reads.length, 5, reads.join('\n'));
  assert.equal(new Set(reads).size, 5);
});

test('the page, more than 50 results: and <M> more, after them', async (t) => {
  const { search } = await serveMany(t, 60);
  const { results, more } = await search('skill');
  const view = searchView('skill', results as any, more);
  assert.equal(view.rows.length, 50);
  assert.equal(view.more, 'and 10 more');
  assert.equal(searchView('skill', results.slice(0, 3) as any, 0).more, '');
  const { base } = await serve(t);
  const html = await (await fetch(`${base}/`)).text();
  const found = html.indexOf('<ul id="found" hidden>');
  assert.ok(found > 0 && found < html.indexOf('<p id="more" hidden>'), 'and <M> more, after the results');
});

test('the page: searched once the typing pauses, 250 ms, one request; an older answer not shown; emptied, the list at once', async (t) => {
  const { base } = await serve(t);
  assert.equal(SEARCH_PAUSE, 250);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const asked: string[] = [];
  const shown: [string, string[], number][] = [];
  let answered = () => {};
  const ask = async (query: string) => {
    asked.push(query);
    const body = (await (await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`)).json()) as { results: { name: string }[]; more: number };
    answered();
    return body;
  };
  const answer = () => new Promise<void>((resolve) => (answered = () => setImmediate(resolve)));
  const searchFor = searchAsker(ask, (query, { results, more }) => shown.push([query, results.map((r: { name: string }) => r.name), more]));

  // Typed a letter at a time: nothing asked until 250 ms after the last one.
  for (const query of ['r', 're', 'rev']) {
    searchFor(query);
    mock.timers.tick(SEARCH_PAUSE - 1);
  }
  assert.deepEqual(asked, []);
  let done = answer();
  mock.timers.tick(1);
  await done;
  assert.deepEqual(asked, ['rev']);
  assert.deepEqual(shown, [['rev', ['review'], 0]]);

  // An answer to an older word, come after the next word was typed: not shown.
  shown.length = 0;
  done = answer();
  searchFor('bump');
  mock.timers.tick(SEARCH_PAUSE);
  searchFor('commit');
  await done;
  assert.deepEqual(shown, []);
  done = answer();
  mock.timers.tick(SEARCH_PAUSE);
  await done;
  assert.deepEqual(shown, [['commit', ['commits', 'commits'], 0]]);

  // Emptied: the list at once, nothing asked, and a word pending is not asked either.
  shown.length = 0;
  asked.length = 0;
  searchFor('review');
  searchFor('  ');
  assert.deepEqual(shown, [['  ', [], 0]]);
  mock.timers.tick(SEARCH_PAUSE * 2);
  assert.deepEqual(asked, []);

  // Asked without a pause, after a scan: at the next tick.
  done = answer();
  searchFor('bump', 0);
  mock.timers.tick(0);
  await done;
  assert.deepEqual(asked, ['bump']);
});
