// The web view as a user sees it, screenshot by screenshot: the key moments of its demos, on the fixture and a
// seeded store, GitHub answering from a recording. Each screenshot is a baseline in page.spec.ts-snapshots/;
// `npm run e2e:update` accepts new ones. See spec/web.md#visual-tests.
import { expect, test } from './fixtures.ts';
import { STORED } from './data.ts';

test('the empty page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Skill Atlas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan' })).toBeVisible();
  await expect(page).toHaveScreenshot('empty.png');
});

test('a scanned directory, then the filter applied', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'GitHub URL or directory' }).fill('./fixture');
  await page.getByRole('button', { name: 'Scan' }).click();
  await expect(page.getByRole('heading', { name: 'fixture · 5 skills' })).toBeVisible();
  await expect(page).toHaveScreenshot('directory.png');

  await page.getByRole('searchbox', { name: 'Filter skills' }).fill('release');
  await expect(page.locator('#skills > li')).toHaveCount(2);
  await expect(page).toHaveScreenshot('filter.png');
});

test.describe('with stored scans', () => {
  test.use({ store: { scans: STORED } });

  test('Scanned before, then a stored scan opened', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#scans > li')).toHaveCount(STORED.length);
    await expect(page).toHaveScreenshot('scanned-before.png');

    await page.locator('#scans > li').first().getByRole('link', { name: 'JetBrains/kotlin-tools' }).click();
    await expect(page.getByRole('heading', { name: 'JetBrains/kotlin-tools · 24 skills' })).toBeVisible();
    await expect(page.locator('#scans > li.current')).toHaveCount(1);
    await expect(page).toHaveURL(/\/\?scan=[0-9a-f]{64}$/);
    await expect(page).toHaveScreenshot('stored-scan.png');
  });

  test('the search across stored scans, with "and M more"', async ({ page }) => {
    await page.goto('/');
    // In every repository's name: the 60 skills of the three latest scans, the older scan's not.
    await page.getByRole('searchbox', { name: 'Search every stored scan' }).fill('jetbrains');
    await expect(page.locator('#found > li')).toHaveCount(50);
    await expect(page).toHaveScreenshot('search.png');

    await page.getByText('and 10 more').scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot('search-more.png');
  });
});

test('an error: the rate limit, with when it resets', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'GitHub URL or directory' }).fill('https://github.com/JetBrains/example');
  await page.getByRole('button', { name: 'Scan' }).click();
  // The page's clock is NOW, 12:00 UTC; GitHub's limit resets 20 minutes later.
  await expect(page.getByRole('status')).toHaveText('GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at 12:20 PM (in 20 minutes)');
  await expect(page).toHaveScreenshot('error.png');
});

test('the page is drawn with the fonts shipped with the tests, and nothing else', async ({ page }) => {
  await page.goto('/?repo=./fixture');
  await expect(page.getByRole('heading', { name: 'fixture · 5 skills' })).toBeVisible();
  // Chromium says which font drew each element's text.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const fonts = async (selector: string) => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts.map(({ familyName }) => familyName);
  };
  for (const selector of ['h1', 'header p', 'button[type=submit]', '.skill h3', '.description']) expect(await fonts(selector), selector).toEqual(['DejaVu Sans']);
  for (const selector of ['#commit', '.link code', '#warnings li']) expect(await fonts(selector), selector).toEqual(['DejaVu Sans Mono']);

  // The shipped fonts, not a system's DejaVu: a letter they lack is not drawn, as if it were transparent.
  const letter = page.locator('#probe');
  await page.evaluate(`document.body.insertAdjacentHTML('afterbegin', '<span id="probe" style="font-size: 40px; background: white">Ж</span>')`);
  const drawn = await letter.screenshot();
  await page.evaluate(`document.getElementById('probe').style.color = 'transparent'`);
  expect((await letter.screenshot()).equals(drawn), 'Ж is drawn: the browser sees fonts not shipped with the tests').toBe(true);
});
