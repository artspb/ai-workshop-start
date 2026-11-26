# An automation run has no GITHUB_TOKEN; `gh auth token` gives one for `npm run e2e`
The Delegate to AI run started with `GITHUB_TOKEN` unset, while `gh` was logged in.
`export GITHUB_TOKEN=$(gh auth token)` before `npm run e2e` made the live tests run, and pass.
Its rate limit need not be 5,000: a QA run saw 8,000 (#68), so never assert a quota's limit as fixed text.
**When**: issue-to-pr's section 4, or any skill that runs `npm run e2e` or a QA script with the token
**Evidence**: issue #68's run: `echo ${GITHUB_TOKEN:+set}` printed nothing; after the export, e2e passed
