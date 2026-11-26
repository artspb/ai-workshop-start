// What the page asks for and shows of the stored scans, in its own module so the tests can import it.

/**
 * What the address asks for: `/?repo=<URL | directory>` a scan, `/?scan=<id>` a stored scan;
 * `repo` wins. Undefined for neither. Back and forward ask again for what the address holds.
 * @param {string} search `location.search`
 * @returns {{ repo: string, url: string } | { scan: string, url: string } | undefined}
 */
export function addressRequest(search) {
  const parameters = new URLSearchParams(search);
  const repo = parameters.get('repo')?.trim();
  if (repo) return { repo, url: `/api/scan?repo=${encodeURIComponent(repo)}` };
  const scan = parameters.get('scan')?.trim();
  if (scan) return { scan, url: `/api/scans/${encodeURIComponent(scan)}` };
  return undefined;
}

/**
 * The box, for a stored scan on the page: its repository at its commit, to scan again.
 * @param {{ url: string, commit: string }} repository
 */
export function storedBox(repository) {
  return repository.commit ? `${repository.url}/tree/${repository.commit}` : repository.url;
}

/**
 * Scanned before: hidden while nothing is stored; else a row per stored scan, in the server's
 * order, the latest first, and only the one on the page marked, by its id.
 * @param {{ id: string, repository: { id: string, commit: string }, refs: string[], skills: number, warnings: number, scannedAt: string }[]} scans
 * @param {string | null | undefined} shown the stored scan on the page, if any
 * @param {(iso: string) => string} [time] how a time is shown
 */
export function historyView(scans, shown, time = (iso) => new Date(iso).toLocaleString()) {
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return {
    hidden: scans.length === 0,
    rows: scans.map((scan) => ({
      id: scan.id,
      href: `/?scan=${scan.id}`,
      name: scan.repository.id,
      commit: scan.repository.commit,
      short: scan.repository.commit.slice(0, 12),
      details: [scan.refs.join(', '), count(scan.skills, 'skill'), ...(scan.warnings ? [count(scan.warnings, 'warning')] : []), time(scan.scannedAt)].join(' · '),
      current: Boolean(shown) && scan.id === shown,
    })),
  };
}
