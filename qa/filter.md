# Filter

**Covers**: the filter on a scan's skills: every word, in any case, in the name or the description;
none matching; a new scan clears it. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `./fixture`, from the checkout; nothing from GitHub

## Steps
1. Open the server's URL with `/?repo=./fixture` after it.
   - See: the box holds `./fixture`; the heading "fixture · 5 skills"; under it a box, "Filter by name or description", empty.
2. Type `release` in the filter.
   - See: two skills, both "release-checklist". The heading still reads "fixture · 5 skills".
3. Replace the filter with `STEPS Release`.
   - See: one skill, "release-checklist", reading "Steps before a release.": both words, in any case.
4. Replace the filter with `commit messages`.
   - See: one skill, "commits": the words are in its description, not its name.
5. Replace the filter with `gradle commits`.
   - See: no skill, and "No skill matches the filter.": no skill has both words.
6. Empty the filter.
   - See: all five skills again; "No skill matches the filter." is gone.
7. Type `gradle` in the filter, then press **Scan**.
   - See: the filter empty again, and all five skills.
