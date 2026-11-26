# Repository analysis
## Input
A **GitHub repository** URL, or a local directory
- `github.com/<owner>/<repo>`: the default branch
- `github.com/<owner>/<repo>/tree/<ref>`: a commit, a branch or a tag; one path segment
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
## Persistence
A GitHub scan is **stored**; the same repository at the same commit is not scanned again.
- The key: the repository, the **resolved commit**, and how it was listed (code search, its tree); a branch that moved is a new commit, a new scan
- Resolving the ref still asks GitHub; listing and reading the files does not
- Stored: the whole result, warnings included; a failed scan is not stored
- A local directory is never stored: its files change without a commit
- Each stored scan records **when** it was scanned; nothing removes it
- On disk, one file per scan: `SKILL_ATLAS_CACHE`, else `$XDG_CACHE_HOME/skill-atlas`, else `~/.cache/skill-atlas`; shared by `scan` and `serve`
- The store never fails a scan: an unreadable or corrupt file → scanned again; an unwritable directory → not stored
## Architecture
Core: fetch → find → parse, then the store. CLI: a *thin client*.
Skill: id = `repo:path`, name, description, commit, copies
## Details
- **GitHub API**, no clone; *under 5 s* for intellij-community
- A tree too large for one answer: only the roots at the repository root, and a *warning*; with `GITHUB_TOKEN`, code search finds every root
- Code search sees only the default branch: a `/tree/<ref>` scan always lists the tree
- The name: front matter, else the directory
- The link pins the *scanned commit*; for a local directory, the file itself
- Malformed or missing front matter → a *warning*, the scan goes on
- Listed, but gone at the scanned commit → a *warning*, skipped
- Unreachable repository → a clear message, exit code 1
