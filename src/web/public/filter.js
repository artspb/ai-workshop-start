// The page's filter, in its own module so the tests can import it.

/**
 * The skills whose name or description holds every word of the query, case-insensitive.
 * @template {{ name: string, description: string }} T
 * @param {T[]} skills
 * @param {string} query
 * @returns {T[]}
 */
export function filterSkills(skills, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    const text = `${skill.name}\n${skill.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * An organization's repositories, each with only its skills the query matches, as `filterSkills`
 * does, and `total`, its whole skill count, for its heading; a repository with none is left out.
 * @template {{ skills: { name: string, description: string }[] }} R
 * @param {R[]} repositories
 * @param {string} query
 * @returns {(R & { total: number })[]}
 */
export function filterRepositories(repositories, query) {
  return repositories
    .map((repository) => ({ ...repository, skills: filterSkills(repository.skills, query), total: repository.skills.length }))
    .filter((repository) => repository.skills.length > 0);
}
