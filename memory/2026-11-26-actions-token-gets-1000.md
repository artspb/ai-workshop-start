# The token CI's e2e runs with gets 1,000 REST requests an hour, not 5,000 or more
`.github/workflows/ci.yml` gives `npm run e2e` GitHub Actions' own `GITHUB_TOKEN`: 1,000 an hour per repository,
while an Air run's `gh auth token` reports 8,000 and a person's 5,000. A limit written as "5,000, more for some" reads
as a floor and is wrong for CI; `tests/qa.test.ts` now asks an example of 5,000 in qa/ and spec/web.md to say "fewer" too.
**When**: writing the spec, a QA script or a test about the REST quota, or a CI e2e that spends many requests
**Evidence**: pull request #69's review; GitHub's REST rate-limit docs; `x-ratelimit-limit: 8000` for the Air run's token
