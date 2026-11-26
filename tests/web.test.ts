// The decisions in spec/web.md, checked on the real server: the page, /api/scan over ./fixture and
// the GitHub repository answered in tests/helpers.ts, and `skill-atlas serve` itself.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createWebServer, listen } from '../src/web/server.ts';
import { filterSkills } from '../src/web/public/filter.js';
import { addressRequest, historyView, storedBox } from '../src/web/public/history.js';
import { atlas, CLI, EXAMPLE_COMMIT, FIXTURE, open } from './helpers.ts';

const server = createWebServer({ open });
const base = await listen(server, 0);
after(() => server.close());

const scan = async (repo?: string) => {
  const response = await fetch(`${base}/api/scan${repo === undefined ? '' : `?repo=${encodeURIComponent(repo)}`}`);
  return { status: response.status, type: response.headers.get('content-type'), body: (await response.json()) as any };
};

test('serve listens on localhost and prints its URL', () => {
  assert.match(base, /^http:\/\/localhost:\d+$/);
});

test('the page: a box, Scan, a filter, the warnings and the scans before, as HTML, CSS and plain JavaScript', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await page.text();
  for (const part of ['<form id="scan">', 'id="repo"', '>Scan</button>', 'id="filter"', 'id="warnings"', 'id="history"', 'Scanned before', 'src="/app.js"'])
    assert.ok(html.includes(part), part);
  for (const [path, type] of [
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/filter.js', 'text/javascript; charset=utf-8'],
    ['/history.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'text/css; charset=utf-8'],
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
  }
});

test('an unknown path: 404; nothing else from disk', async () => {
  for (const path of ['/nope', '/index.html', '/../package.json', '/server.ts']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('/api/scan, a GitHub repository: the repository, each skill with its pinned link, the warnings', async () => {
  const { status, type, body } = await scan('github.com/JetBrains/example');
  assert.equal(status, 200);
  assert.equal(type, 'application/json; charset=utf-8');
  assert.deepEqual(body, {
    repository: {
      id: 'JetBrains/example',
      organization: 'JetBrains',
      name: 'example',
      url: 'https://github.com/JetBrains/example',
      commit: EXAMPLE_COMMIT,
    },
    skills: [
      {
        id: 'JetBrains/example:.claude/skills/commits/SKILL.md',
        name: 'commits',
        description: 'Write commit messages the way this repository does. Use for every commit.',
        path: '.claude/skills/commits/SKILL.md',
        commit: EXAMPLE_COMMIT,
        copies: [],
        link: `https://github.com/JetBrains/example/blob/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`,
      },
    ],
    warnings: [],
    stored: null,
  });
});

test('/api/scan, a local directory: the same skills as scan, the whole description, copies and warnings', async () => {
  const { status, body } = await scan(FIXTURE);
  assert.equal(status, 200);
  const root = pathToFileURL(FIXTURE).href;
  assert.deepEqual(
    body.skills.map((skill: { name: string; link: string; copies: string[] }) => [skill.name, skill.link, skill.copies]),
    [
      ['code-style', `${root}/.github/skills/code-style/SKILL.md`, []],
      ['commits', `${root}/.agents/skills/commits/SKILL.md`, ['.claude/skills/commits/SKILL.md']],
      ['gradle-bump', `${root}/tools/gradle/.claude/skills/gradle-bump/SKILL.md`, []],
      ['release-checklist', `${root}/.agents/skills/release-checklist/SKILL.md`, []],
      ['release-checklist', `${root}/.github/skills/release-checklist/SKILL.md`, []],
    ],
  );
  // The CLI prints the first sentence; the page gets the whole description.
  const cli = await atlas(['scan', FIXTURE]);
  for (const skill of body.skills) {
    if (skill.description) assert.ok(cli.stdout.includes(`${skill.name} — ${skill.description.split('. ')[0]}`), skill.name);
  }
  assert.deepEqual(body.warnings, [cli.stderr.replace(/^warning: /, '')]);
  assert.equal(body.repository.commit, '');
});

test('/api/scan, an error the CLI reports with exit code 1: 400 with its message', async () => {
  assert.deepEqual(await scan(), { status: 400, type: 'application/json; charset=utf-8', body: { error: 'Enter a GitHub URL or a directory' } });
  assert.deepEqual((await scan('  ')).body, { error: 'Enter a GitHub URL or a directory' });
  const missing = await scan(`${FIXTURE}/no-such-directory`);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body, { error: `Not a GitHub URL or a readable directory: ${FIXTURE}/no-such-directory` });
  const unknown = await scan('github.com/JetBrains/unknown');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /JetBrains\/unknown/);
});

test('/api/scan, anything else: 500 with the message', async () => {
  const broken = createWebServer({ open: () => Promise.reject(new Error('boom')) });
  const url = await listen(broken, 0);
  try {
    const response = await fetch(`${url}/api/scan?repo=x`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'boom' });
  } finally {
    broken.close();
  }
});

/** A request with its own Host header, which fetch does not let a test set. */
function statusFor(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    httpRequest({ host: '127.0.0.1', port, path: '/api/scan?repo=x', headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

test('local only: a localhost, 127.0.0.1 or [::1] host; any other: 403', async () => {
  const { port } = new URL(base);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
    assert.notEqual(await statusFor(host), 403, host);
  }
  for (const host of [`evil.example:${port}`, 'evil.example', `localhost.evil.example:${port}`]) {
    assert.equal(await statusFor(host), 403, host);
  }
});

test('the filter: every word, case-insensitive, in the name or the description', () => {
  const skills = [
    { name: 'commits', description: 'Write commit messages the way this repository does.' },
    { name: 'gradle-bump', description: 'Bump the Gradle version.' },
    { name: 'release-checklist', description: '' },
  ];
  const names = (query: string) => filterSkills(skills, query).map((skill) => skill.name);
  assert.deepEqual(names(''), ['commits', 'gradle-bump', 'release-checklist']);
  assert.deepEqual(names('  '), ['commits', 'gradle-bump', 'release-checklist']);
  assert.deepEqual(names('GRADLE'), ['gradle-bump']);
  assert.deepEqual(names('commit messages'), ['commits']);
  assert.deepEqual(names('commit gradle'), []);
  assert.deepEqual(names('release'), ['release-checklist']);
});

test('the address: /?repo= scans, /?scan=<id> opens a stored scan, repo first; nothing, neither', () => {
  assert.deepEqual(addressRequest('?repo=%20github.com%2FJetBrains%2Fexample%20'), {
    repo: 'github.com/JetBrains/example',
    url: '/api/scan?repo=github.com%2FJetBrains%2Fexample',
  });
  assert.deepEqual(addressRequest(`?scan=${'a'.repeat(64)}`), { scan: 'a'.repeat(64), url: `/api/scans/${'a'.repeat(64)}` });
  assert.deepEqual(addressRequest('?repo=./fixture&scan=abc'), { repo: './fixture', url: '/api/scan?repo=.%2Ffixture' });
  assert.equal(addressRequest('?scan=..%2Fpackage')?.url, '/api/scans/..%2Fpackage');
  for (const search of ['', '?', '?repo=', '?repo=%20&scan=']) assert.equal(addressRequest(search), undefined, search);
});

test('a stored scan on the page: the box holds <repository URL>/tree/<commit>', () => {
  assert.equal(
    storedBox({ url: 'https://github.com/JetBrains/example', commit: EXAMPLE_COMMIT }),
    `https://github.com/JetBrains/example/tree/${EXAMPLE_COMMIT}`,
  );
});

test('Scanned before: hidden while nothing is stored; a row per scan, in order; only the one on the page marked', () => {
  assert.deepEqual(historyView([], 'a'), { hidden: true, rows: [] });
  const repository = { id: 'JetBrains/example', commit: EXAMPLE_COMMIT };
  // The same commit twice: the default branch and /tree/<commit>, told apart by what was asked for.
  const scans = [
    { id: 'b', repository, ref: 'main (default branch)', skills: 1, warnings: 0, scannedAt: '2026-11-26T10:01:00.000Z' },
    { id: 'a', repository, ref: EXAMPLE_COMMIT, skills: 2, warnings: 1, scannedAt: '2026-11-26T10:00:00.000Z' },
  ];
  const view = historyView(scans, 'a', (iso: string) => iso.slice(11, 16));
  assert.equal(view.hidden, false);
  assert.deepEqual(view.rows, [
    {
      id: 'b',
      href: '/?scan=b',
      name: 'JetBrains/example',
      commit: EXAMPLE_COMMIT,
      short: EXAMPLE_COMMIT.slice(0, 12),
      details: 'main (default branch) · 1 skill · 10:01',
      current: false,
    },
    {
      id: 'a',
      href: '/?scan=a',
      name: 'JetBrains/example',
      commit: EXAMPLE_COMMIT,
      short: EXAMPLE_COMMIT.slice(0, 12),
      details: `${EXAMPLE_COMMIT} · 2 skills · 1 warning · 10:00`,
      current: true,
    },
  ]);
  // Not stored, or nothing on the page: none marked.
  for (const shown of [null, undefined, '']) assert.ok(historyView(scans, shown).rows.every((row) => !row.current), String(shown));
});

test('skill-atlas serve --port: the real CLI prints its URL and serves the page', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [line] = await once(child.stdout, 'data');
    assert.equal(String(line).trim(), `Skill Atlas at http://localhost:${port} · Ctrl+C stops it`);
    assert.equal((await fetch(`http://localhost:${port}/`)).status, 200);
    const { skills } = (await (await fetch(`http://localhost:${port}/api/scan?repo=${encodeURIComponent(FIXTURE)}`)).json()) as { skills: unknown[] };
    assert.equal(skills.length, 5);
  } finally {
    child.kill();
  }
});

test('skill-atlas serve: a port in use or not a number → a clear message, exit code 1', async () => {
  const { port } = new URL(base);
  const inUse = spawnSync(process.execPath, [CLI, 'serve', '--port', port], { encoding: 'utf8' });
  assert.equal(inUse.status, 1);
  assert.equal(inUse.stderr.trim(), `Port ${port} is in use; pick another with --port`);
  for (const args of [['--port', 'abc'], ['--port', '70000']]) {
    const bad = await atlas(['serve', ...args]);
    assert.equal(bad.code, 1);
    assert.equal(bad.stderr, `Not a port: ${args[1]}\nUsage: skill-atlas serve [--port <port>]`);
  }
  assert.deepEqual(await atlas(['serve', '--port']), { code: 1, stdout: '', stderr: 'Usage: skill-atlas serve [--port <port>]' });
});

test('help lists serve', async () => {
  assert.match((await atlas(['help'])).stdout, /serve \[--port <port>\] +the same, in a browser, on http:\/\/localhost:4173/);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}
