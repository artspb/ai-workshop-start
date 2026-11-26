import { AtlasError, GitHubUnavailable } from './errors.ts';
import { SKILL_ROOTS } from './find.ts';
import type { Organization } from './organization.ts';
import type { Source } from './scan.ts';

/** The part of `fetch` the core uses, so tests and the browser can pass their own. */
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export type GitHubOptions = {
  fetch: Fetch;
  /**
   * With a token, a default branch whose tree is too large for one answer is listed through code
   * search; without one, only its skill roots are. Any tree in one answer is listed whole.
   */
  token?: string;
};

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/**
 * `https://github.com/owner/repo`, with or without the scheme, a trailing slash or `.git`;
 * `/tree/<ref>` picks a commit, a branch or a tag, one path segment.
 */
export function parseGitHubUrl(input: string): { owner: string; repo: string; ref?: string } | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+))?\/?$/i.exec(
    input.trim(),
  );
  if (!match) return undefined;
  return match[3] ? { owner: match[1], repo: match[2], ref: decodeURIComponent(match[3]) } : { owner: match[1], repo: match[2] };
}

/** `https://github.com/<owner>`, with or without the scheme or a trailing slash: an organization or a user. */
export function parseGitHubOwner(input: string): string | undefined {
  return /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/?$/i.exec(input.trim())?.[1];
}

/**
 * The owner's repositories, each one at its default branch, as `/tree/<default branch>`: an
 * organization's, every one the scan can see; a user's, the ones they own.
 */
export async function openGitHubOwner(input: string, options: GitHubOptions): Promise<Organization> {
  const login = parseGitHubOwner(input);
  if (!login) throw new AtlasError(`Not a GitHub organization URL: ${input}`);
  const github = client(options);
  const owner = await github.json<{ login: string; type: string }>(
    `${API}/users/${login}`,
    `Organization or user not found: https://github.com/${login}`,
  );
  const list =
    owner.type === 'Organization' ? `${API}/orgs/${owner.login}/repos?type=all` : `${API}/users/${owner.login}/repos?type=owner`;
  const repositories = new Map<string, string>(); // pages can repeat a repository created while listing
  for (let page = 1; ; page++) {
    const answer = await github.json<{ full_name: string; default_branch: string }[]>(`${list}&per_page=100&page=${page}`);
    for (const { full_name: id, default_branch: branch } of answer) {
      repositories.set(id, `https://github.com/${id}/tree/${encodeURIComponent(branch)}`);
    }
    if (answer.length < 100) break;
  }
  return {
    id: owner.login,
    url: `https://github.com/${owner.login}`,
    repositories: [...repositories].map(([id, input]) => ({ id, input })),
  };
}

/** Resolves the ref, or the default branch, to a commit and lists the files that may be skills. */
export async function openGitHub(input: string, options: GitHubOptions): Promise<Source> {
  const name = parseGitHubUrl(input);
  if (!name) throw new AtlasError(`Not a GitHub repository URL: ${input}`);
  const github = client(options);
  const info = await github.json<{ full_name: string; default_branch: string }>(
    `${API}/repos/${name.owner}/${name.repo}`,
    `Repository not found: https://github.com/${name.owner}/${name.repo}`,
  );
  const id = info.full_name;
  const ref = name.ref ?? info.default_branch;
  const { sha } = await github.json<{ sha: string }>(
    `${API}/repos/${id}/commits/${encodeURIComponent(ref)}`,
    `Not found in https://github.com/${id}: ${ref}`,
  );
  // The tree first: it is the commit's own. Code search, with a token, only for a default branch
  // whose tree is too large for one answer: the index sees only the default branch.
  const searchable = Boolean(options.token) && !name.ref;
  const [organization, repo] = id.split('/');
  // The keys: a tree in one answer lists the same for every ref, with a token or without: one
  // stored scan. A tree too large lists the roots, with a warning worded for a ref or for the
  // default branch: stored apart. Code search is never stored: its index follows the default
  // branch late, and may not have every skill of the commit yet. The names of the roots' keys
  // are those an earlier version stored a scan of either kind under, whole tree or roots, so
  // those are found again: by any input when the tree was whole, else only by their own kind.
  const key = (listing: string) => JSON.stringify(['github', id, sha, listing]);
  const whole = key('whole tree');
  const earlier = [key('tree'), key('tree of the default branch')];
  const roots = searchable ? undefined : earlier[name.ref ? 0 : 1];
  return {
    repository: { id, organization, name: repo, url: `https://github.com/${id}`, commit: sha },
    async list() {
      const tree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${sha}?recursive=1`);
      if (!tree.truncated) return { paths: files(tree), warnings: [], key: whole };
      if (searchable) return { paths: await searchPaths(github, id), warnings: [] };
      const warnings: string[] = [];
      return { paths: await rootPaths(github, id, sha, warnings, !name.ref), warnings, key: roots };
    },
    read: (path) => github.raw(`${RAW}/${id}/${sha}/${encodePath(path)}`),
    keys: [whole, ...(roots ? [roots] : []), ...earlier.filter((other) => other !== roots)],
    serves: (stored, result) => stored === whole || stored === roots || !result.warnings[0]?.startsWith(TOO_LARGE),
    ref: name.ref ?? `${info.default_branch} (default branch)`,
  };
}

/** Code search looks at the whole default branch, 100 results a page. */
async function searchPaths(github: Client, id: string): Promise<string[]> {
  const paths = new Set<string>(); // pages can repeat a result
  // GitHub returns at most 1000 results: ten pages.
  for (let page = 1; page <= 10; page++) {
    const result = await github.json<{ total_count: number; items: { path: string }[] }>(
      `${API}/search/code?q=filename:SKILL.md+repo:${id}&per_page=100&page=${page}`,
    );
    for (const item of result.items) paths.add(item.path);
    if (result.items.length < 100 || page * 100 >= result.total_count) break;
  }
  return [...paths];
}

type Tree = { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] };

/** The first warning of a roots listing: a result without it is of a tree in one answer. */
const TOO_LARGE = 'the tree is too large to list at once';

/** Only the skill roots, for a tree too large for one answer. */
async function rootPaths(github: Client, id: string, sha: string, warnings: string[], searchable: boolean): Promise<string[]> {
  const hint = searchable ? ' (GITHUB_TOKEN searches everywhere)' : '';
  warnings.push(`${TOO_LARGE}; looked only in ${SKILL_ROOTS.join(', ')}${hint}`);
  const paths: string[] = [];
  for (const root of SKILL_ROOTS) {
    const rootSha = await directory(github, id, sha, root);
    if (!rootSha) continue;
    const subtree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${rootSha}?recursive=1`);
    paths.push(...files(subtree).map((path) => `${root}/${path}`));
  }
  return paths;
}

/** Walks down one level at a time; the directory's tree, or undefined if it does not exist. */
async function directory(github: Client, id: string, sha: string, path: string): Promise<string | undefined> {
  let current = sha;
  for (const segment of path.split('/')) {
    const tree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${current}`);
    const entry = tree.tree.find((item) => item.path === segment && item.type === 'tree');
    if (!entry) return undefined;
    current = entry.sha;
  }
  return current;
}

/** Regular files only: a symbolic link's content is its target, not a SKILL.md. */
function files(tree: Tree): string[] {
  return tree.tree.filter((item) => item.type === 'blob' && item.mode !== '120000').map((item) => item.path);
}

type Client = ReturnType<typeof client>;

function client({ fetch, token }: GitHubOptions) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const answers = new Map<string, Promise<unknown>>(); // the root tree is asked for once per skill root

  async function get(url: string, init?: { headers: Record<string, string> }): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new GitHubUnavailable(`Cannot reach GitHub: ${describe(error)}`);
    }
  }

  async function request(url: string, notFound: string): Promise<unknown> {
    const response = await get(url, { headers });
    if (response.ok) return response.json();
    const body: unknown = await response.json().catch(() => undefined);
    const message = (body as { message?: unknown } | undefined)?.message;
    const text = typeof message === 'string' ? message : '';
    if (response.status === 404) throw new AtlasError(notFound);
    if ((response.status === 403 || response.status === 429) && /rate limit/i.test(text)) throw rateLimit();
    throw failure(response.status, url, text);
  }

  const rateLimit = () => new GitHubUnavailable(`GitHub rate limit reached; ${token ? 'try again in a minute' : 'set GITHUB_TOKEN'}`);

  /** GitHub answers no more requests: these stop an organization scan. Any other failure is one repository's. */
  function failure(status: number, url: string, text = ''): AtlasError {
    if (status === 429) return rateLimit();
    if (status === 401) return new GitHubUnavailable('GitHub rejected the token in GITHUB_TOKEN');
    return new AtlasError(`GitHub answered ${status} for ${url}${text && `: ${text}`}`);
  }

  return {
    /** A GitHub API answer; `notFound` explains a 404. */
    json<T>(url: string, notFound = `Not found on GitHub: ${url}`): Promise<T> {
      if (!answers.has(url)) answers.set(url, request(url, notFound));
      return answers.get(url) as Promise<T>;
    },
    /** A file's bytes at the scanned commit, or undefined if it is not there. */
    async raw(url: string): Promise<Uint8Array | undefined> {
      // A private repository's files are read with the token too: without it, they answer 404.
      const response = await get(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (response.status === 404) return undefined;
      if (!response.ok) throw failure(response.status, url);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
