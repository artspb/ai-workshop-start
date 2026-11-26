/** A project skill's SKILL.md, named after its directory. */
export type SkillFile = { path: string; name: string };

/** Where agents keep a repository's own skills. */
export const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.github/skills', 'agent/skills'];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `<root>/<name>/SKILL.md`, the root at the repository root or in any directory. */
const PROJECT_SKILL = new RegExp(`^(?:.*/)?(?:${SKILL_ROOTS.map(escape).join('|')})/([^/]+)/SKILL\\.md$`);

/** Never part of a repository's own skills. */
const SKIPPED = new Set(['.git', 'node_modules']);

/**
 * The project skills among the files, by path: exactly `SKILL.md`, one directory below a skill
 * root. Anywhere else, deeper, or under `.git` or `node_modules`, a SKILL.md is not a project skill.
 */
export function findSkills(paths: string[]): SkillFile[] {
  return paths
    .filter((path) => !path.split('/').some((segment) => SKIPPED.has(segment)))
    .flatMap((path) => {
      const match = PROJECT_SKILL.exec(path);
      return match ? [{ path, name: match[1] }] : [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
