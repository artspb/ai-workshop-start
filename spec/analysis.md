# Repository analysis
## Input
A **GitHub repository** URL, or a local directory
- `github.com/<owner>/<repo>`: the default branch
- `github.com/<owner>/<repo>/tree/<ref>`: a commit, a branch or a tag; one path segment
- `github.com/<owner>`: an organization or a user, every repository of it; see [organization](#organization)
## Output
Every *project skill*: **name**, **description**, **link**
## What a project skill is
A skill an agent *working in the repository* loads by itself:
a regular file named exactly `SKILL.md` at **`<root>/<name>/SKILL.md`**.
- Skill roots: `.agents/skills`, `.claude/skills`, `.github/skills`, `agent/skills`
- A root counts at the repository root *or in any directory*: a nested project's skills are skills
- Not a project skill:
  - a `SKILL.md` outside a root: the repository root, `docs/`, a skill library `skills/<name>/`, a plugin's `plugins/<p>/skills/<name>/`
  - `<root>/SKILL.md`: no skill directory
  - deeper, `<root>/<name>/<dir>/SKILL.md`: a file of skill `<name>`, not a skill
  - another case: `skill.md`, `Skill.md`
  - a symbolic link, to a file or a directory: its target counts where it is
  - anything under `.git` or `node_modules`
- **Copies**: the same `<name>` and the *same bytes* in more than one place are **one skill**.
  Its path is the first by path; the others are its copies, and share its warnings.
  The same `<name>` with different bytes: *two skills*.
## Organization
`github.com/<owner>`: every repository GitHub lists for the owner, each one scanned as `scan` does
- An organization: every repository the scan can see; with `GITHUB_TOKEN`, its private ones too.
  A user: the repositories they own, the public ones
- Forks and archived repositories too: they are the owner's repositories
- Each repository: its default branch, as `/tree/<default branch>`, so listed through its tree:
  code search allows 10 requests a minute, too few for an organization
- Each repository is a scan of its own: [stored](#persistence) as one, not scanned again at the same commit;
  the list of repositories is asked for every time
- A repository that cannot be scanned (an empty one, a branch gone since the list) → a *warning*, the others go on
- No such owner → a clear message, exit code 1; the rate limit, a rejected token, GitHub unreachable: the scan stops, exit code 1,
  on any request, a file read too
- With `GITHUB_TOKEN`, every request carries it, a file read too: a private repository's files answer only with it
  - A file that answers 404 with the token: the token is checked (`/rate_limit`, no request of the limit); rejected → the scan stops,
    not "not found": the file host answers 404, not 401, for a token it does not accept
- 8 repositories at a time
## Rate limit
GitHub refuses a request for the rate limit: `403` or `429` saying *rate limit*, or `429` on a file read. The scan stops,
an organization's too, exit code 1, and the error tells **when the limit resets**, if GitHub said so:
- A secondary limit: `retry-after`, seconds from the answer
- Else the primary limit: `x-ratelimit-reset`, Unix seconds; not when `x-ratelimit-remaining` is there and not `0`:
  that limit is not the one reached
- Neither, or a value out of a date's range: no reset time, none guessed
- The message without a reset time: `GitHub rate limit reached; try again later`; without `GITHUB_TOKEN`,
  `GitHub rate limit reached; set GITHUB_TOKEN`. Each client words the reset time: the [CLI](cli.md#rate-limit), the [web view](web.md#the-page)
- A reset time is shown rounded *up* to the minute, `in <n> minutes` rounded up too, at least 1: trying at the time shown works
  - A reset time already past (a clock ahead of GitHub's): the next minute, `in 1 minute`; never a time behind the clock
## Persistence
A GitHub scan listed through its **tree** is **stored**, with `GITHUB_TOKEN` or without; the same repository at the same commit is not scanned again.
- The key: the repository, the **resolved commit**, and how it was listed; a branch that moved is a new commit, a new scan
  - A tree in **one answer** lists the same for every ref, with `GITHUB_TOKEN` or without: **one stored scan**
  - A tree **too large**: the roots, stored apart for a `/tree/<ref>` and for the default branch (the warning is worded for each);
    with `GITHUB_TOKEN`, the default branch uses code search instead, never served the roots
  - A scan an earlier version stored, for a `/tree/<ref>` or for the default branch without `GITHUB_TOKEN`, is found again:
    of a tree in one answer, it is the one stored scan, for every ref, with `GITHUB_TOKEN` or without; of the roots, only for its own kind
- A **code search** scan is stored only when its list is *exact for the commit*: the index follows the default branch late
  - Each result names the commit the index reflects: the `?ref=` of its `url`
  - **Index current**: every result on every page names the resolved commit, no page has `incomplete_results`, at most 1000 results → stored
  - **Index behind**: every result names one commit, an ancestor of the head: the compare to the head (`status: ahead`) catches it up → stored
  - Else **not stored**, and the next scan may find more: no result, results naming different commits, `incomplete_results`,
    more than 1000 results, fewer paths than `total_count` (a repeated result pushed another out, or a page came short),
    a compare that fails (404: GitHub no longer has the index commit; any other error answer), a compare not `ahead`,
    a compare of 300 files or more (it may not list them all), a `SKILL.md` changed otherwise
  - Its own key, not the whole tree's: the index may skip a file the tree has (a large one); served only to code search
- Each stored scan records **every ref asked for**, in order: `<branch> (default branch)`, the `<ref>` of `/tree/<ref>`;
  two refs at the same commit share one stored scan, scanned once; refs scanned at the same time in one process are all kept
  (two processes at the same time may keep only one)
- Resolving the ref still asks GitHub; listing and reading the files does not
- Stored: the whole result, warnings included; a failed scan is not stored
- A local directory is never stored: its files change without a commit; a scan not stored is scanned every time
- Each stored scan records **when** it was scanned; nothing removes it
- On disk, one file per scan: `SKILL_ATLAS_CACHE`, else `$XDG_CACHE_HOME/skill-atlas`, else `~/.cache/skill-atlas`; shared by `scan` and `serve`
- The store never fails a scan: an unreadable or corrupt file → scanned again; an unwritable directory → not stored
## Architecture
Core: fetch → find → parse, then the store. CLI: a *thin client*.
Skill: id = `repo:path`, name, description, commit, copies
## Details
- **GitHub API**, no clone; *under 5 s* for intellij-community
- Every scan asks for the **tree** first. A tree too large for one answer: only the roots at the repository root, and a *warning*;
  with `GITHUB_TOKEN`, on the default branch, code search finds every root, after the tree's answer
- Code search sees only the default branch: a `/tree/<ref>` scan always lists the tree
- **Catch-up**: an index behind the head, every result naming one commit, an ancestor: `compare/<index>...<head>`;
  its `SKILL.md` files `added` (or `copied`) are added, `removed` dropped, `renamed` moved; a skill added since the index commit is found.
  Stored or not: an incomplete search is caught up too. One extra request, only when the index lags.
  A compare that fails → the search list as it is, the scan goes on; only GitHub answering no more requests
  (rate limit, rejected token, unreachable) stops it
- The name: front matter, else the directory
- The link pins the *scanned commit*; for a local directory, the file itself
- Malformed or missing front matter → a *warning*, the scan goes on
- Listed, but gone at the scanned commit → a *warning*, skipped
- Unreachable repository → a clear message, exit code 1
