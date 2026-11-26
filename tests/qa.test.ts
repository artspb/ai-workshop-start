// The QA scripts in qa/, as the manual-qa skill relies on them (qa/README.md#what-the-skill-relies-on):
// the README's table lists every script, rate-limit last; each script has its sections, and every step its "See".
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const QA = fileURLToPath(new URL('../qa/', import.meta.url));
const read = (file: string) => readFileSync(QA + file, 'utf8');
const scripts = readdirSync(QA).filter((file) => file.endsWith('.md') && file !== 'README.md');

test('qa/README.md lists every script once, rate-limit last', () => {
  const listed = [...read('README.md').matchAll(/^\| \[([\w-]+)\]\(([\w-]+)\.md\) \|/gm)].map(([, name, file]) => {
    assert.equal(name, file, `the row of ${file}.md names it`);
    return `${file}.md`;
  });
  assert.deepEqual([...listed].sort(), [...scripts].sort());
  assert.equal(listed.at(-1), 'rate-limit.md');
});

for (const script of scripts) {
  test(`qa/${script}: Covers, Setup, then numbered steps, each with what a tester should see`, () => {
    const text = read(script);
    assert.match(text, /^# .+\n\n\*\*Covers\*\*: /);
    assert.match(text, /\n## Setup\n- The server, as in \[the README\]\(README\.md#running-a-script\): an empty store, (with|\*\*without) `GITHUB_TOKEN`/);
    const steps = text.split('\n## Steps\n')[1];
    assert.ok(steps, 'a Steps section, last');
    const numbered = steps.split(/^(?=\d+\. )/m).filter((part) => part.trim());
    assert.ok(numbered.length > 0, 'at least one step');
    numbered.forEach((part, index) => {
      assert.match(part, new RegExp(`^${index + 1}\\. \\S`), `step ${index + 1} is numbered in order`);
      assert.match(part, /\n {3,4}- See: \S/, `step ${index + 1} says what a tester should see`);
    });
  });
}

// A quota's limit is the token's, kept by GitHub (5,000 for a person's token, more or fewer for others:
// GitHub Actions' own gets 1,000):
// said in words, never quoted as text the page must show (qa/README.md#writing-a-new-script).
for (const script of scripts) {
  test(`qa/${script}: quotes no quota's limit, says it in words`, () => {
    const quoted = [...read(script).matchAll(/"([^"\n]*)"/g)].map(([, text]) => text);
    for (const text of quoted) assert.doesNotMatch(text, /\bof [\d,]+ (points )?left\b/, `"${text}" quotes a limit GitHub keeps`);
  });
}

// An example limit is never a floor: a token can get fewer than 5,000 (GitHub Actions' own gets 1,000 an hour).
for (const file of [...scripts.map((script) => `qa/${script}`), 'spec/web.md']) {
  test(`${file}: a limit of 5,000 is an example, the limit can be more or fewer`, () => {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    for (const [said] of text.matchAll(/\([^()\n]*5,000 for [^()\n]*\)/g))
      assert.match(said, /\bfewer\b/, `${said} reads as a floor of 5,000`);
  });
}
