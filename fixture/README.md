# fixture

A small repository for the tests: one case of [what a project skill is](../spec/analysis.md) per path.

| Path | Case |
| --- | --- |
| `.claude/skills/commits` | a skill |
| `.agents/skills/commits` | its copy: the same name, the same bytes |
| `.github/skills/code-style` | a skill in another agent's folder |
| `.agents/skills/release-checklist` | malformed front matter |
| `.github/skills/release-checklist` | the same name, different bytes: another skill |
| `tools/gradle/.claude/skills/gradle-bump` | a nested project's skill |
| `SKILL.md`, `docs/`, `skills/library`, `plugins/review/skills/review` | outside a skill root: not a skill |
| `.claude/skills/SKILL.md` | no skill directory: not a skill |
| `.claude/skills/commits/examples` | a file of a skill: not a skill |
| `.claude/skills/lowercase/skill.md` | another case: not a skill |
| `.claude/skills/linked`, `.claude/skills/linked-directory` | symbolic links: not skills |
