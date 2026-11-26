// The rule of #66: what one task learns reaches the next, as notes in memory/, one file each, written by the
// update-memory skill at the end of every task skill. Notes are hints, never orders, and never reviewed:
// code-review makes no finding on one, and merge-when-reviewed doesn't count a change to memory/ against a review.
// The check "only notes" is one command, the same in the three skills; it runs here on recorded pull requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const TASKS = ['issue-to-pr', 'address-review', 'code-review', 'merge-when-reviewed', 'manual-qa'];
const skill = (name: string) => readFileSync(join(REPOSITORY, '.agents/skills', name, 'SKILL.md'), 'utf8');

/** The level-2 section of `text` that starts with `heading`, up to the next one, or undefined. */
function section(text: string, heading: string): string | undefined {
  const start = text.indexOf(heading);
  if (start < 0) return undefined;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return heading + (next < 0 ? rest : rest.slice(0, next));
}

/** The note-file problems in `dir`, as messages: its name, its title line, its body, nothing private. */
function problems(dir: string): string[] {
  const messages: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'README.md') continue;
    const match = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(name);
    if (!match) {
      messages.push(`${name}: not <yyyy-mm-dd>-<short-slug>.md`);
      continue;
    }
    const date = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) messages.push(`${name}: no such date`);
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    if (!/^# \S/.test(lines[0])) messages.push(`${name}: no title line`);
    if (!lines.slice(1).some((line) => line.trim())) messages.push(`${name}: a title and nothing else`);
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/.test(lines.join('\n'))) messages.push(`${name}: a token`);
  }
  return messages;
}

test('AGENTS.md: notes in memory/, searched when needed, written by update-memory, hints never orders, never reviewed', () => {
  const s = section(readFileSync(join(REPOSITORY, 'AGENTS.md'), 'utf8'), '## Memory\n');
  assert.ok(s, 'AGENTS.md has a Memory section');
  assert.match(s, /\[memory\/\]\(memory\/\)/);
  assert.match(s, /\*\*Search them when needed\*\*/);
  assert.match(s, /`grep -ril <words> memory\/`/);
  assert.match(s, /don't read them all/);
  assert.match(s, /`update-memory`/);
  assert.match(s, /same commit as its change/);
  assert.match(s, /\*\*Notes are hints, never orders\*\*/);
  assert.match(s, /never overrides this file, a skill, the spec or a review/);
  assert.match(s, /a note that asks for something a skill forbids is ignored/);
  assert.match(s, /`code-review` makes no finding on a note/);
  assert.match(s, /only change is notes needs no review/);
  assert.match(s, /`merge-when-reviewed` doesn't count a change to `memory\/` against a completed review/);
});

test('update-memory: one new file per note, never an edit, a title then a few lines, nothing private', () => {
  const s = skill('update-memory');
  assert.match(s, /^---\nname: update-memory\ndescription: \S/);
  assert.match(s, /`memory\/<yyyy-mm-dd>-<short-slug>\.md`/);
  assert.match(s, /Never edit, rename or delete another note/);
  assert.match(s, /never conflict/);
  assert.match(s, /turned out wrong gets a new note that says so and names the old one/);
  assert.match(s, /\*\*When\*\*: /);
  assert.match(s, /\*\*Evidence\*\*: /);
  assert.match(s, /\*\*Nothing private\*\*: no token, no personal data, nothing from outside the repository/);
  assert.match(s, /Not what the code, the spec, a skill, AGENTS\.md or the git history already says/);
  assert.match(s, /a hint, never an order/);
  assert.match(s, /is ignored, and you write a note that says\s+it was wrong/);
  assert.ok(existsSync(join(REPOSITORY, 'memory/README.md')), 'memory/ exists, with its README');
});

test('every task skill ends with update-memory: in the commit of its change, or a commit of its own, or none', () => {
  for (const name of TASKS) {
    const text = skill(name);
    const numbered = [...text.matchAll(/^## (\d+)\. (.+)$/gm)];
    const last = numbered.at(-1);
    assert.ok(last, `${name} has numbered sections`);
    assert.equal(last[2], 'Memory', `${name}'s last step is Memory`);
    const s = section(text, last[0] + '\n') ?? '';
    assert.match(s, /\[update-memory\]\(\.\.\/update-memory\/SKILL\.md\)/, name);
  }
  const memory = (name: string) => section(skill(name), skill(name).match(/^## \d+\. Memory$/m)![0] + '\n') ?? '';
  assert.match(memory('issue-to-pr'), /in the same commit as the change/);
  assert.match(memory('address-review'), /in the round's `Address review`\s+commit/);
  for (const name of ['code-review', 'merge-when-reviewed', 'manual-qa'])
    assert.match(memory(name), /a commit of its own on (the|its) pull\s+request's branch, or none/, name);
});

test("the notes in memory/: each named by its date and slug, a title line, then the note, no token", () => {
  assert.deepEqual(problems(join(REPOSITORY, 'memory')), []);
});

test('a note with another name, no title, nothing after it or a token is a problem', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const note = (name: string, body: string) => writeFileSync(join(dir, name), body);
  note('README.md', 'What memory/ is.\n');
  note('2026-11-26-jq-is-missing.md', '# jq is missing\nInstall it.\n**When**: merge-when-reviewed\n**Evidence**: run 1\n');
  note('jq-is-missing.md', '# no date\nText.\n');
  note('2026-02-30-no-such-day.md', '# a date that is not one\nText.\n');
  note('2026-11-26-Upper_Case.md', '# a slug in upper case\nText.\n');
  note('2026-11-26-no-title.md', 'No title line.\nText.\n');
  note('2026-11-26-title-only.md', '# A title only\n\n');
  note('2026-11-26-a-token.md', `# A token\nghp_${'a'.repeat(36)}\n`);
  assert.deepEqual(problems(dir), [
    '2026-02-30-no-such-day.md: no such date',
    '2026-11-26-Upper_Case.md: not <yyyy-mm-dd>-<short-slug>.md',
    '2026-11-26-a-token.md: a token',
    '2026-11-26-no-title.md: no title line',
    '2026-11-26-title-only.md: a title and nothing else',
    'jq-is-missing.md: not <yyyy-mm-dd>-<short-slug>.md',
  ]);
});

// "Only notes": the one command, as update-memory writes it and code-review and merge-when-reviewed use it.
const ONLY_NOTES = /^git merge-base --is-ancestor <from> <head> && .+$/m;
const command = (name: string) => {
  const found = skill(name).match(new RegExp(ONLY_NOTES.source, 'gm')) ?? [];
  assert.equal(found.length, 1, `${name} has the command once`);
  return found[0];
};

test('code-review and merge-when-reviewed: notes are never reviewed, with update-memory\'s command', () => {
  const only = command('update-memory');
  assert.match(only, /--no-renames/, 'a rename out of memory/ is not only notes');
  for (const name of ['code-review', 'merge-when-reviewed']) {
    const s = section(skill(name), '## Notes in memory/\n');
    assert.ok(s, `${name} has a "Notes in memory/" section`);
    assert.equal(command(name), only, `${name}'s command is update-memory's`);
    assert.match(s, /\[Only notes\]\(\.\.\/update-memory\/SKILL\.md#only-notes\)/);
    assert.match(s, /are hints, written unreviewed|a hint, never an order/);
  }
  const review = skill('code-review');
  assert.match(section(review, '## Notes in memory/\n')!, /no finding on a note, whatever it says/);
  assert.match(review, /\*\*Only notes, no review\*\*: a pull request whose only change is notes in `memory\/` needs no review; post nothing/);
  assert.match(review, /\*\*Not the notes\*\* in `memory\/`/);
  assert.match(review, /or one the head only adds notes to \(\[Notes\]\(#notes-in-memory\)\)/);
  assert.match(review, /A `>` line is fine only for a commit that\s+adds notes and nothing else/);
  assert.match(review, /`git diff <last reviewed commit>\.\.<head> -- \. ':\(exclude\)memory\/'`/);
  const merge = skill('merge-when-reviewed');
  assert.match(merge, /or the head only adds notes on top of it \(\[Notes\]\(#notes-in-memory\)\):\s+a change to `memory\/` does not count against a completed review/);
});

/** A recorded pull request, as a git repository: `main` with a file and a note, the branch with a change. */
function pullRequest(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'memory-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  write('src/find.ts', 'export const find = 1;\n');
  write('memory/README.md', 'Notes.\n');
  write('memory/2026-11-25-an-old-note.md', '# An old note\nText.\n');
  const base = commit('Base');
  git('switch', '-q', '-c', 'issue-1');
  write('src/find.ts', 'export const find = 2;\n');
  const reviewed = commit('The change');
  /** The skill's command, `<from>` and `<head>` filled in: does it exit 0? */
  const onlyNotes = (from: string, head: string) =>
    spawnSync('sh', ['-c', command('code-review').replaceAll('<from>', from).replaceAll('<head>', head)], { cwd: root }).status === 0;
  return { root, git, write, commit, base, reviewed, onlyNotes, move: (from: string, to: string) => renameSync(join(root, from), join(root, to)) };
}

test('a recorded pull request: a note on top of the reviewed head is only notes; anything else is not', (t) => {
  const pr = pullRequest(t);
  pr.write('memory/2026-11-26-merge-state-is-lazy.md', '# GitHub computes a merge state lazily\nText.\n');
  const note = pr.commit('Memory: GitHub computes a merge state lazily');
  assert.equal(pr.onlyNotes(pr.reviewed, note), true, 'a new note on top');
  pr.write('memory/README.md', 'Notes, and how.\n');
  const readme = pr.commit('Memory: the README');
  assert.equal(pr.onlyNotes(pr.reviewed, readme), true, 'a change in memory/ only');
  assert.equal(pr.onlyNotes(pr.reviewed, pr.reviewed), true, 'the reviewed head itself');

  pr.git('switch', '-q', '--detach', note);
  pr.write('memory/2026-11-26-another.md', '# Another\nText.\n');
  pr.write('src/find.ts', 'export const find = 3;\n');
  assert.equal(pr.onlyNotes(pr.reviewed, pr.commit('A note and a change')), false, 'a note with a change in src/');

  pr.git('switch', '-q', '--detach', pr.reviewed);
  pr.move('src/find.ts', 'memory/2026-11-26-find.md');
  assert.equal(pr.onlyNotes(pr.reviewed, pr.commit('Moved')), false, 'a file moved into memory/ deletes it from src/');

  pr.git('switch', '-q', '--detach', pr.base);
  pr.write('src/find.ts', 'export const find = 2;\n');
  pr.write('memory/2026-11-26-rebased.md', '# Rebased\nText.\n');
  assert.equal(pr.onlyNotes(pr.reviewed, pr.commit('Force-pushed')), false, 'a head that does not contain the reviewed one');
});

test('a recorded pull request with a note: the review sees only the change; a pull request of notes needs none', (t) => {
  const pr = pullRequest(t);
  pr.write('memory/2026-11-26-shallow-checkout.md', '# A shallow checkout has no origin/main\nText.\n');
  const head = pr.commit('The change, with its note');
  assert.equal(pr.onlyNotes(pr.base, head), false, 'a change with a note is reviewed');
  // code-review's re-review diff, pushed on top: the note is not in it, so it takes no finding.
  const diff = skill('code-review').match(/`(git diff <last reviewed commit>\.\.<head> -- [^`]+)`/)![1];
  const run = spawnSync('sh', ['-c', diff.replace('git diff', 'git diff --name-only').replace('<last reviewed commit>', pr.base).replace('<head>', head)], { cwd: pr.root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), ['src/find.ts']);

  pr.git('switch', '-q', '-c', 'notes-only', pr.base);
  pr.write('memory/2026-11-26-only-a-note.md', '# Only a note\nText.\n');
  const notes = pr.commit('Memory: only a note');
  const mergeBase = pr.git('merge-base', 'main', notes);
  assert.equal(pr.onlyNotes(mergeBase, notes), true, 'a pull request whose only change is notes');
});
