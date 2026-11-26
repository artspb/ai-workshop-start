# Skill Atlas

Every project skill in a repository: `./skill-atlas scan` finds each one ([what counts](spec/analysis.md#what-a-project-skill-is)) and prints its name,
description and link.

```console
$ npm ci
$ ./skill-atlas scan https://github.com/JetBrains/kotlin
JetBrains/kotlin · 6 skills
…
build-tools-bump-gradle-api — Bumps the Gradle API version that Kotlin Gradle plugins are compiled against in the Kotlin compiler repository.
  https://github.com/JetBrains/kotlin/blob/5ab6270ab772d113e8ad52ebfcaa0109c522ae00/.claude/skills/build-tools-bump-gradle-api/SKILL.md
…
```

Add `/tree/<commit>` to scan a commit, a branch or a tag. `./skill-atlas serve` shows the same in a browser, on
http://localhost:4173 ([web view](spec/web.md)); `--port` picks another port. Set `GITHUB_TOKEN` for a higher GitHub rate limit.
`npm test` runs the tests; `npm run e2e` scans real repositories at fixed commits and compares with
[tests/e2e/](tests/e2e/), then the web view's screenshots with [tests/visual/](tests/visual/) ([visual tests](spec/web.md#visual-tests)).

- [spec/](spec/): what it does. [AGENTS.md](AGENTS.md): the definition of done.
- [fixture/](fixture/README.md): a small repository for the tests.
- [qa/](qa/README.md): the web view's test scripts, for a person or the `manual-qa` skill, in a browser.
