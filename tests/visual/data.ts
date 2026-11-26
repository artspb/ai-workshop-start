// The visual tests' data, the same on every run: the clock, GitHub's recorded answers, and the stored scans
// a test seeds the store with. See spec/web.md#visual-tests.
import type { Recording } from '../../src/core/replay.ts';
import type { ScanResult } from '../../src/core/scan.ts';

/** The page's clock: Playwright's, fixed. */
export const NOW = new Date('2026-11-26T12:00:00Z');

/** Where `./fixture` is copied, so a local link reads the same on every machine: `file:///tmp/skill-atlas-visual/fixture/…`. */
export const WORKDIR = '/tmp/skill-atlas-visual';

/** A stored scan: its key, every ref asked for, when it was scanned and its result. */
export type Seed = { key: string; refs: string[]; scannedAt: string; result: ScanResult };

/** GitHub refuses every request: the rate limit, reset 20 minutes after NOW. Without GITHUB_TOKEN. */
export const RATE_LIMITED: Recording = {
  'https://api.github.com/repos/JetBrains/example': {
    status: 403,
    body: { message: 'API rate limit exceeded for 203.0.113.7.', documentation_url: 'https://docs.github.com/rest/rate-limit' },
    headers: {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(NOW.getTime() / 1000 + 20 * 60),
      'x-ratelimit-resource': 'core',
    },
  },
};

const VERBS = ['bump', 'check', 'document', 'format', 'migrate', 'publish', 'release', 'review'];
const NOUNS = ['changelog', 'dependencies', 'docs', 'gradle', 'api', 'samples', 'tests', 'wrapper'];

/** A commit as GitHub names one: 40 hex digits, from a seed. */
const commit = (n: number) => (n.toString(16).padStart(8, '0').repeat(5)).slice(0, 40);

/** A repository's stored scan, with `count` skills named from VERBS and NOUNS, from `offset` on. */
function stored(id: string, sha: string, count: number, offset: number, refs: string[], scannedAt: string, warnings: string[] = []): Seed {
  const [organization, name] = id.split('/');
  const skills = Array.from({ length: count }, (_, i) => {
    const verb = VERBS[(offset + i) % VERBS.length];
    const noun = NOUNS[Math.floor((offset + i) / VERBS.length) % NOUNS.length];
    const path = `.claude/skills/${verb}-${noun}/SKILL.md`;
    return {
      id: `${id}:${path}`,
      repository: id,
      path,
      name: `${verb}-${noun}`,
      description: `${verb[0].toUpperCase()}${verb.slice(1)} the ${noun} of ${name}, as its maintainers do. Use before a pull request.`,
      commit: sha,
      copies: i % 5 === 0 ? [`.agents/skills/${verb}-${noun}/SKILL.md`] : [],
    };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    key: JSON.stringify(['github', id, sha, 'whole tree']),
    refs,
    scannedAt,
    result: { repository: { id, organization, name, url: `https://github.com/${id}`, commit: sha }, skills, warnings },
  };
}

/**
 * Four stored scans of three repositories, 60 skills in their latest scans: a search for `jetbrains`, in every
 * repository's name, finds the first 50 and `and 10 more`. The older scan of kotlin-tools is not searched.
 */
export const STORED: Seed[] = [
  stored('JetBrains/kotlin-tools', commit(0xa1b2c3d4), 24, 0, ['main (default branch)', 'v2.1.0'], '2026-11-26T11:40:00.000Z', [
    '.claude/skills/legacy/SKILL.md: malformed front matter (missing closing ---); using the directory name',
  ]),
  stored('JetBrains/docs-site', commit(0x5e6f7081), 20, 24, ['main (default branch)'], '2026-11-25T16:05:00.000Z'),
  stored('JetBrains/build-scripts', commit(0x92a3b4c5), 16, 44, ['release/2026.3'], '2026-11-24T09:30:00.000Z'),
  stored('JetBrains/kotlin-tools', commit(0x0d1e2f30), 10, 0, ['v2.0.0'], '2026-11-20T08:15:00.000Z'),
];
