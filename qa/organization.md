# Organization

**Covers**: scanning every repository of an owner: the progress, its count and its bar; the result's counts;
each repository a stored scan of its own, none marked, not scanned again. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: the owner `octocat`, live GitHub: 8 repositories, none with a skill; well inside the rate limit

## Steps
1. Open the server's URL. Type `https://github.com/octocat` in the box, then press **Scan**.
   - See: while it scans, "Scanning https://github.com/octocat… <k> of 8 repositories", `k` growing up to 8 (it may
     skip a number), a bar filling with it, and **Stop**. It can be quick: a second or two.
2. Wait for the scan to end.
   - See: the heading "octocat · 8 repositories · 0 skills", no commit beside it; no skill, no filter, no "Warnings".
     The bar and **Stop** are gone. The heading "octocat" is a link to `https://github.com/octocat`.
3. Look at **Scanned before**.
   - See: eight rows, one per repository, among them "octocat/Hello-World" and "octocat/Spoon-Knife"; each with its default branch,
     `master`, `main` or `gh-pages`, as a ref of its own, without "(default branch)", and "0 skills". None is *marked*: the page holds many stored scans, not one.
4. Press **Scan** again, the box unchanged.
   - See: the same result, "octocat · 8 repositories · 0 skills". **Scanned before** still has eight rows, their times unchanged:
     the same commits are not scanned again.
5. Press the row "octocat/Hello-World".
   - See: "octocat/Hello-World · 0 skills", at its commit; the box holds `https://github.com/octocat/Hello-World/tree/` and
     that commit. Its row is *marked*, the seven others not.
