// End-to-end: the real CLI on real GitHub repositories, each at a fixed commit, compared with
// what it printed before, stdout then stderr, in tests/e2e/<owner>-<repo>.txt.
// `UPDATE=1 npm run e2e` rewrites the files. Live GitHub: set GITHUB_TOKEN for its rate limit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLI } from '../helpers.ts';

const REPOSITORIES = [
  // A tree too large for one answer; every skill in .agents/skills with a copy in .claude/skills;
  // plugin skills, not project skills.
  'github.com/JetBrains/MPS/tree/1cbf7f783dbc5c74c8e5231d31f61b02829143de',
  // A tree too large for one answer; only a skill.md, in lower case: no project skills.
  'github.com/JetBrains/android/tree/294d4c098cb833f7a457cd891a125de82d4e1715',
  // A tree in one answer; skills in test resources, not project skills.
  'github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85',
];

const run = promisify(execFile);

// The repositories at the same time: each scan waits on GitHub.
describe('real repositories', { concurrency: true }, () => {
  for (const url of REPOSITORIES) {
    const [, owner, repo] = url.split('/');
    const expected = new URL(`${owner}-${repo}.txt`, import.meta.url);

    test(`skill-atlas scan ${url}`, async () => {
      const { stdout, stderr } = await run(process.execPath, [CLI, 'scan', url]).catch((error) => {
        assert.fail(`exit code ${error.code}: ${error.stderr}`);
      });
      const printed = stdout + stderr;
      if (process.env.UPDATE) writeFileSync(expected, printed);
      assert.equal(printed, readFileSync(fileURLToPath(expected), 'utf8'));
    });
  }
});
