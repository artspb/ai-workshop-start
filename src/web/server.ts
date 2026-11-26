// The web view: the page, and the scan behind it as JSON. The core runs here, so the page can scan
// local directories and never sees GITHUB_TOKEN. Local only. See spec/web.md.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AtlasError, RateLimited } from '../core/errors.ts';
import { firstSentence, skillLink } from '../core/model.ts';
import { scanOrganization, type Organization } from '../core/organization.ts';
import { meter, quotaBook, type Meter, type QuotaBook } from '../core/requests.ts';
import { scan, type ScanResult, type Source, type Store, type StoredScan } from '../core/scan.ts';
import { filterSkills } from './public/filter.js';

export type WebOptions = {
  /** Opens what the page asked to scan, as the CLI does; its GitHub requests counted by the meter. */
  open(input: string, meter?: Meter): Promise<Source>;
  /** Opens the organization or user the page asked to scan, as the CLI does; undefined when the input is not one. */
  openOrganization?(input: string, meter?: Meter): Promise<Organization> | undefined;
  /** Earlier scans, shared with the CLI; without one, every scan runs. */
  store?: Store;
};

/** The page's files, by URL path; nothing else is served from disk. */
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/filter.js': { file: 'filter.js', type: 'text/javascript; charset=utf-8' },
  '/history.js': { file: 'history.js', type: 'text/javascript; charset=utf-8' },
  '/progress.js': { file: 'progress.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** Another site, through DNS rebinding, must not read the answers: only local host names. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createWebServer(options: WebOptions): Server {
  // The quota GitHub's answers told, the last seen across every scan: the page shows it before any scan.
  const book = quotaBook();
  return createServer((request, response) => {
    handle(request, response, options, book).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });
}

/** Listens on 127.0.0.1; resolves to the page's URL, or fails with a message for the user. */
export function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new AtlasError(`Port ${port} is in use; pick another with --port`)
          : new AtlasError(`Cannot listen on port ${port}: ${error.message}`),
      ),
    );
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://localhost:${typeof address === 'object' && address ? address.port : port}`);
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, options: WebOptions, book: QuotaBook) {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return json(response, 403, { error: `Not a local host: ${host}` });
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'GET only' });
  if (url.pathname === '/api/scan') {
    // The page that asked may leave (another scan, back, a reload, a closed tab): an organization's
    // repositories not started yet are then not asked for, so the rate limit is not spent on nobody.
    const gone = new AbortController();
    response.once('close', () => response.writableFinished || gone.abort(new Error('The page left before the answer')));
    // This scan's requests, counted as GitHub answers them.
    const requests = meter(book);
    // With `progress`, an organization's answer is a stream: its progress first, then the answer itself.
    const stream = url.searchParams.has('progress') ? progressStream(response, gone.signal, requests) : undefined;
    try {
      const answer = await scanAnswer(url.searchParams.get('repo'), options, requests, gone.signal, stream?.progress);
      if (gone.signal.aborted) return;
      if (stream?.started()) stream.end(answer[1]);
      else json(response, ...answer);
    } catch (error) {
      if (gone.signal.aborted) return; // nobody to answer
      if (!stream?.started()) throw error;
      stream.end({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  // The last quota seen, from earlier scans' answers: GitHub is never asked just to show it.
  if (url.pathname === '/api/quota') return json(response, 200, { quota: book.current() });
  if (url.pathname === '/api/search') return json(response, 200, await search(url.searchParams.get('q') ?? '', options.store));
  if (url.pathname === '/api/scans') return json(response, 200, { scans: (await options.store?.list()) ?? [] });
  const stored = /^\/api\/scans\/([^/]+)$/.exec(url.pathname);
  if (stored) {
    const result = await options.store?.open(stored[1]);
    if (!result) return json(response, 404, { error: `No stored scan: ${stored[1]}` });
    return json(response, 200, { ...answer(result, stored[1]), ...counted(meter(book)) });
  }
  const page = FILES[url.pathname];
  if (!page) return json(response, 404, { error: `Not found: ${url.pathname}` });
  const body = await readFile(new URL(`public/${page.file}`, import.meta.url));
  response.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-cache' }).end(body);
}

/** The answer to /api/scan, with the scan's requests and the last quota seen; an error the CLI reports with exit code 1 too. */
async function scanAnswer(
  input: string | null,
  { open, openOrganization, store }: WebOptions,
  requests: Meter,
  signal: AbortSignal,
  progress?: Progress,
): Promise<[number, unknown]> {
  try {
    if (!input?.trim()) throw new AtlasError('Enter a GitHub URL or a directory');
    const organization = openOrganization?.(input.trim(), requests);
    const opened = (input: string) => open(input, requests);
    if (organization) return [200, { ...(await organizationAnswer(await organization, opened, store, signal, progress)), ...counted(requests) }];
    const { result, stored } = await scan(await opened(input.trim()), store);
    return [200, { ...answer(result, stored), ...counted(requests) }];
  } catch (error) {
    if (error instanceof AtlasError) return [400, { ...errorAnswer(error), ...counted(requests) }];
    throw error;
  }
}

/** A scan's requests so far, by kind, and the last quota GitHub's answers told, null when none did. */
function counted(requests: Meter) {
  return { requests: requests.requests(), quota: requests.quota() };
}

/**
 * An organization as the page reads it, as the CLI prints it: the owner with how many repositories
 * it has and how many skills they hold; each repository with skills, as /api/scan answers it; the
 * warnings, each with its repository first.
 */
async function organizationAnswer(
  organization: Organization,
  open: WebOptions['open'],
  store: Store | undefined,
  signal: AbortSignal,
  progress?: Progress,
) {
  const scans = await scanOrganization(organization, open, store, signal, progress);
  return {
    organization: {
      id: organization.id,
      url: organization.url,
      repositories: scans.length,
      skills: scans.reduce((total, { result }) => total + (result?.skills.length ?? 0), 0),
    },
    repositories: scans.flatMap(({ result, stored }) => (result?.skills.length ? [answer(result, stored)] : [])),
    warnings: scans.flatMap(({ id, result, error }) => (result ? result.warnings : [error]).map((warning) => `${id}: ${warning}`)),
  };
}

/** An error the CLI reports with exit code 1; the rate limit with when it resets, for the page to word in the viewer's time. */
function errorAnswer(error: AtlasError) {
  if (!(error instanceof RateLimited)) return { error: error.message };
  return { error: error.message, rateLimit: { resetsAt: error.resetsAt?.toISOString() ?? null, token: error.token } };
}

/** A result as the page reads it: every skill with its link, and the stored scan's id, if stored. */
function answer({ repository, skills, warnings }: ScanResult, stored: string | null) {
  return {
    repository,
    skills: skills.map((skill) => {
      const { id, name, description, path, commit, copies } = skill;
      return { id, name, description, path, commit, copies, link: skillLink(repository, skill) };
    }),
    warnings,
    stored,
  };
}

/** How many results a search answers: one letter matches about the whole store. */
const SEARCH_RESULTS = 50;

/**
 * The skills of every stored scan that match the words, in the name, description or repository: each
 * repository once, from its latest stored scan; the first SEARCH_RESULTS, and how many more match.
 * From the store only, each file read once: GitHub is not asked.
 */
async function search(query: string, store: Store | undefined) {
  if (!store || !query.trim()) return { results: [], more: 0 };
  const latest = new Map<string, StoredScan & { result: ScanResult }>();
  // The list is the latest first: a repository's first stored scan is its latest.
  for (const stored of await store.listResults()) if (!latest.has(stored.repository.id)) latest.set(stored.repository.id, stored);
  const results = [];
  for (const { id, refs, result } of latest.values()) {
    const { repository } = result;
    for (const skill of filterSkills(result.skills, query, repository.id))
      results.push({ id: skill.id, name: skill.name, sentence: firstSentence(skill.description), link: skillLink(repository, skill), repository, refs, scan: id, path: skill.path });
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  results.sort((a, b) => compare(a.name, b.name) || compare(a.repository.id, b.repository.id) || compare(a.path, b.path));
  return { results: results.slice(0, SEARCH_RESULTS).map(({ path, ...result }) => result), more: Math.max(results.length - SEARCH_RESULTS, 0) };
}

/** How many repositories of an organization are scanned, of how many. */
type Progress = (scanned: number, repositories: number) => void;

/**
 * An answer as NDJSON, one object a line: `{ progress: { scanned, repositories }, requests, quota }` as the scan goes,
 * then the answer, or `{ error }`. Starts with the first progress: an organization that cannot be
 * opened, or a repository, is answered as JSON, as without it.
 */
function progressStream(response: ServerResponse, signal: AbortSignal, requests: Meter) {
  const line = (body: unknown) => response.write(`${JSON.stringify(body)}\n`);
  return {
    started: () => response.headersSent,
    progress(scanned: number, repositories: number) {
      if (signal.aborted) return;
      if (!response.headersSent)
        response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      line({ progress: { scanned, repositories }, ...counted(requests) });
    },
    end(body: unknown) {
      line(body);
      response.end();
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
