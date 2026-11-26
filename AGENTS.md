# AGENTS.md
## Specs
Read [./spec](spec/) first. Update it with the code.
## Tests
Integration tests for every case in the spec.
## Skills
Each skill is in `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`, byte-identical: [tests/skills.test.ts](tests/skills.test.ts).
## Owner
`@artspb`: a skill that leaves a decision for a person mentions them, as its "Handing over to a person" section says.
Written here only, never in a skill: [tests/handover.test.ts](tests/handover.test.ts).

## Screenshots
The web view's visual tests ([spec](spec/web.md#visual-tests)) compare the page with the screenshots in `tests/visual/`.
- **A change to the page on purpose** fails them until its new screenshots are accepted, by the pull request's author:
  `npm run e2e:update`, **on Linux in the cloud**, never on a Mac (its fonts and rendering differ, CI would fail
  every screenshot). Commit only the changed screenshots, as a commit of their own: `Accept new screenshots: <why>`.
- **A change not meant to change the page** that fails them: a regression, fixed in the code, never accepted.
- **A reviewer** opens each changed screenshot, before and after: it shows the change the issue asked for, and nothing else.
## Environment
[.air/cloud/startup.sh](.air/cloud/startup.sh): Air runs it before an agent's first command. It provides `jq` and `gh`, Node >= 24,
`node_modules` (`npm ci`), and Playwright 1.65.1's Chromium with its system libraries. It ends with a healthcheck.
A skill doesn't install these again, but keeps a one-line fallback for where the script did not run: [tests/startup.test.ts](tests/startup.test.ts).
## Definition of done
- All tests pass locally: `npm test` and `npm run e2e`
- The CI build ([.github/workflows/ci.yml](.github/workflows/ci.yml)) is green

## Commands
- `npm ci`, then `npx playwright install --with-deps chromium`: first, in a fresh checkout
- `npm test`: the tests
- `npm run e2e`: the end-to-end tests, on live GitHub; `UPDATE=1` rewrites `tests/e2e/*.txt`. Set `GITHUB_TOKEN`.
  Then the web view's visual tests: their report, with a video of each, in `playwright-report/` (`npx playwright show-report`)
- `npm run e2e:update`: accepts the web view's new screenshots, on Linux only (see Screenshots)
