# QA scripts

The standard test scripts for the [web view](../spec/web.md), `./skill-atlas serve`: the pass a person would do by hand,
in a browser. The [manual-qa skill](../.agents/skills/manual-qa/SKILL.md) follows them after each merged pull request,
records each one and reports pass or fail. The automated tests check the code; these check the page, as a user sees it.

## Scripts
In this order; [rate-limit](rate-limit.md) last.

| Script | Covers |
| --- | --- |
| [local-directory](local-directory.md) | a local directory: the result, a copy, a local link, a warning, the address |
| [filter](filter.md) | the filter on a scan's skills |
| [github-repository](github-repository.md) | a GitHub repository, at a commit and at its default branch; stored |
| [scanned-before](scanned-before.md) | **Scanned before**: a stored scan opened as stored, collapsing it |
| [search](search.md) | the search across every stored scan |
| [organization](organization.md) | an owner's repositories: the progress, the counts, each a stored scan |
| [stop](stop.md) | **Stop** on an organization's scan |
| [errors](errors.md) | a repository, an owner, a directory or a branch that does not exist |
| [rate-limit](rate-limit.md) | GitHub's rate limit, without `GITHUB_TOKEN` |

## Running a script
Each script, a server of its own, from the checkout, on an **empty store**: the scripts depend on no other.
```sh
export SKILL_ATLAS_CACHE="$(mktemp -d)"     # a temporary store, this script's only
./skill-atlas serve --port 0                # prints its URL; with GITHUB_TOKEN, unless the setup says without
```
Then follow the steps in a browser. Done: stop the server, remove the store.
- **From the checkout**: `./fixture` is the box's way to the [fixture](../fixture/README.md)
- **`GITHUB_TOKEN`** in the server's environment, unless the script's setup says *without*: every GitHub script stays
  well inside its rate limit. The token stays in the server: never in the box, the address, a video or an issue
- **Marked**, a row of **Scanned before**: its name plain, in the colour of the rest of its row, not underlined;
  a row not marked has its name as a link, coloured and underlined
- A step **passes** when the page shows what its *See* says; text in quotes, exactly. A step that cannot be followed
  (no such control, the step unclear) fails, and says so: no other path is tried

## Data
- **`./fixture`**, for everything it can show: 5 skills, one with a copy, one with a warning; never stored
- **`JetBrains/koog` at `709079e4a34d6c9234583352550e6a2b88a0bb85`**, as in [tests/e2e](../tests/e2e/): 2 skills, a fixed commit
- **`octocat`**, an owner of 8 repositories, none with a skill: an organization well inside the rate limit
- **`Kotlin`**, over a hundred repositories: only to be stopped, or to reach the rate limit without a token
- Names GitHub does not have: `JetBrains/no-such-repository`, `no--such--owner`, `koog`'s `no-such-branch`

## Writing a new script
- One file, `qa/<name>.md`, its row in the table above; `rate-limit` stays last
- `# <Title>`; **Covers**: what it covers, with a link to the [spec](../spec/); `## Setup`: the server, the data; `## Steps`
- Steps numbered, one action each, then `- See:` what a tester should see. For a person: the box, a button by its label,
  a link by its text, the address, *back*; no code, no selectors
- Exact text in quotes; what changes from run to run (a time, a default branch's commit, a count GitHub keeps) said in words
- Data from the list above. Something new from GitHub: a small repository at a fixed commit, an owner far inside the rate limit
- Then follow it once with the skill: each step passes, and fails when the page does not do what it says

## What the skill relies on
- This table: the scripts, in order. Each script's `## Setup`: *without `GITHUB_TOKEN`*, or with it
- `## Steps`: numbered, each with its `- See:`. A *while it scans* may pass quickly: what the status said on the way counts
- A browser that may write the clipboard, for **Copy**
- Recordings on the `demos` branch, never on `main`: `qa/<short sha of main>/<script>.gif` and `.mp4`
- A failing script's issue: titled `QA: <script> fails`, label `bug`; one open issue per script, a new failure a comment on it
