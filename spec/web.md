# Web view
`./skill-atlas serve [--port <port>]`: a page on **`http://localhost:4173`**, the same scan as the CLI.
`--port 0` picks a free port. The server prints its URL. It shares the CLI's [stored scans](analysis.md#persistence).
## Architecture
The core runs in the server; the page is a *thin client*: HTML, CSS and plain JavaScript, no framework, no build.
- GitHub repositories, local directories and [organizations](analysis.md#organization), as `scan`
- `GITHUB_TOKEN` stays in the server: the page never sees it
- Local only: it listens on `127.0.0.1`, and answers only a `localhost`, `127.0.0.1` or `[::1]` host (`403` otherwise)
## The page
- A box for the GitHub URL or the directory, and **Scan**
- While a scan runs: what it scans, a progress bar, and **Stop**
  - An organization: `<n> of <N> repositories` scanned, the bar filling as each one ends, scanned or skipped;
    one repository: the bar runs, without a count
  - **Stop** aborts the scan, as another scan does: the server asks GitHub for no repository not started yet.
    The status says so, with how far it got; the address stays, the result is not shown;
    the repositories scanned are stored scans of their own, in **Scanned before**
- The repository, its skill count and the scanned commit; then every skill:
  **name**, the *whole* description, **link**, `also in` for copies; sorted as `scan`
- A link to GitHub opens the file; a local `file://` link is shown as text, with **Copy**: a browser does not open it from a page
- An **organization**: the owner, how many repositories it has and how many skills they hold;
  then each repository *with skills*, as one repository is shown, sorted as `scan`; one without skills is only counted
  - The filter applies to every repository; a repository with no skill it matches is hidden;
    a repository's heading keeps its whole skill count
  - Warnings: each with its repository first, `<owner>/<repo>: <warning>`
  - In **Scanned before**, each repository is a stored scan of its own; none is marked: the page holds many
- **Warnings**, after the skills
- A **filter**: every word, case-insensitive, in the name or the description
- The address holds the scan: `/?repo=<URL | directory | organization URL>` scans on open; each scan updates it; *back* scans again
- An error: its message, in place of the result
  - The [rate limit](analysis.md#rate-limit) with a reset time: in the *viewer's* local time and format,
    `GitHub rate limit reached; it resets at 14:32 (in 20 minutes)`; without `GITHUB_TOKEN`,
    `GitHub rate limit reached; set GITHUB_TOKEN, or wait: it resets at 14:32 (in 20 minutes)`; none: the message
- **Scanned before**: every [stored scan](analysis.md#persistence), the latest first: the repository, the commit,
  every ref asked for (`main (default branch)`, a `/tree/<ref>`), the skill count, the warning count and when;
  only the stored scan on the page is marked, by its id
  - Under the box and the status, before the progress bar and the result; it collapses on its title: open at first,
    then as the user leaves it, across scans
  - One opens *as stored*, without GitHub: `/?scan=<id>`; the box then holds `<repository URL>/tree/<commit>`
  - Updated after each scan; hidden while nothing is stored
- **Search** every stored scan, in **Scanned before**, above its list: the CLI does not
  - Every word, case-insensitive, in a skill's name, its description or its repository, `<owner>/<repo>`:
    `junie-slack` finds every skill of `JetBrains/junie-slack-bot-youtrack`; a word does not span two of them;
    no word, no search: the list shows
  - Each repository once, from its latest stored scan, at whichever commit or ref; a skill only in an older scan is not found
  - While it has a word, the results in place of the list: each skill's **name**, first sentence (as `scan` prints it),
    its repository, the commit and every ref asked for, and its pinned **link**; sorted by name, then repository, then path
  - A result's repository opens its scan *as stored*, as a row of **Scanned before** does: `/?scan=<id>`
  - None: `No skill in a stored scan matches.`; searched again after each scan, as the list is updated
  - Searched once the typing pauses, **250 ms** after the last change: one request, not one a keystroke;
    an answer to an older word is not shown. The box emptied: the list, at once
  - The first **50** results, then `and <M> more`: one letter matches about the whole store
  - From the store only, without GitHub: offline too, no rate limit spent
## API
`GET /api/scan?repo=<URL | directory>` → `200` with JSON:
`{ repository, skills: [{ id, name, description, path, commit, copies, link }], warnings, stored }`
- `stored`: the id of the [stored scan](analysis.md#persistence), as `/api/scans` lists it; `null` when not stored (a local directory, a code search not exact for the commit, a store that cannot be written)
- An error the CLI reports with exit code 1 (no `repo`, unreachable, not found): `400`, `{ error: <message> }`
  - The rate limit: `{ error, rateLimit: { resetsAt, token } }`, `error` without the reset time; `resetsAt` an ISO 8601 time,
    `null` when GitHub did not say; `token`: whether the server has `GITHUB_TOKEN`. The page words the time
- Anything else: `500`, `{ error }`; an unknown path: `404`

An organization, `?repo=github.com/<owner>` → `200` with JSON:
`{ organization: { id, url, repositories, skills }, repositories: [<each repository with skills, as above>], warnings }`
- `organization.repositories` and `organization.skills`: counts, as the CLI prints them
- `warnings`: every repository's, `<owner>/<repo>: <warning>`, a repository that cannot be scanned too
- The rate limit, a rejected token, GitHub unreachable, no such owner: `400`, as the CLI's exit code 1
- `&progress`, `?repo=github.com/<owner>&progress`: the answer is **NDJSON**, `application/x-ndjson`, one object a line,
  `200` from the first line: `{ progress: { scanned, repositories } }`, `scanned` 0 first, then one more as each repository ends;
  the last line the answer above, or `{ error }` when the scan fails on the way (the rate limit, a rejected token), `rateLimit` too as above
  - No such owner, an error before the list: answered as without `&progress`; a repository, a directory: JSON, as without it
- The page leaves before the answer (another scan, *back*, a reload, a closed tab): the request closes, and no repository
  not started yet is asked for; the ones started end, nothing is answered. The page aborts its scan before the next one, an empty address too

`GET /api/scans` → `200`, `{ scans: [{ id, repository, refs, skills, warnings, scannedAt }] }`: the stored scans, the latest first;
`skills` and `warnings` are counts, `scannedAt` an ISO 8601 time

`GET /api/scans/<id>` → `200`, the stored result, as `/api/scan` answers it, `stored` being `<id>`; no such scan: `404`, `{ error }`

`GET /api/search?q=<words>` → `200`, `{ results: [{ id, name, sentence, link, repository, refs, scan }], more }`, from the store only:
the skills of each repository's latest stored scan that match, by name, description or repository, sorted as the page shows them
- `results`: the first 50; `more`: how many more match, `0` when none
- `sentence`: the description's first sentence, `''` without one; `refs`: the stored scan's; `scan`: its id, for `/api/scans/<id>`
- No word in `q`, or no store: `{ results: [], more: 0 }`
- Each stored file is read once a search
