// An organization's repositories, each scanned as one repository is: see spec/analysis.md#organization.
import { AtlasError, GitHubUnavailable } from './errors.ts';
import { scan, type ScanResult, type Source, type Store } from './scan.ts';

/** An organization or a user on GitHub, and its repositories. */
export type Organization = {
  /** The login, for example `JetBrains`. */
  id: string;
  url: string;
  /**
   * Each repository, `owner/name`, with the input that scans it at its default branch; `open`, when
   * given, opens that scan instead of the input, with what the list already knows.
   */
  repositories: { id: string; input: string; open?: () => Promise<Source> }[];
};

/** One repository of an organization: its result and its stored scan's id, or why it could not be scanned. */
export type RepositoryScan =
  | { id: string; result: ScanResult; stored: string | null; error?: undefined }
  | { id: string; result?: undefined; stored?: undefined; error: string };

/** The order repositories are scanned in: by name, case-insensitive. */
export function byName(a: { id: string }, b: { id: string }): number {
  const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return compare(a.id.toLowerCase(), b.id.toLowerCase()) || compare(a.id, b.id);
}

/** Scanned at the same time: each repository mostly waits on GitHub. */
const AT_A_TIME = 8;

/**
 * Every repository of the organization, sorted by name, case-insensitive; each one a scan of its
 * own, stored as one. A repository that cannot be scanned is skipped with its error; when GitHub
 * answers no more, the whole scan fails. Once `signal` aborts (nobody waits for the answer any more),
 * no repository is started, and the scan fails with the signal's reason when the ones started end.
 * `progress` hears how many repositories are scanned of how many: 0 first, then as each one ends,
 * scanned or skipped.
 */
export async function scanOrganization(
  organization: Organization,
  open: (input: string) => Promise<Source>,
  store?: Store,
  signal?: AbortSignal,
  progress?: (scanned: number, repositories: number) => void,
): Promise<RepositoryScan[]> {
  const repositories = [...organization.repositories].sort(byName);
  const scans: RepositoryScan[] = new Array(repositories.length);
  let next = 0;
  let stopped = false;
  let scanned = 0;
  progress?.(0, repositories.length);
  async function worker() {
    while (!stopped && !signal?.aborted && next < repositories.length) {
      const index = next++;
      const { id, input, open: openListed } = repositories[index];
      try {
        scans[index] = { id, ...(await scan(await (openListed ? openListed() : open(input)), store)) };
      } catch (error) {
        if (error instanceof GitHubUnavailable || !(error instanceof AtlasError)) {
          stopped = true; // the repositories not started yet are not asked for
          throw error;
        }
        scans[index] = { id, error: error.message };
      }
      if (!stopped) progress?.(++scanned, repositories.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_A_TIME, repositories.length) }, worker));
  signal?.throwIfAborted();
  return scans;
}
