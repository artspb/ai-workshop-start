// The rule of #59: `.air/cloud/startup.sh` prepares an Air environment before the agent's first command:
// jq and gh, Node >= 24, node_modules and Playwright's Chromium. It skips what is there, is quiet, fails loudly
// and ends with a healthcheck. The skills don't install these again, but keep a one-line fallback.
// The script runs for real here, on a PATH of stubs for what it would install, so nothing is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = '.air/cloud/startup.sh';
const PINNED = /^PLAYWRIGHT=(\S+)$/m.exec(readFileSync(join(REPOSITORY, SCRIPT), 'utf8'))?.[1];

/** Which binary `name` is on this machine's PATH. */
function which(name: string): string {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  assert.ok(found, `${name} is not on PATH`);
  return found;
}

const stub = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

/** A checkout with the script, and a PATH with real core tools and stubs for what the script installs: no jq yet. */
function environment(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), home = join(root, 'home'), nvm = join(root, 'nvm');
  for (const dir of [repo, bin, home, nvm]) mkdirSync(dir, { recursive: true });
  cpSync(join(REPOSITORY, SCRIPT), join(repo, SCRIPT), { recursive: true });
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  for (const tool of ['bash', 'cat', 'chmod', 'cut', 'dirname', 'env', 'head', 'id', 'ln', 'mkdir', 'mktemp', 'rm', 'sed', 'sha256sum', 'touch'])
    symlinkSync(which(tool), join(bin, tool));
  // node: the real one, unless FAKE_NODE says which major version it is.
  writeFileSync(join(bin, 'node'), `#!/bin/sh
if [ -n "$FAKE_NODE" ] && [ "$1" = -p ] && [ "$2" = 'process.versions.node.split(".")[0]' ]; then echo "$FAKE_NODE"; exit; fi
if [ -n "$FAKE_NODE" ] && [ "$1" = --version ]; then echo "v$FAKE_NODE.0.0"; exit; fi
exec "${process.execPath}" "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  stub(bin, 'sudo', 'exec "$@"');
  // apt-get install jq puts a jq on PATH, as the real one would.
  stub(bin, 'apt-get', `[ "$1" = install ] || exit 0
for p in "$@"; do [ "$p" = jq ] && printf '#!/bin/sh\\necho jq-1.8.1\\n' > "${bin}/jq" && chmod +x "${bin}/jq"; done; exit 0`);
  stub(bin, 'gh', 'echo "gh version 2.104.0"');
  stub(bin, 'npm', '[ "$1" = ci ] && { [ -z "$FAIL_NPM" ] || { echo "npm error: $FAIL_NPM" >&2; exit 1; }; mkdir -p node_modules; }; exit 0');
  stub(bin, 'npx', 'for a in "$@"; do [ "$a" = --version ] && echo "Version ${2#playwright@}"; done; exit 0');
  // nvm's Node 24, which `nvm use` puts first on the script's own PATH, as the real one does.
  const node24 = join(nvm, 'versions/node/v24.0.0/bin'), links = join(root, 'usr-local-bin');
  for (const dir of [node24, links]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(node24, 'node'), `#!/bin/sh
if [ "$1" = -p ] && [ "$2" = 'process.versions.node.split(".")[0]' ]; then echo 24; exit; fi
if [ "$1" = --version ]; then echo v24.0.0; exit; fi
exec "${process.execPath}" "$@"\n`);
  chmodSync(join(node24, 'node'), 0o755);
  for (const tool of ['npm', 'npx']) symlinkSync(join(bin, tool), join(node24, tool));
  writeFileSync(join(nvm, 'nvm.sh'), `nvm() { echo "nvm $*" >> "$CALLS"; [ "$1" = use ] && PATH="${node24}:$PATH"; return 0; }\n`);
  const calls = join(root, 'calls');
  const run = (env: Record<string, string> = {}) => {
    writeFileSync(calls, '');
    const r = spawnSync(join(repo, SCRIPT), { cwd: home, encoding: 'utf8',
      env: { PATH: bin, HOME: home, CALLS: calls, NVM_DIR: nvm, STARTUP_LINK_DIR: links, ...env } });
    return { status: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
  };
  return { repo, bin, links, run };
}

test('a fresh environment gets jq, node_modules, Chromium and its system libraries, then a healthcheck', (t) => {
  const { repo, run } = environment(t);
  const r = run();
  assert.equal(r.status, 0, r.err);
  assert.equal(r.err, '');
  assert.deepEqual(r.calls, [
    'sudo apt-get update -qq',
    'apt-get update -qq',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends jq',
    'apt-get install -y -qq --no-install-recommends jq',
    'npm ci --no-audit --no-fund',
    `npx --yes playwright@${PINNED} install chromium`,
    `npx --yes playwright@${PINNED} install-deps chromium`,
    'gh --version',
    `npx --yes playwright@${PINNED} --version`,
    'npm run typecheck',
  ]);
  assert.ok(existsSync(join(repo, 'node_modules')));
  // Quiet: one line a step, none of the tools' own output.
  assert.equal(r.out, [
    'startup: installed jq',
    'startup: installed node_modules (npm ci)',
    `startup: Chromium of Playwright ${PINNED}`,
    "startup: installed Chromium's system libraries",
    'startup: ok: jq-1.8.1',
    'startup: ok: gh version 2.104.0',
    `startup: ok: ${process.version}`,
    `startup: ok: Version ${PINNED}`,
    'startup: ok: npm run typecheck',
    'startup: ready',
    '',
  ].join('\n'));
});

test('run again, it skips what is there: no apt-get, no npm ci, no system libraries', (t) => {
  const { run } = environment(t);
  assert.equal(run().status, 0);
  const again = run();
  assert.equal(again.status, 0, again.err);
  assert.deepEqual(again.calls, [
    `npx --yes playwright@${PINNED} install chromium`, // downloads nothing when Chromium is there
    'gh --version',
    `npx --yes playwright@${PINNED} --version`,
    'npm run typecheck',
  ]);
});

test('a changed package-lock.json installs node_modules again', (t) => {
  const { repo, run } = environment(t);
  assert.equal(run().status, 0);
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion": 3, "packages": {}}\n');
  assert.ok(run().calls.includes('npm ci --no-audit --no-fund'));
});

test('a repository that depends on Playwright gets the Chromium of its own version', (t) => {
  const { repo, run } = environment(t);
  assert.equal(run().status, 0);
  mkdirSync(join(repo, 'node_modules/playwright-core'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/playwright-core/package.json'), '{"version": "1.70.0"}\n');
  const r = run();
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.includes('npx --yes playwright@1.70.0 install chromium'), r.calls.join('\n'));
  assert.ok(r.calls.includes('npx --yes playwright@1.70.0 install-deps chromium'), 'the libraries of a new version');
  assert.match(r.out, /^startup: ok: Version 1\.70\.0$/m);
});

test('a Node older than 24 gets Node 24 from nvm, in the agent\'s next shell too', (t) => {
  const { bin, links, run } = environment(t);
  const r = run({ FAKE_NODE: '20' });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls.filter((c) => c.startsWith('nvm ')), ['nvm install 24', 'nvm alias default 24', 'nvm use --silent default']);
  assert.match(r.out, /^startup: installed Node 24$/m);
  assert.match(r.out, /^startup: ok: v24\.0\.0$/m);
  // A new shell has no nvm: it gets the image's PATH, where /usr/local/bin comes before the old Node.
  for (const tool of ['node', 'npm', 'npx']) assert.ok(existsSync(join(links, tool)), `${tool} is linked`);
  const next = spawnSync('node', ['--version'], { encoding: 'utf8', env: { PATH: `${links}:${bin}`, FAKE_NODE: '20' } });
  assert.equal(next.stdout, 'v24.0.0\n');
});

test('a Node older than 24 with no nvm fails loudly', (t) => {
  const { run } = environment(t);
  const r = run({ FAKE_NODE: '20', NVM_DIR: '/nonexistent' });
  assert.equal(r.status, 1);
  assert.match(r.err, /^startup: FAILED: Node v20\.0\.0 is older than 24, and there is no nvm to install it$/m);
});

test('a failing step stops the script with a non-zero exit and its output', (t) => {
  const { run } = environment(t);
  const r = run({ FAIL_NPM: 'ETARGET no matching version' });
  assert.equal(r.status, 1);
  assert.equal(r.err, 'startup: FAILED: installed node_modules (npm ci)\nnpm error: ETARGET no matching version\n');
  assert.ok(!r.calls.some((c) => c.includes('playwright')), 'nothing after the failing step');
  assert.ok(!r.out.includes('ready'));
});

test('the script is executable, and its Playwright is the skills\' and the repository\'s', () => {
  accessSync(join(REPOSITORY, SCRIPT), constants.X_OK);
  assert.ok(PINNED, `${SCRIPT} pins PLAYWRIGHT=<version>`);
  for (const name of readdirSync(join(REPOSITORY, '.agents/skills'))) {
    const text = readFileSync(join(REPOSITORY, '.agents/skills', name, 'SKILL.md'), 'utf8');
    for (const [, version] of text.matchAll(/playwright@(\S+)/g)) assert.equal(version, PINNED, `${name} records with Playwright ${version}`);
  }
  const pkg = JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8'));
  for (const deps of [pkg.dependencies, pkg.devDependencies])
    for (const dep of ['playwright', '@playwright/test', 'playwright-core'])
      if (deps?.[dep]) assert.equal(deps[dep].replace(/^[\^~=]/, ''), PINNED, `package.json's ${dep}`);
});

test('a skill installs jq and Chromium only where the script did not run, and AGENTS.md says what it provides', () => {
  for (const name of readdirSync(join(REPOSITORY, '.agents/skills'))) {
    const lines = readFileSync(join(REPOSITORY, '.agents/skills', name, 'SKILL.md'), 'utf8').split('\n');
    for (const line of lines.filter((l) => /apt-get install[^\n]*\bjq\b/.test(l)))
      assert.match(line, /command -v jq \|\| \{ sudo apt-get update && sudo apt-get install -y jq; \}/, `${name}: ${line}`);
    for (const line of lines.filter((l) => /playwright install/.test(l)))
      assert.match(line, /test -x "\$\(node -p "require\('playwright'\)\.chromium\.executablePath\(\)"\)" \|\| npx playwright install --with-deps chromium/, `${name}: ${line}`);
  }
  const agents = readFileSync(join(REPOSITORY, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\[\.air\/cloud\/startup\.sh\]\(\.air\/cloud\/startup\.sh\)/);
  for (const what of ['`jq`', '`gh`', 'Node >= 24', '`node_modules`', 'Chromium']) assert.ok(agents.includes(what), `AGENTS.md names ${what}`);
});

test('a sandbox of a skill, with a new HOME, keeps the browsers\' folder, so it finds the script\'s Chromium', () => {
  const sandboxes = readdirSync(join(REPOSITORY, '.agents/skills')).flatMap((name) =>
    readFileSync(join(REPOSITORY, '.agents/skills', name, 'SKILL.md'), 'utf8').split('\n')
      .filter((l) => /env -i .*HOME="\$\(mktemp -d\)"/.test(l)).map((line) => ({ name, line })));
  assert.ok(sandboxes.length >= 3, 'code-review, address-review and merge-when-reviewed run a pull request in a sandbox');
  for (const { name, line } of sandboxes)
    assert.ok(line.includes('PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" HOME="$(mktemp -d)"'), `${name}: ${line}`);
});
