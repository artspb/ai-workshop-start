# Web view
`./skill-atlas serve [--port <port>]`: a page on **`http://localhost:4173`**, the same scan as the CLI.
`--port 0` picks a free port. The server prints its URL. It shares the CLI's [stored scans](analysis.md#persistence).
## Architecture
The core runs in the server; the page is a *thin client*: HTML, CSS and plain JavaScript, no framework, no build.
- GitHub repositories and local directories, as `scan`
- `GITHUB_TOKEN` stays in the server: the page never sees it
- Local only: it listens on `127.0.0.1`, and answers only a `localhost`, `127.0.0.1` or `[::1]` host (`403` otherwise)
## The page
- A box for the GitHub URL or the directory, and **Scan**
- The repository, its skill count and the scanned commit; then every skill:
  **name**, the *whole* description, **link**, `also in` for copies; sorted as `scan`
- A link to GitHub opens the file; a local `file://` link is shown as text, with **Copy**: a browser does not open it from a page
- **Warnings**, after the skills
- A **filter**: every word, case-insensitive, in the name or the description
- The address holds the scan: `/?repo=<URL | directory>` scans on open; each scan updates it; *back* scans again
- An error: its message, in place of the result
- **Scanned before**: every [stored scan](analysis.md#persistence), the latest first: the repository, the commit,
  what was asked for (`main (default branch)`, a `/tree/<ref>`), the skill count, the warning count and when;
  only the stored scan on the page is marked, by its id
  - One opens *as stored*, without GitHub: `/?scan=<id>`; the box then holds `<repository URL>/tree/<commit>`
  - Updated after each scan; hidden while nothing is stored
## API
`GET /api/scan?repo=<URL | directory>` → `200` with JSON:
`{ repository, skills: [{ id, name, description, path, commit, copies, link }], warnings, stored }`
- `stored`: the id of the [stored scan](analysis.md#persistence), as `/api/scans` lists it; `null` when not stored (a local directory, code search)
- An error the CLI reports with exit code 1 (no `repo`, unreachable, not found): `400`, `{ error: <message> }`
- Anything else: `500`, `{ error }`; an unknown path: `404`

`GET /api/scans` → `200`, `{ scans: [{ id, repository, ref, skills, warnings, scannedAt }] }`: the stored scans, the latest first;
`skills` and `warnings` are counts, `scannedAt` an ISO 8601 time

`GET /api/scans/<id>` → `200`, the stored result, as `/api/scan` answers it, `stored` being `<id>`; no such scan: `404`, `{ error }`
