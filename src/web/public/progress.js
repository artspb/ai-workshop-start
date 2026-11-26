// A scan's progress, its Stop and its GitHub requests, in their own module so the tests can import it.

/**
 * What the page asks for to scan with progress: `/api/scan?…&progress`; a stored scan as it is.
 * @param {{ repo?: string, url: string }} request
 */
export function progressUrl(request) {
  return request.repo ? `${request.url}&progress` : request.url;
}

/**
 * The answer to /api/scan: JSON, or, for an organization with `progress`, NDJSON whose lines are
 * its progress, each one handed to `onProgress` with its whole line (its requests and quota too), then
 * the answer itself or `{ error }`.
 * @param {Response} response
 * @param {(progress: { scanned: number, repositories: number }, line: { requests?: object, quota?: object | null }) => void} [onProgress]
 */
export async function readAnswer(response, onProgress = () => {}) {
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) return response.json();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let answer;
  const read = (line) => {
    if (!line.trim()) return;
    const object = JSON.parse(line);
    if (object.progress) onProgress(object.progress, object);
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
  const time = resetClock(resetsAt, now, { locale, ...format });
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / minute));
  const resets = `it resets at ${time} (in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'})`;
  return `GitHub rate limit reached; ${rateLimit.token ? resets : `set GITHUB_TOKEN, or wait: ${resets}`}`;
}

/**
 * A reset time as the page shows it, in the viewer's local time and format, rounded up to the minute;
 * one already past, the next minute, never a time behind the clock.
 * @param {number} resetsAt
 * @param {number} now
 * @param {Intl.DateTimeFormatOptions & { locale?: string }} [format]
 */
function resetClock(resetsAt, now, { locale, ...format } = {}) {
  const minute = 60_000;
  return new Date(Math.max(Math.ceil(resetsAt / minute), Math.floor(now / minute) + 1) * minute).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...format });
}

/**
 * The quota left, as GitHub's answers last told it: REST's (`core`), then GraphQL's points; each with
 * when it resets. A limit whose reset is past has reset since: all of it left, no time. None seen: nothing.
 * @param {Record<string, { remaining: number, limit: number, resetsAt: string }> | null | undefined} quota
 * @param {number} now
 * @param {Intl.DateTimeFormatOptions & { locale?: string }} format
 * @returns {string[]}
 */
function quotaParts(quota, now, format) {
  const number = (n) => n.toLocaleString(format.locale);
  const part = (limit, unit) => {
    const resetsAt = Date.parse(limit.resetsAt);
    if (!(resetsAt > now)) return `${number(limit.limit)} of ${number(limit.limit)}${unit} left`;
    return `${number(limit.remaining)} of ${number(limit.limit)}${unit} left, resets at ${resetClock(resetsAt, now, format)}`;
  };
  const parts = [];
  if (quota?.core) parts.push(part(quota.core, ''));
  if (quota?.graphql) parts.push(`GraphQL: ${part(quota.graphql, ' points')}`);
  return parts;
}

/**
 * A scan's GitHub requests and the quota left, under the box:
 * `312 REST requests, 26 GraphQL queries, 1,904 file reads · 4,059 of 5,000 left, resets at 17:33`;
 * none: `0 requests`, and a stored scan opened as stored, `0 requests, from the store`.
 * In the viewer's local time and number format, unless a test picks them.
 * @param {{ requests?: { rest: number, graphql: number, files: number }, quota?: Record<string, { remaining: number, limit: number, resetsAt: string }> | null, stored?: string | null }} answer
 * @param {number} [now]
 * @param {Intl.DateTimeFormatOptions & { locale?: string }} [format]
 */
export function requestsText({ requests, quota, stored }, now = Date.now(), format = {}) {
  if (!requests) return '';
  const number = (n) => n.toLocaleString(format.locale);
  const { rest, graphql, files } = requests;
  const counts =
    rest + graphql + files === 0
      ? `0 requests${stored ? ', from the store' : ''}`
      : [
          `${number(rest)} REST ${rest === 1 ? 'request' : 'requests'}`,
          `${number(graphql)} GraphQL ${graphql === 1 ? 'query' : 'queries'}`,
          `${number(files)} file ${files === 1 ? 'read' : 'reads'}`,
        ].join(', ');
  return [counts, ...quotaParts(quota, now, format)].join(' · ');
}

/**
 * Before any scan: the quota the server last saw, `GitHub quota: 4,059 of 5,000 left, resets at 17:33`;
 * '' when it saw none.
 * @param {Record<string, { remaining: number, limit: number, resetsAt: string }> | null | undefined} quota
 * @param {number} [now]
 * @param {Intl.DateTimeFormatOptions & { locale?: string }} [format]
 */
export function quotaText(quota, now = Date.now(), format = {}) {
  const parts = quotaParts(quota, now, format);
  return parts.length ? `GitHub quota: ${parts.join(' · ')}` : '';
}
