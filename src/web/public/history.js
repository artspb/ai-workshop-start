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
 * The page's scans, one at a time: each call aborts the scan before, so the server stops asking GitHub
 * for it, and hands out the signal of the next one. Every address asks for one, an empty one too.
 * @returns {() => AbortSignal}
 */
export function scanSignals() {
  let asking = null;
  return () => {
    asking?.abort();
    asking = new AbortController();
    return asking.signal;
  };
}

/**
 * The box, for a stored scan on the page: its repository at its commit, to scan again.
 * @param {{ url: string, commit: string }} repository
 */
export function storedBox(repository) {
  return repository.commit ? `${repository.url}/tree/${repository.commit}` : repository.url;
}

/**
 * The stored scan an answer puts on the page, the one marked in Scanned before: a repository's or a
 * stored scan's id; none for an organization, whose page holds many stored scans, not one.
 * @param {{ stored?: string | null, organization?: unknown }} answer
 * @returns {string | null}
 */
export function storedOnPage(answer) {
  return answer.organization ? null : (answer.stored ?? null);
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

/** How long the typing pauses before the search asks the server, in ms. */
export const SEARCH_PAUSE = 250;

/**
 * The search, asked once the typing pauses: each word typed puts off the one before, so only the last
 * is asked, `pause` ms after it; an answer to an older word is not shown. No word: shown at once, none asked.
 * @template A
 * @param {(query: string) => Promise<A>} ask
 * @param {(query: string, answer: A | { results: [], more: 0 }) => void} show
 * @returns {(query: string, wait?: number) => void} a word typed; `wait` 0 to ask at once, after a scan
 */
export function searchAsker(ask, show, pause = SEARCH_PAUSE) {
  let timer;
  let asked = 0;
  return (query, wait = pause) => {
    clearTimeout(timer);
    const turn = ++asked;
    if (!query.trim()) return show(query, { results: [], more: 0 });
    timer = setTimeout(async () => {
      let answer;
      try {
        answer = await ask(query);
      } catch {
        return;
      }
      if (turn === asked) show(query, answer);
    }, wait);
  };
}

/**
 * The search across stored scans, for a query and /api/search's results: no word, no search, the
 * list shows; else a row per result, in the server's order, its repository opening its scan as stored,
 * then `and <M> more` for the ones not answered.
 * @param {string} query
 * @param {{ name: string, sentence: string, link: string, repository: { id: string, commit: string }, refs: string[], scan: string }[]} results
 * @param {number} [more] how many more match
 */
export function searchView(query, results, more = 0) {
  if (!query.trim()) return { searching: false, empty: false, rows: [], more: '' };
  return {
    searching: true,
    empty: results.length === 0,
    rows: results.map((result) => ({
      name: result.name,
      sentence: result.sentence,
      link: result.link,
      repository: result.repository.id,
      href: `/?scan=${result.scan}`,
      scan: result.scan,
      commit: result.repository.commit,
      short: result.repository.commit.slice(0, 12),
      refs: result.refs.join(', '),
    })),
    more: more > 0 ? `and ${more} more` : '',
  };
}
