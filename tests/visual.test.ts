// The visual tests' rules (spec/web.md#visual-tests), checked without a browser: every screenshot has its
// baseline committed next to the tests, at the viewport's size, and no baseline is left over; the page is
// shot the same way on every machine; `npm run e2e` runs them after the CLI's tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import config from '../playwright.config.ts';

const VISUAL = fileURLToPath(new URL('visual/', import.meta.url));
const specs = readdirSync(VISUAL).filter((file) => file.endsWith('.spec.ts'));

/** A PNG's width and height, from its header. */
function size(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('every screenshot has a baseline next to its test, 1280×800, and every baseline a screenshot', () => {
  assert.ok(specs.length > 0, 'no visual tests');
  for (const spec of specs) {
    const names = [...readFileSync(VISUAL + spec, 'utf8').matchAll(/toHaveScreenshot\('([\w-]+\.png)'/g)].map(([, name]) => name);
    assert.ok(names.length > 0, `${spec} takes no screenshot`);
    assert.equal(new Set(names).size, names.length, `${spec} names a screenshot twice`);
    const directory = `${VISUAL}${spec}-snapshots/`;
    const baselines = existsSync(directory) ? readdirSync(directory) : [];
    assert.deepEqual([...baselines].sort(), [...names].sort(), `${spec}: the baselines in ${spec}-snapshots/ are its screenshots`);
    for (const name of baselines) assert.deepEqual(size(readFileSync(directory + name)), { width: 1280, height: 800 }, name);
  }
});

test('the page is shot the same way on every machine: Chromium, one viewport, the shipped fonts, a fixed clock, no tolerance', () => {
  const { use = {}, projects = [], expect = {}, updateSnapshots, snapshotPathTemplate } = config;
  assert.deepEqual(projects.map((project) => project.use?.browserName ?? use.browserName), ['chromium']);
  assert.deepEqual(use.viewport, { width: 1280, height: 800 });
  assert.equal(use.deviceScaleFactor, 1);
  assert.deepEqual([use.locale, use.timezoneId, use.colorScheme, use.reducedMotion], ['en-US', 'UTC', 'light', 'reduce']);
  assert.deepEqual(use.video, { mode: 'on', size: { width: 1280, height: 800 } });
  const fonts = use.launchOptions?.env?.FONTCONFIG_FILE;
  assert.ok(fonts && existsSync(fonts), 'the browser is given the shipped fonts');
  assert.deepEqual(readdirSync(new URL('.', `file://${fonts}`)).filter((file) => file.endsWith('.ttf')).sort(), [
    'DejaVuSans-Bold.ttf', 'DejaVuSans.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSansMono.ttf',
  ]);
  assert.deepEqual(expect.toHaveScreenshot, { animations: 'disabled', caret: 'hide', scale: 'css', threshold: 0, maxDiffPixels: 0 });
  assert.equal(updateSnapshots, 'none', 'a missing baseline fails, it is not written');
  assert.equal(snapshotPathTemplate, '{testDir}/{testFileName}-snapshots/{arg}{ext}');
  // The page's clock: every test's page is fixed at NOW.
  assert.match(readFileSync(`${VISUAL}fixtures.ts`, 'utf8'), /page\.clock\.setFixedTime\(NOW\)/);
});

test('npm run e2e runs the visual tests after the CLI\'s; npm run e2e:update accepts new screenshots', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.e2e, 'node --test tests/e2e/*.test.ts && playwright test');
  assert.equal(scripts['e2e:update'], 'playwright test --update-snapshots=changed');
  const { devDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(devDependencies['@playwright/test'], '1.65.1', '1.49.1 hangs on Node 26');
});

/** `npm run <script> -- --list`, with Node told it runs on `platform`: the config is loaded, no browser starts. */
function list(script: string, platform: string) {
  const preload = join(mkdtempSync(join(tmpdir(), 'platform-')), 'platform.cjs');
  writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, ...args] = script.split(' ');
  return spawnSync(join(root, 'node_modules/.bin', command), [...args, '--list'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
  });
}

test('only npm run e2e:update writes a baseline, and only on Linux: on a Mac it refuses, before any browser starts', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const update = scripts['e2e:update'];
  const refused = list(update, 'darwin');
  assert.notEqual(refused.status, 0, 'e2e:update runs on a Mac');
  assert.match(refused.stderr + refused.stdout, /Accept new screenshots on Linux, as CI runs them, not on darwin: see AGENTS\.md/);
  for (const flag of ['playwright test -u', 'playwright test --update-snapshots', 'playwright test --update-snapshots=all']) {
    assert.notEqual(list(flag, 'darwin').status, 0, `${flag} runs on a Mac`);
  }
  for (const [script, platform] of [[update, 'linux'], ['playwright test', 'darwin']]) {
    const { status, stdout, stderr } = list(script, platform);
    assert.equal(status, 0, `${script} on ${platform}: ${stderr}`);
    assert.match(stdout, /Total: \d+ tests? in/, `${script} on ${platform} lists the visual tests`);
  }
});
