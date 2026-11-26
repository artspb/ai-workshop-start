# Local directory

**Covers**: scanning a local directory from the box; the address holding the scan, a reload and *back*;
every skill with its whole description, a copy, a local link to copy, a warning. See [web.md](../spec/web.md#the-page).

## Setup
- The server, as in [the README](README.md#running-a-script): an empty store, with `GITHUB_TOKEN`
- Data: `./fixture`, from the checkout; nothing from GitHub

## Steps
1. Open the server's URL.
   - See: the title "Skill Atlas"; an empty box, "GitHub URL or directory"; a **Scan** button.
     No result, no **Scanned before**, no **Stop**.
2. Type `./fixture` in the box, then press **Scan**.
   - See: the heading "fixture · 5 skills", and "local directory" beside it. The address ends with `/?repo=.%2Ffixture`.
     **Stop** is hidden again.
3. Read the skills, top to bottom.
   - See: five skills, in this order: "code-style", "commits", "gradle-bump", "release-checklist", "release-checklist".
     The first "release-checklist" has no description; the second reads "Steps before a release."
4. Look at "commits".
   - See: "Write commit messages the way this repository does."; its link as text, not a link, ending with
     `/fixture/.agents/skills/commits/SKILL.md`, and a **Copy** button beside it;
     then "also in .claude/skills/commits/SKILL.md".
5. Press **Copy** beside the link of "commits".
   - See: the button reads "Copied", then "Copy" again after a moment.
6. Look below the skills.
   - See: "Warnings", with one warning, starting with ".agents/skills/release-checklist/SKILL.md: malformed front matter"
     and ending with "using the directory name".
7. Look at the heading "fixture".
   - See: it is not a link: pressing it opens nothing, the address stays. A browser does not open a local folder from a page.
8. Reload the page.
   - See: the same result again, "fixture · 5 skills"; the box holds `./fixture`.
     Still no **Scanned before**: a local directory is never stored.
9. Go *back* in the browser.
   - See: the box empty, no result: the page as in step 1.
10. Go *forward* in the browser.
    - See: "fixture · 5 skills" again; the box holds `./fixture`.
