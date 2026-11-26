// An organization's repositories, each scanned as one repository is: see spec/analysis.md#organization.
import { AtlasError, GitHubUnavailable } from './errors.ts';
import { scan, type ScanResult, type Source, type Store } from './scan.ts';

/** An organization or a user on GitHub, and its repositories. */
export type Organization = {
  /** The login, for example `JetBrains`. */
  id: string;
  url: string;
  /** Each repository, `owner/name`, with the input that scans it at its default branch. */
  repositories: { id: string; input: string }[];
};

/** One repository of an organization: its result, or why it could not be scanned. */
export type RepositoryScan = { id: string; result: ScanResult; error?: undefined } | { id: string; result?: undefined; error: string };

/** Scanned at the same time: each repository mostly waits on GitHub. */
const AT_A_TIME = 8;

/**
 * Every repository of the organization, sorted by name, case-insensitive; each one a scan of its
 * own, stored as one. A repository that cannot be scanned is skipped with its error; when GitHub
 * answers no more, the whole scan fails.
 */
export async function scanOrganization(
  organization: Organization,
  open: (input: string) => Promise<Source>,
  store?: Store,
): Promise<RepositoryScan[]> {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const repositories = [...organization.repositories].sort(
    (a, b) => compare(a.id.toLowerCase(), b.id.toLowerCase()) || compare(a.id, b.id),
  );
  const scans: RepositoryScan[] = new Array(repositories.length);
  let next = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && next < repositories.length) {
      const index = next++;
      const { id, input } = repositories[index];
      try {
        scans[index] = { id, result: (await scan(await open(input), store)).result };
      } catch (error) {
        if (error instanceof GitHubUnavailable || !(error instanceof AtlasError)) {
          stopped = true; // the repositories not started yet are not asked for
          throw error;
        }
        scans[index] = { id, error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_A_TIME, repositories.length) }, worker));
  return scans;
}
