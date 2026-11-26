# Repository analysis
## Input
A **GitHub repository** URL, or a local directory
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
## Architecture
Core: fetch → find → parse. CLI: a *thin client*.
Skill: id = `repo:path`, name, description, commit, copies
## Details
- **GitHub API**, no clone; *under 5 s* for intellij-community
- A tree too large for one answer: only the roots at the repository root, and a *warning*; with `GITHUB_TOKEN`, code search finds every root
- The name: front matter, else the directory
- The link pins the *scanned commit*; for a local directory, the file itself
- Malformed or missing front matter → a *warning*, the scan goes on
- Listed, but gone at the scanned commit → a *warning*, skipped
- Unreachable repository → a clear message, exit code 1
