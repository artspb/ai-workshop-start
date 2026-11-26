# Search

**Covers**: the search across every stored scan, in **Scanned before**: its results, none, a result opening its scan,
and the search again after a scan. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `JetBrains/koog` at commit `709079e4a34d6c9234583352550e6a2b88a0bb85`, live GitHub, once; `./fixture`

## Steps
1. Open the server's URL with `/?repo=https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85` after it.
   - See: "JetBrains/koog · 2 skills"; **Scanned before**, with one row, and above it a box,
     "Search every stored scan by name or description", empty.
2. Type `mkdocs` in the search box.
   - See: in place of the row, one result: "add-java-code-snippets-in-docs"; only its first sentence, ending with
     "Knit INCLUDE+SUFFIX blocks)."; "JetBrains/koog at 709079e4a34d · 709079e4a34d6c9234583352550e6a2b88a0bb85";
     and its link, `https://github.com/JetBrains/koog/blob/709079e4a34d6c9234583352550e6a2b88a0bb85/.claude/skills/add-java-code-snippets-in-docs/SKILL.md`.
3. Replace the search with `JAVA backend`.
   - See: one result, "split-jvm-nonjvm", its first sentence, starting with "Splits a class": every word, in any case;
     the other skill has "Java", not "backend".
4. Replace the search with `commits`.
   - See: no result, and "No skill in a stored scan matches.": a local directory is not stored, so `./fixture` is not searched.
5. Empty the search.
   - See: the row "JetBrains/koog" again, and no result.
6. Type `kotlin` in the search box, then replace the box with `./fixture` and press **Scan**.
   - See: "fixture · 5 skills"; the search still holds `kotlin`, with two results, sorted by name:
     "add-java-code-snippets-in-docs", then "split-jvm-nonjvm".
7. Press the repository of the first result, "JetBrains/koog".
   - See: "JetBrains/koog · 2 skills" at "709079e4a34d", opened as stored; the box holds
     `https://github.com/JetBrains/koog/tree/709079e4a34d6c9234583352550e6a2b88a0bb85`; the address ends with `/?scan=` and its id.
