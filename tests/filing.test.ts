// The rule of #44: every skill that files a GitHub issue (`gh issue create`) has the same "Filing an issue" section,
// word for word: search for a duplicate first, file, then add the Delegate to AI label in a second call, and name the issue.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = '.agents/skills';
const HEADING = '## Filing an issue\n';

/** The "Filing an issue" section of a skill, up to the next section of its level, or undefined. */
function section(text: string): string | undefined {
  const start = text.indexOf(HEADING);
  if (start < 0) return undefined;
  const rest = text.slice(start + HEADING.length);
  const next = rest.search(/^## /m);
  return HEADING + (next < 0 ? rest : rest.slice(0, next));
}

/** The skills under `root` that file an issue, by name, with their section. */
function filers(root: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const name of readdirSync(join(root, SKILLS)).sort()) {
    const file = join(root, SKILLS, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('gh issue create') || text.includes('[Filing an issue]')) found.set(name, section(text));
  }
  return found;
}

/** What is wrong with the skills under `root`, as messages. */
function problems(root: string): string[] {
  const found = filers(root);
  const sections = [...found].filter(([, s]) => s !== undefined) as [string, string][];
  const messages = [...found].filter(([, s]) => s === undefined).map(([name]) => `${name} files an issue but has no "Filing an issue" section`);
  for (const [name, s] of sections.slice(1))
    if (s.trimEnd() !== sections[0][1].trimEnd()) messages.push(`${name}'s "Filing an issue" differs from ${sections[0][0]}'s`);
  return messages;
}

test('every skill that files an issue has the same "Filing an issue" section', () => {
  const found = filers(REPOSITORY);
  assert.ok(found.has('issue-to-pr') && found.has('address-review'), `filers: ${[...found.keys()]}`);
  assert.deepEqual(problems(REPOSITORY), []);
});

test('the section searches for a duplicate, labels the issue in a second call and names it', () => {
  const s = section(readFileSync(join(REPOSITORY, SKILLS, 'issue-to-pr', 'SKILL.md'), 'utf8'));
  assert.ok(s);
  assert.match(s, /gh issue list --search "<words> in:title" --state open/);
  assert.match(s, /gh issue comment/);
  const create = s.split('\n').find((line) => line.includes('$(gh issue create'));
  assert.ok(create, 'the section files the issue with gh issue create');
  assert.doesNotMatch(create, /--label/, 'the label is not given on gh issue create');
  const edit = s.indexOf('gh issue edit "$M" --add-label "Delegate to AI"');
  assert.ok(edit > s.indexOf(create), 'the label is added after the issue exists');
  assert.match(s, /#<m>/);
});

test('a filing skill without the section, or with another wording, is a problem', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skill-filing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = (name: string, body: string) => {
    mkdirSync(join(root, SKILLS, name), { recursive: true });
    writeFileSync(join(root, SKILLS, name, 'SKILL.md'), body);
  };
  const rule = `${HEADING}1. Search, file with \`gh issue create\`, then label it.\n`;
  skill('a-first', `# A\nStep.\n\n${rule}`);
  skill('b-same', `# B\n${rule}\n## Later\nMore.\n`);
  skill('c-other', `# C\n${HEADING}1. File with \`gh issue create --label x\`.\n`);
  skill('d-none', '# D\nOpen an issue (`gh issue create`).\n');
  skill('e-no-issues', '# E\nNothing filed.\n');
  assert.deepEqual(problems(root), [
    'd-none files an issue but has no "Filing an issue" section',
    `c-other's "Filing an issue" differs from a-first's`,
  ]);
});
