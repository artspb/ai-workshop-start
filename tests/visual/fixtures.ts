// The visual tests' page: a server of its own for each test (serve.ts), on an empty store or one seeded with
// `store.scans`; the page's clock fixed at NOW. See spec/web.md#visual-tests.
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { NOW, WORKDIR, type Seed } from './data.ts';

const SERVE = fileURLToPath(new URL('serve.ts', import.meta.url));

// An object, not the array: `test.use` takes an array as a value and its options.
export const test = base.extend<{ store: { scans: Seed[] }; server: string }>({
  store: [{ scans: [] }, { option: true }],
  server: async ({ store }, use) => {
    const directory = mkdtempSync(join(tmpdir(), 'skill-atlas-visual-'));
    writeFileSync(join(directory, 'seed.json'), JSON.stringify(store.scans));
    const env: NodeJS.ProcessEnv = { ...process.env, SKILL_ATLAS_CACHE: join(directory, 'store') };
    delete env.GITHUB_TOKEN;
    // From WORKDIR, where the global setup copied the fixture: the box's `./fixture` is that copy.
    const server = spawn(process.execPath, [SERVE, join(directory, 'seed.json')], { cwd: WORKDIR, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => server.once('exit', resolve));
    try {
      const [url] = await Promise.race([
        createInterface({ input: server.stdout })[Symbol.asyncIterator]().next().then(({ value }) => [value as string | undefined]),
        exited.then((code) => Promise.reject(new Error(`serve.ts exited with ${code}`))),
      ]);
      if (!url) throw new Error('serve.ts printed no URL');
      await use(url);
    } finally {
      server.kill();
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  // `page.goto('/?repo=…')` goes to this test's server.
  baseURL: async ({ server }, use) => use(server),
  page: async ({ page }, use) => {
    await page.clock.setFixedTime(NOW);
    await use(page);
  },
});

export { expect };
