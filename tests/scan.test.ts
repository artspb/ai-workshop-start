// The decisions in spec/analysis.md and spec/cli.md, checked on what the real command prints for
// ./fixture and for a small GitHub repository answered in tests/helpers.ts. ./fixture holds one
// case of what a project skill is per path; see fixture/README.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { run } from '../src/commands.ts';
import { findSkills } from '../src/core/find.ts';
import { openGitHub, parseGitHubUrl } from '../src/core/github.ts';
import { parseSkill } from '../src/core/parse.ts';
import { replay } from '../src/core/replay.ts';
import { atlas, CLI, EXAMPLE_COMMIT, FIXTURE } from './helpers.ts';

const fixture = await atlas(['scan', FIXTURE]);
const example = await atlas(['scan', 'github.com/JetBrains/example']);

test('malformed front matter → the directory name, no description and a warning', () => {
  const parsed = parseSkill(readFileSync(join(FIXTURE, '.agents/skills/release-checklist/SKILL.md'), 'utf8'));
  assert.equal(parsed.name, undefined);
  assert.equal(parsed.description, '');
  assert.equal(
    parsed.warning,
    'malformed front matter: Nested mappings are not allowed in compact mappings at line 3, column 14; using the directory name',
  );
});

test('scan prints the repository, then each skill with its first sentence and pinned link', () => {
  assert.equal(example.code, 0, example.stderr);
  assert.equal(
    example.stdout,
    [
      'JetBrains/example · 1 skill',
      'commits — Write commit messages the way this repository does.',
      `  https://github.com/JetBrains/example/blob/${EXAMPLE_COMMIT}/.claude/skills/commits/SKILL.md`,
    ].join('\n'),
  );
});

/** What ./fixture holds, as the spec counts it: five project skills, one of them with a copy. */
function fixtureOutput(root: string): string {
  return [
    'fixture · 5 skills',
    "code-style — Follow the project's code style.",
    `  ${root}/.github/skills/code-style/SKILL.md`,
    'commits — Write commit messages the way this repository does.',
    `  ${root}/.agents/skills/commits/SKILL.md`,
    '  also in .claude/skills/commits/SKILL.md',
    'gradle-bump — Bump the Gradle version of tools/gradle.',
    `  ${root}/tools/gradle/.claude/skills/gradle-bump/SKILL.md`,
    'release-checklist',
    `  ${root}/.agents/skills/release-checklist/SKILL.md`,
    'release-checklist — Steps before a release.',
    `  ${root}/.github/skills/release-checklist/SKILL.md`,
  ].join('\n');
}

test('./fixture: every project skill, sorted by name then path, copies folded, a warning for the malformed one', () => {
  assert.equal(fixture.code, 0);
  assert.equal(fixture.stdout, fixtureOutput(pathToFileURL(FIXTURE).href));
  assert.equal(
    fixture.stderr,
    'warning: .agents/skills/release-checklist/SKILL.md: malformed front matter: ' +
      'Nested mappings are not allowed in compact mappings at line 3, column 14; using the directory name',
  );
});

/** A directory as GitHub's tree lists it: every file, a symbolic link as itself, with mode 120000. */
function gitTree(root: string, directory = ''): { path: string; mode: string; type: string; sha: string }[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return gitTree(root, path);
    // git keeps a symbolic link, to a file or a directory, as a blob
    return [{ path, mode: entry.isSymbolicLink() ? '120000' : '100644', type: 'blob', sha: '0' }];
  });
}

test('./fixture on GitHub, listed through the tree: the same project skills, symbolic links left out', async () => {
  // The fixture as GitHub's tree answers it: every file, the symbolic links with mode 120000.
  const tree = gitTree(FIXTURE);
  const raw = Object.fromEntries(
    tree
      .filter((item) => item.mode !== '120000')
      .map((item) => [
        `https://raw.githubusercontent.com/JetBrains/fixture/${EXAMPLE_COMMIT}/${item.path}`,
        { status: 200, body: readFileSync(join(FIXTURE, item.path), 'utf8') },
      ]),
  );
  const github = replay({
    'https://api.github.com/repos/JetBrains/fixture': { status: 200, body: { full_name: 'JetBrains/fixture', default_branch: 'main' } },
    'https://api.github.com/repos/JetBrains/fixture/commits/main': { status: 200, body: { sha: EXAMPLE_COMMIT } },
    [`https://api.github.com/repos/JetBrains/fixture/git/trees/${EXAMPLE_COMMIT}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree },
    },
    ...raw,
  });
  const stdout: string[] = [];
  const code = await run(['scan', 'https://github.com/JetBrains/fixture'], {
    open: (input) => openGitHub(input, { fetch: github }),
    print: (text) => stdout.push(text),
    error: () => {},
    serve: () => Promise.reject(new Error('not served')),
  });
  assert.equal(code, 0);
  assert.equal(
    stdout.join('\n'),
    fixtureOutput(`https://github.com/JetBrains/fixture/blob/${EXAMPLE_COMMIT}`).replace('fixture · ', 'JetBrains/fixture · '),
  );
});

test('a skill under .git or node_modules is not a project skill', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = '---\nname: x\ndescription: X.\n---\n';
  for (const directory of ['.git', 'node_modules/some-package']) {
    mkdirSync(join(root, directory, '.claude/skills/x'), { recursive: true });
    writeFileSync(join(root, directory, '.claude/skills/x/SKILL.md'), skill);
  }
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  assert.equal(scanned.stdout, `${basename(root)} · 0 skills`);
  // GitHub never lists .git, but a repository can commit node_modules.
  assert.deepEqual(findSkills(['node_modules/p/.claude/skills/x/SKILL.md', '.claude/skills/x/SKILL.md']), [
    { path: '.claude/skills/x/SKILL.md', name: 'x' },
  ]);
});

test('the CLI prints the result at once; a local directory: nothing stored', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-atlas-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scanned = spawnSync(process.execPath, [CLI, 'scan', FIXTURE], { cwd, encoding: 'utf8' });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(scanned.stdout, `${fixture.stdout}\n`);
  assert.deepEqual(readdirSync(cwd), []);
});

test('unreachable repository → a clear message, exit code 1', async () => {
  const missing = spawnSync(process.execPath, [CLI, 'scan', join(FIXTURE, 'no-such-directory')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^Not a GitHub URL or a readable directory: .*no-such-directory\n$/);

  // What GitHub answers for a repository that does not exist.
  const notFound = replay({ 'https://api.github.com/repos/JetBrains/no-such-repository': { status: 404, body: { message: 'Not Found' } } });
  await assert.rejects(openGitHub('https://github.com/JetBrains/no-such-repository', { fetch: notFound }), {
    message: 'Repository not found: https://github.com/JetBrains/no-such-repository',
  });

  const offline = await atlas(['scan', 'https://github.com/JetBrains/not-answered']);
  assert.equal(offline.code, 1);
  assert.match(offline.stderr, /^Cannot reach GitHub: not recorded: https:\/\/api\.github\.com\/repos\/JetBrains\/not-answered$/);
});

test('rate limit → a message that asks for GITHUB_TOKEN', async () => {
  const limited = replay({
    'https://api.github.com/repos/JetBrains/MPS': {
      status: 403,
      body: { message: 'API rate limit exceeded for 192.0.2.1. (But here is the good news: ...)' },
    },
  });
  await assert.rejects(openGitHub('https://github.com/JetBrains/MPS', { fetch: limited }), {
    message: 'GitHub rate limit reached; set GITHUB_TOKEN',
  });
});

test('/tree/<ref>: that commit, listed through its tree even with a token; an unknown ref, a clear message', async () => {
  const commit = '1111111111111111111111111111111111111111';
  const github = replay({
    'https://api.github.com/repos/JetBrains/example': { status: 200, body: { full_name: 'JetBrains/example', default_branch: 'main' } },
    'https://api.github.com/repos/JetBrains/example/commits/v1.0': { status: 200, body: { sha: commit } },
    [`https://api.github.com/repos/JetBrains/example/git/trees/${commit}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree: [{ path: '.claude/skills/commits/SKILL.md', mode: '100644', type: 'blob', sha: '0' }] },
    },
    [`https://raw.githubusercontent.com/JetBrains/example/${commit}/.claude/skills/commits/SKILL.md`]: {
      status: 200,
      body: '---\nname: commits\ndescription: Commit messages, as of v1.0.\n---\n',
    },
    'https://api.github.com/repos/JetBrains/example/commits/no-such-ref': { status: 404, body: { message: 'Not Found' } },
  });
  // No search is recorded: a search would fail the scan.
  const source = await openGitHub('https://github.com/JetBrains/example/tree/v1.0/', { fetch: github, token: 'test' });
  assert.equal(source.repository.commit, commit);
  assert.deepEqual((await source.list()).paths, ['.claude/skills/commits/SKILL.md']);

  await assert.rejects(openGitHub('github.com/JetBrains/example/tree/no-such-ref', { fetch: github, token: 'test' }), {
    message: 'Not found in https://github.com/JetBrains/example: no-such-ref',
  });
  assert.equal(parseGitHubUrl('github.com/JetBrains/example/tree/main/docs'), undefined);
});

test("this repository's skills: each .claude/skills file is a copy of its .agents/skills one", async () => {
  // An edit to one copy and not the other turns one skill into two: the scan would list both.
  const root = fileURLToPath(new URL('..', import.meta.url));
  // From both sides: a skill on one side only fails the path check or the `also in` check below.
  const names = [...new Set([...readdirSync(join(root, '.agents/skills')), ...readdirSync(join(root, '.claude/skills'))])];
  assert.ok(names.includes('code-review') && names.includes('issue-to-pr'), names.join(', '));
  const scanned = await atlas(['scan', root]);
  assert.equal(scanned.code, 0, scanned.stderr);
  const lines = scanned.stdout.split('\n');
  for (const name of names) {
    const found = lines.flatMap((line, index) => (line.startsWith(`${name} — `) ? [lines.slice(index, index + 3)] : []));
    assert.equal(found.length, 1, `${name}:\n${scanned.stdout}`);
    assert.ok(found[0][1].endsWith(`/.agents/skills/${name}/SKILL.md`), found[0][1]);
    assert.equal(found[0][2], `  also in .claude/skills/${name}/SKILL.md`);
  }
});
