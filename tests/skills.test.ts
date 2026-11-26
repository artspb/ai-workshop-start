// The rule in AGENTS.md#skills: each skill of this repository has two copies, `.agents/skills/<name>/SKILL.md`
// and `.claude/skills/<name>/SKILL.md`, with the same bytes; a copy edited on one side only fails here.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['.agents/skills', '.claude/skills'] as const;

/** The skills under `root`/`dir`: its directories with a `SKILL.md`. */
function skills(root: string, dir: string): string[] {
  return existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((name) => existsSync(join(root, dir, name, 'SKILL.md'))) : [];
}

/** Each skill under `root` whose copy under the other root is missing or has other bytes, as a message. */
function drift(root: string): string[] {
  const problems: string[] = [];
  for (const [from, to] of [ROOTS, [...ROOTS].reverse()]) {
    for (const name of skills(root, from)) {
      const copy = join(root, to, name, 'SKILL.md');
      if (!existsSync(copy)) problems.push(`${from}/${name}/SKILL.md has no copy in ${to}/${name}/SKILL.md`);
      else if (from === ROOTS[0] && !readFileSync(join(root, from, name, 'SKILL.md')).equals(readFileSync(copy)))
        problems.push(`${from}/${name}/SKILL.md and ${to}/${name}/SKILL.md differ`);
    }
  }
  return problems;
}

test('each skill of this repository has the same bytes in .agents/skills and .claude/skills', () => {
  // The skills `drift` compares, not the entries of the roots: a `.gitkeep` or a `README.md` left there is no skill.
  assert.ok(ROOTS.some((dir) => skills(REPOSITORY, dir).length > 0), 'no skills to compare');
  assert.deepEqual(drift(REPOSITORY), []);
});

test('a copy edited on one side, or on one side only, is drift', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skill-copies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = (dir: string, name: string, body: string) => {
    mkdirSync(join(root, dir, name), { recursive: true });
    writeFileSync(join(root, dir, name, 'SKILL.md'), body);
  };
  skill('.agents/skills', 'same', '---\nname: same\n---\n');
  skill('.claude/skills', 'same', '---\nname: same\n---\n');
  skill('.agents/skills', 'edited', '---\nname: edited\n---\n');
  skill('.claude/skills', 'edited', '---\nname: edited\n---\r\n'); // one byte apart
  skill('.agents/skills', 'agents-only', '---\nname: agents-only\n---\n');
  skill('.claude/skills', 'claude-only', '---\nname: claude-only\n---\n');
  assert.deepEqual(drift(root).sort(), [
    '.agents/skills/agents-only/SKILL.md has no copy in .claude/skills/agents-only/SKILL.md',
    '.agents/skills/edited/SKILL.md and .claude/skills/edited/SKILL.md differ',
    '.claude/skills/claude-only/SKILL.md has no copy in .agents/skills/claude-only/SKILL.md',
  ]);
});

test('a root with no SKILL.md has no skills to compare, whatever else it holds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skill-copies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ROOTS) {
    mkdirSync(join(root, dir, 'renamed'), { recursive: true });
    writeFileSync(join(root, dir, '.gitkeep'), '');
    writeFileSync(join(root, dir, 'README.md'), 'moved\n');
    writeFileSync(join(root, dir, 'renamed', 'skill.md'), dir);
  }
  for (const dir of ROOTS) assert.deepEqual(skills(root, dir), []);
});
