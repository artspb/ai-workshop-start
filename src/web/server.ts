// The web view: the page, and the scan behind it as JSON. The core runs here, so the page can scan
// local directories and never sees GITHUB_TOKEN. Local only. See spec/web.md.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AtlasError } from '../core/errors.ts';
import { skillLink } from '../core/model.ts';
import { scan, type ScanResult, type Source, type Store } from '../core/scan.ts';

export type WebOptions = {
  /** Opens what the page asked to scan, as the CLI does. */
  open(input: string): Promise<Source>;
  /** Earlier scans, shared with the CLI; without one, every scan runs. */
  store?: Store;
};

/** The page's files, by URL path; nothing else is served from disk. */
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/filter.js': { file: 'filter.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** Another site, through DNS rebinding, must not read the answers: only local host names. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createWebServer(options: WebOptions): Server {
  return createServer((request, response) => {
    handle(request, response, options).catch((error) => {
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

async function handle(request: IncomingMessage, response: ServerResponse, options: WebOptions) {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return json(response, 403, { error: `Not a local host: ${host}` });
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'GET only' });
  if (url.pathname === '/api/scan') return json(response, ...(await scanAnswer(url.searchParams.get('repo'), options)));
  if (url.pathname === '/api/scans') return json(response, 200, { scans: (await options.store?.list()) ?? [] });
  const stored = /^\/api\/scans\/([^/]+)$/.exec(url.pathname);
  if (stored) {
    const result = await options.store?.open(stored[1]);
    return result ? json(response, 200, answer(result)) : json(response, 404, { error: `No stored scan: ${stored[1]}` });
  }
  const page = FILES[url.pathname];
  if (!page) return json(response, 404, { error: `Not found: ${url.pathname}` });
  const body = await readFile(new URL(`public/${page.file}`, import.meta.url));
  response.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-cache' }).end(body);
}

async function scanAnswer(input: string | null, { open, store }: WebOptions): Promise<[number, unknown]> {
  try {
    if (!input?.trim()) throw new AtlasError('Enter a GitHub URL or a directory');
    return [200, answer(await scan(await open(input.trim()), store))];
  } catch (error) {
    if (error instanceof AtlasError) return [400, { error: error.message }];
    throw error;
  }
}

/** A result as the page reads it: every skill with its link. */
function answer({ repository, skills, warnings }: ScanResult) {
  return {
    repository,
    skills: skills.map((skill) => {
      const { id, name, description, path, commit, copies } = skill;
      return { id, name, description, path, commit, copies, link: skillLink(repository, skill) };
    }),
    warnings,
  };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
