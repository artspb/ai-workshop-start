// The rule of #50: whenever a skill leaves a decision for a person, the comment that says so mentions the owner,
// once per decision. Every skill that hands over has the same "Handing over to a person" section, word for word,
// and the owner's handle is written in one place only, AGENTS.md's "Owner" section, never in a skill.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['.agents/skills', '.claude/skills'] as const;
const HEADING = '## Handing over to a person\n';
const LINK = '](#handing-over-to-a-person)';

/** The level-2 section of `text` that starts with `heading`, up to the next one, or undefined. */
function section(text: string, heading: string): string | undefined {
  const start = text.indexOf(heading);
  if (start < 0) return undefined;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return heading + (next < 0 ? rest : rest.slice(0, next));
}

/** The text of each skill under `root`/`dir`, by name. */
function skills(root: string, dir: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(join(root, dir))) return found;
  for (const name of readdirSync(join(root, dir)).sort()) {
    const file = join(root, dir, name, 'SKILL.md');
    if (existsSync(file)) found.set(name, readFileSync(file, 'utf8'));
  }
  return found;
}

/** The skills under `root` that hand over to a person, by name, with their section. */
function handers(root: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const [name, text] of skills(root, ROOTS[0]))
    if (text.includes(LINK) || text.includes(HEADING)) found.set(name, section(text, HEADING));
  return found;
}

/** The owner's handle, `@<login>`, from AGENTS.md's "Owner" section, or undefined. */
function owner(root: string): string | undefined {
  const file = join(root, 'AGENTS.md');
  const s = existsSync(file) ? section(readFileSync(file, 'utf8'), '## Owner\n') : undefined;
  const handles = s?.match(/`@[A-Za-z0-9-]+`/g) ?? [];
  return handles.length === 1 ? handles[0].slice(1, -1) : undefined;
}

/** What is wrong with the skills under `root`, as messages. */
function problems(root: string): string[] {
  const found = handers(root);
  const messages = [...found].filter(([, s]) => s === undefined).map(([name]) => `${name} hands over but has no "Handing over to a person" section`);
  const sections = [...found].filter(([, s]) => s !== undefined) as [string, string][];
  for (const [name, s] of sections.slice(1))
    if (s.trimEnd() !== sections[0][1].trimEnd()) messages.push(`${name}'s "Handing over to a person" differs from ${sections[0][0]}'s`);
  for (const [name, s] of sections) if (!s.includes('AGENTS.md#owner')) messages.push(`${name}'s section does not point to AGENTS.md#owner`);
  const handle = owner(root);
  if (handle === undefined) messages.push('AGENTS.md has no "Owner" section with exactly one `@<login>`');
  else
    for (const dir of ROOTS)
      for (const [name, text] of skills(root, dir))
        if (new RegExp(`${handle}(?![A-Za-z0-9-])`, 'i').test(text)) messages.push(`${dir}/${name}/SKILL.md spells out ${handle}`);
  return messages;
}

test('every skill that hands over has the same "Handing over to a person" section, and no skill spells out the owner', () => {
  const found = handers(REPOSITORY);
  for (const name of ['address-review', 'code-review', 'issue-to-pr', 'merge-when-reviewed'])
    assert.ok(found.has(name), `${name} hands over; found: ${[...found.keys()]}`);
  assert.deepEqual(problems(REPOSITORY), []);
});

test('AGENTS.md names the owner once', () => {
  assert.match(owner(REPOSITORY) ?? '', /^@[A-Za-z0-9-]+$/);
});

test('the section mentions the owner once per decision, as a question with its options, and never again', () => {
  const s = section(readFileSync(join(REPOSITORY, ROOTS[0], 'issue-to-pr', 'SKILL.md'), 'utf8'), HEADING);
  assert.ok(s);
  assert.match(s, /AGENTS\.md#owner/);
  assert.match(s, /once/i);
  assert.match(s, /question/i);
  assert.match(s, /options/i);
  assert.match(s, /already mentions/i);
  assert.match(s, /posts nothing new/i);
});

test('each hand-over the issue names points to the section', () => {
  const text = (name: string) => readFileSync(join(REPOSITORY, ROOTS[0], name, 'SKILL.md'), 'utf8');
  /** The paragraph or list item of `name` that contains `phrase`, which must link to the section. */
  const handsOver = (name: string, phrase: string) => {
    const t = text(name);
    const at = t.indexOf(phrase);
    assert.ok(at >= 0, `${name}: "${phrase}" not found`);
    const start = t.lastIndexOf('\n- ', at);
    const end = t.indexOf('\n- ', at);
    const item = t.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
    assert.ok(item.includes(LINK), `${name}: the item with "${phrase}" does not link to the section`);
  };
  handsOver('code-review', '**Leave it open**');
  handsOver('code-review', 'No review of <headRefOid>');
  handsOver('address-review', '**A choice the spec leaves open, or two reviewers disagree**');
  handsOver('address-review', 'Stopped after 3 rounds of review fixes');
  handsOver('merge-when-reviewed', 'For a person to resolve');
  handsOver('issue-to-pr', '**Unclear, or two reasonable readings that change the result?**');
});

test('a hand-over without the section, another wording or a spelled-out owner is a problem', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skill-handover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = (dir: string, name: string, body: string) => {
    mkdirSync(join(root, dir, name), { recursive: true });
    writeFileSync(join(root, dir, name, 'SKILL.md'), body);
  };
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS.md\n## Owner\n`@someone`: decisions.\n## Other\n`@else`\n');
  const rule = `${HEADING}1. Mention the [owner](../../../AGENTS.md#owner), once.\n`;
  skill('.agents/skills', 'a-first', `# A\nAsk ([Handing over to a person${LINK}).\n\n${rule}`);
  skill('.agents/skills', 'b-same', `# B\n${rule}\n## Later\nMore.\n`);
  skill('.agents/skills', 'c-other', `# C\n${HEADING}1. Mention the [owner](../../../AGENTS.md#owner), twice.\n`);
  skill('.agents/skills', 'd-none', `# D\nAsk a person ([Handing over to a person${LINK}).\n`);
  skill('.agents/skills', 'e-nothing', '# E\nNothing to hand over.\n');
  skill('.claude/skills', 'f-spelled', '# F\nMention @Someone.\n');
  skill('.claude/skills', 'g-longer', '# G\nMention @someone-else, another login.\n');
  assert.deepEqual(problems(root), [
    'd-none hands over but has no "Handing over to a person" section',
    `c-other's "Handing over to a person" differs from a-first's`,
    '.claude/skills/f-spelled/SKILL.md spells out @someone',
  ]);
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS.md\n## Owner\nNobody.\n');
  assert.ok(problems(root).includes('AGENTS.md has no "Owner" section with exactly one `@<login>`'));
});
