// A scan's progress and its Stop, in their own module so the tests can import it.

/**
 * What the page asks for to scan with progress: `/api/scan?…&progress`; a stored scan as it is.
 * @param {{ repo?: string, url: string }} request
 */
export function progressUrl(request) {
  return request.repo ? `${request.url}&progress` : request.url;
}

/**
 * The answer to /api/scan: JSON, or, for an organization with `progress`, NDJSON whose lines are
 * its progress, each one handed to `onProgress`, then the answer itself or `{ error }`.
 * @param {Response} response
 * @param {(progress: { scanned: number, repositories: number }) => void} [onProgress]
 */
export async function readAnswer(response, onProgress = () => {}) {
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) return response.json();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let answer;
  const read = (line) => {
    if (!line.trim()) return;
    const object = JSON.parse(line);
    if (object.progress) onProgress(object.progress);
    else answer = object;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (rest + value).split('\n');
    rest = lines.pop();
    lines.forEach(read);
  }
  read(rest);
  return answer ?? { error: 'The scan ended without an answer' };
}

const repositories = (n) => `${n} ${n === 1 ? 'repository' : 'repositories'}`;

/**
 * The status while a scan runs: what it scans, and for an organization how many repositories are
 * scanned of how many.
 * @param {string} repo
 * @param {{ scanned: number, repositories: number } | null} [progress]
 */
export function progressText(repo, progress) {
  return progress ? `Scanning ${repo}… ${progress.scanned} of ${repositories(progress.repositories)}` : `Scanning ${repo}…`;
}

/**
 * The status once the user stops a scan: for an organization, how far it got; the repositories
 * scanned are stored scans of their own, in Scanned before.
 * @param {string} repo
 * @param {{ scanned: number, repositories: number } | null} [progress]
 */
export function stoppedText(repo, progress) {
  if (!progress) return `Stopped scanning ${repo}`;
  return `Stopped scanning ${repo} at ${progress.scanned} of ${repositories(progress.repositories)}; the ones scanned are in Scanned before`;
}

/**
 * An error answer as the status shows it: the rate limit with when it resets, in the viewer's local
 * time and format; the time and the minutes rounded up, so trying at the time shown works; a reset
 * already past, the next minute, never a time behind the clock. Any other
 * error, or no reset time: its message.
 * @param {{ error: string, rateLimit?: { resetsAt: string | null, token: boolean } }} answer
 * @param {number} [now]
 * @param {Intl.DateTimeFormatOptions & { locale?: string }} [format] the viewer's, unless a test picks one
 */
export function errorText({ error, rateLimit }, now = Date.now(), { locale, ...format } = {}) {
  const resetsAt = rateLimit?.resetsAt ? Date.parse(rateLimit.resetsAt) : NaN;
  if (Number.isNaN(resetsAt)) return error;
  const minute = 60_000;
  const time = new Date(Math.max(Math.ceil(resetsAt / minute), Math.floor(now / minute) + 1) * minute).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...format });
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / minute));
  const resets = `it resets at ${time} (in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'})`;
  return `GitHub rate limit reached; ${rateLimit.token ? resets : `set GITHUB_TOKEN, or wait: ${resets}`}`;
}
