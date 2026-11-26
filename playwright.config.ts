// The web view's visual tests, in tests/visual: the page as a user sees it, the same on every Linux machine.
// `npm run e2e` runs them after the CLI's; `npm run e2e:update` accepts new screenshots. See spec/web.md#visual-tests.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Baselines are made on Linux, as CI runs them: another system's fonts and rendering would fail every screenshot.
const updating = process.argv.some((arg) => /^(-u|--update-snapshots)(=|$)/.test(arg));
if (updating && process.platform !== 'linux')
  throw new Error(`Accept new screenshots on Linux, as CI runs them, not on ${process.platform}: see AGENTS.md`);

export default defineConfig({
  testDir: 'tests/visual',
  testMatch: '*.spec.ts',
  globalSetup: './tests/visual/setup.ts',
  // Next to the tests, one file per screenshot, without the platform in its name: there is only Linux.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  // A missing baseline fails, it is not written: only `npm run e2e:update` writes one.
  updateSnapshots: 'none',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  expect: {
    // A changed pixel fails: no tolerance, nothing masked.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', threshold: 0, maxDiffPixels: 0 },
  },
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    video: { mode: 'on', size: { width: 1280, height: 800 } },
    // The browser sees only the fonts shipped with the tests.
    launchOptions: { env: { ...process.env, FONTCONFIG_FILE: fileURLToPath(new URL('tests/visual/fonts/fonts.conf', import.meta.url)) } },
  },
  projects: [{ name: 'chromium' }],
});
