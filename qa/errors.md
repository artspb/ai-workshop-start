# Errors

**Covers**: what a user meets when the scan cannot be done: a repository, an owner, a directory or a branch that
does not exist. Each error in place of the result; nothing stored. See [web.md](../spec/web.md#the-page)
and [analysis.md](../spec/analysis.md#details).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `./fixture`; names that do not exist on live GitHub: the repository `JetBrains/no-such-repository`,
  the owner `no--such--owner` (two hyphens in a row: GitHub allows no such name), the branch `no-such-branch` of `JetBrains/koog`

## Steps
1. Open the server's URL with `/?repo=./fixture` after it.
   - See: "fixture · 5 skills".
2. Replace the box with `https://github.com/JetBrains/no-such-repository`, then press **Scan**.
   - See: in the error colour, "Repository not found: https://github.com/JetBrains/no-such-repository", in place of the result:
     no skill is shown, the fixture's neither. No **Scanned before**.
3. Replace the box with `https://github.com/no--such--owner`, then press **Scan**.
   - See: "Organization or user not found: https://github.com/no--such--owner"; no result, no progress count.
4. Replace the box with `./no-such-directory`, then press **Scan**.
   - See: "Not a GitHub URL or a readable directory: ./no-such-directory"; no result.
5. Go *back* in the browser, three times.
   - See: each address scanned again, its error shown again, then "fixture · 5 skills".
6. Replace the box with `https://github.com/JetBrains/koog/tree/no-such-branch`, then press **Scan**.
   - See: "Not found in https://github.com/JetBrains/koog: no-such-branch"; no result, no **Scanned before**.
