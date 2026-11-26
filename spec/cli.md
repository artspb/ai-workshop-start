# Command line
`./skill-atlas scan <GitHub URL | directory>`, the URL with an optional `/tree/<ref>`, or of an [organization](analysis.md#organization)
Prints the result **at once**; a GitHub scan is stored, and the same commit is not scanned again: see [persistence](analysis.md#persistence).
`GITHUB_TOKEN`, optional: a higher GitHub rate limit.
## Output
```
JetBrains/kotlin · 6 skills
build-tools-bump-gradle-api — Bumps the Gradle API…
  https://github.com/JetBrains/kotlin/blob/<commit>/…
```
- Sorted by **name**, then by path; the description's *first sentence*, or the name alone without one
- `also in <paths>` for copies, comma-separated; warnings go to *stderr*
## Organization
```
JetBrains · 12 repositories · 7 skills

JetBrains/kotlin · 6 skills
build-tools-bump-gradle-api — Bumps the Gradle API…
  https://github.com/JetBrains/kotlin/blob/<commit>/…
```
- The owner, how many repositories it has and how many skills they hold; then each repository *with skills*, as `scan` prints it, an empty line before it
- Repositories sorted by name, case-insensitive; one without skills is only counted
- Warnings on *stderr*, the repository first: `warning: <owner>/<repo>: <warning>`
## End-to-end tests
Real repositories, each at a fixed commit: `tests/e2e/<owner>-<repo>.txt` is what the scan prints, stdout then stderr.
- `npm run e2e` compares; `UPDATE=1 npm run e2e` rewrites the files
- Live GitHub: CI passes its `GITHUB_TOKEN`
## Web view
`./skill-atlas serve [--port <port>]`: the same scan in a browser; see [web.md](web.md).
A port in use or not a number → a clear message, exit code 1.
