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
