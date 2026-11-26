# GitHub repository

**Covers**: scanning a GitHub repository at a commit and at its default branch; the result, its links to GitHub
pinned to the commit; the scan stored, in **Scanned before**, and not scanned again. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`, live GitHub; then its default branch

## Steps
1. Open the server's URL. Type `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85`
   in the box, then press **Scan**.
   - See: while it scans, "Scanning https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85…",
     a moving bar without a count, and **Stop**. Then the heading "JetBrains/koog · 2 skills", and "at 709079e4a34d" beside it;
     the bar and **Stop** are gone.
2. Read the skills.
   - See: "add-java-code-snippets-in-docs", its whole description, starting with "Use when the user asks to add Java tabs"
     and ending with "and JVM factory classes."; then "split-jvm-nonjvm", starting with "Splits a class or several classes".
     No "Warnings".
3. Look at the links.
   - See: under each skill, a link to
     `https://github.com/JetBrains/koog/blob/709079e4a34d6c9234583352550e6a2b88a0bb85/.claude/skills/<its name>/SKILL.md`.
     The heading "JetBrains/koog" is a link to `https://github.com/JetBrains/koog`.
4. Look under the box, above the result.
   - See: **Scanned before**, open, with one row: "JetBrains/koog at 709079e4a34d · 709079e4a34d6c9234583352550e6a2b88a0bb85 · 2 skills ·"
     and when, today. It is *marked*: the scan on the page.
5. Press **Scan** again, the box unchanged.
   - See: the same result, "JetBrains/koog · 2 skills" at "709079e4a34d". **Scanned before** still has one row, its time unchanged:
     the same commit is not scanned again.
6. Replace the box with `https://github.com/JetBrains/koog`, then press **Scan**.
   - See: the heading "JetBrains/koog · <n> skills", at another commit: the default branch's, today. **Scanned before** has two rows;
     the new one first, reading "<its default branch> (default branch)" (`develop` today), is the one *marked*; the row of step 4 is not any more.
