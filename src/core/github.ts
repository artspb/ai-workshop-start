import { AtlasError, GitHubUnavailable, RateLimited, resetTime } from './errors.ts';
import { SKILL_ROOTS } from './find.ts';
import { byName, type Organization } from './organization.ts';
import type { Meter } from './requests.ts';
import type { Source } from './scan.ts';

/** The part of `fetch` the core uses, so tests and the browser can pass their own. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export type GitHubOptions = {
  fetch: Fetch;
  /**
   * With a token, a default branch whose tree is too large for one answer is listed through code
   * search; without one, only its skill roots are. Any tree in one answer is listed whole.
   */
  token?: string;
  /** Counts the requests GitHub answers, and reads the quota left from them. */
  meter?: Meter;
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
 * organization's, every one the scan can see; a user's, the ones they own. Each one opens with the
 * name and the default branch the list gives, no lookup; with a token, its commit comes from one
 * GraphQL query per 100 repositories, in the scan's order. See spec/analysis.md#the-request-budget.
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
  const branches = new Map<string, string>(); // pages can repeat a repository created while listing
  for (let page = 1; ; page++) {
    const answer = await github.json<{ full_name: string; default_branch: string }[]>(`${list}&per_page=100&page=${page}`);
    for (const { full_name: id, default_branch: branch } of answer) branches.set(id, branch);
    if (answer.length < 100) break;
  }
  // In the scan's order, so each GraphQL query is asked only once the scan reaches its repositories.
  const listed = [...branches].map(([id, branch]) => ({ id, branch })).sort(byName);
  const commitOf = options.token ? defaultCommits(github, listed) : undefined;
  return {
    id: owner.login,
    url: `https://github.com/${owner.login}`,
    repositories: listed.map(({ id, branch }, index) => ({
      id,
      input: `https://github.com/${id}/tree/${encodeURIComponent(branch)}`,
      // A client of its own: one repository's answers are not kept for the whole organization.
      open: async () => openCommit(client(options), options, id, branch, branch, await commitOf?.(index)),
    })),
  };
}

/** Repositories in one GraphQL query. */
const QUERY_SIZE = 100;

/**
 * Each listed repository's default-branch commit, by its index, from one GraphQL query per 100,
 * each asked once; undefined when GraphQL gives none for it, so it is asked for as without a token.
 */
function defaultCommits(github: Client, listed: { id: string; branch: string }[]): (index: number) => Promise<string | undefined> {
  const queries = new Map<number, Promise<(string | undefined)[]>>();
  return async (index) => {
    const query = Math.floor(index / QUERY_SIZE);
    if (!queries.has(query)) queries.set(query, queryCommits(github, listed.slice(query * QUERY_SIZE, (query + 1) * QUERY_SIZE)));
    return (await queries.get(query)!)[index % QUERY_SIZE];
  };
}

type BranchRef = { name?: unknown; target?: { oid?: unknown } | null } | null;

async function queryCommits(github: Client, repositories: { id: string; branch: string }[]): Promise<(string | undefined)[]> {
  const fields = repositories.map(({ id }, index) => {
    const [owner, name] = id.split('/');
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { defaultBranchRef { name target { oid } } }`;
  });
  let data: Record<string, { defaultBranchRef?: BranchRef } | null> | undefined;
  try {
    data = await github.graphql(`query { ${fields.join(' ')} }`);
  } catch (error) {
    // The query failed: its repositories are asked for one by one. GitHub answering no more stops the scan.
    if (error instanceof GitHubUnavailable || !(error instanceof AtlasError)) throw error;
    return [];
  }
  return repositories.map(({ branch }, index) => {
    const ref = data?.[`r${index}`]?.defaultBranchRef;
    const oid = ref?.target?.oid;
    // Empty, no default branch, or another one than the list's: asked for as without a token.
    return ref?.name === branch && typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
  });
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
  return openCommit(github, options, info.full_name, name.ref, info.default_branch);
}

/**
 * The repository `id` at `ref`, or at its default branch without one: at `commit` when it is
 * already known, else resolved.
 */
async function openCommit(
  github: Client,
  options: GitHubOptions,
  id: string,
  asked: string | undefined,
  defaultBranch: string,
  commit?: string,
): Promise<Source> {
  const ref = asked ?? defaultBranch;
  const sha =
    commit ??
    (
      await github.json<{ sha: string }>(
        `${API}/repos/${id}/commits/${encodeURIComponent(ref)}`,
        `Not found in https://github.com/${id}: ${ref}`,
        [404, 422], // 422: a ref that names no commit, "No commit found for SHA"
      )
    ).sha;
  // The tree first: it is the commit's own. Code search, with a token, only for a default branch
  // whose tree is too large for one answer: the index sees only the default branch.
  const searchable = Boolean(options.token) && !asked;
  const [organization, repo] = id.split('/');
  // The keys: a tree in one answer lists the same for every ref, with a token or without: one
  // stored scan. A tree too large lists the roots, with a warning worded for a ref or for the
  // default branch: stored apart. Code search, only when its list is exact for the commit (see
  // searchPaths), under its own key: the index may skip a file the tree has. The names of the roots' keys
  // are those an earlier version stored a scan of either kind under, whole tree or roots, so
  // those are found again: by any input when the tree was whole, else only by their own kind.
  const key = (listing: string) => JSON.stringify(['github', id, sha, listing]);
  const whole = key('whole tree');
  const search = searchable ? key('code search') : undefined;
  const earlier = [key('tree'), key('tree of the default branch')];
  const roots = searchable ? undefined : earlier[asked ? 0 : 1];
  return {
    repository: { id, organization, name: repo, url: `https://github.com/${id}`, commit: sha },
    async list() {
      const tree = await github.json<Tree>(`${API}/repos/${id}/git/trees/${sha}?recursive=1`);
      if (!tree.truncated) return { paths: files(tree), warnings: [], key: whole };
      if (searchable) {
        const searched = await searchPaths(github, id, sha);
        return { paths: searched.paths, warnings: [], key: searched.exact ? search : undefined };
      }
      const warnings: string[] = [];
      return { paths: await rootPaths(github, id, sha, warnings, !asked), warnings, key: roots };
    },
    read: (path) => github.raw(`${RAW}/${id}/${sha}/${encodePath(path)}`),
    keys: [whole, ...(search ? [search] : []), ...(roots ? [roots] : []), ...earlier.filter((other) => other !== roots)],
    serves: (stored, result) =>
      stored === whole || stored === search || stored === roots || !result.warnings[0]?.startsWith(TOO_LARGE),
    ref: asked ?? `${defaultBranch} (default branch)`,
  };
}

/**
 * Code search looks at the whole default branch, 100 results a page. Each result names the commit
 * the index reflects, in the `?ref=` of its `url`. `exact`: the list is the commit's own, so it can
 * be stored: every result names one commit, the search is complete, and that commit is the head or
 * an ancestor the compare catches up from. An index behind the head is caught up even when the
 * search is not complete: a skill added since is found.
 */
async function searchPaths(github: Client, id: string, sha: string): Promise<{ paths: string[]; exact: boolean }> {
  const paths = new Set<string>(); // pages can repeat a result
  const refs = new Set<string>();
  let complete = true;
  let total = 0;
  // GitHub returns at most 1000 results: ten pages.
  for (let page = 1; page <= 10; page++) {
    const result = await github.json<{ total_count: number; incomplete_results?: boolean; items: { path: string; url?: string }[] }>(
      `${API}/search/code?q=filename:SKILL.md+repo:${id}&per_page=100&page=${page}`,
    );
    if (result.incomplete_results || result.total_count > 1000) complete = false;
    total = result.total_count;
    for (const item of result.items) {
      paths.add(item.path);
      refs.add(indexCommit(item.url));
    }
    if (result.items.length < 100 || page * 100 >= result.total_count) break;
  }
  // Fewer paths than results: a repeated result pushed another out, or a page came short.
  if (paths.size < Math.min(total, 1000)) complete = false;
  // No result names no commit; results naming different commits, or none, are not one listing.
  const [index] = refs;
  if (refs.size !== 1 || !index) return { paths: [...paths], exact: false };
  if (index === sha) return { paths: [...paths], exact: complete };
  const caughtUp = await catchUp(github, id, index, sha, paths);
  return { paths: [...(caughtUp ?? paths)], exact: complete && Boolean(caughtUp) };
}

/** The commit a code-search result reflects: the `?ref=` of its `url`; '' if none. */
function indexCommit(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).searchParams.get('ref') ?? '';
  } catch {
    return '';
  }
}

/** The compare's files per page: a compare with as many may have more. */
const COMPARE_LIMIT = 300;

/**
 * The search list of the index commit, made the head's: the `SKILL.md` files the commits since
 * added, removed or renamed. Undefined when the compare cannot be trusted: it failed, the index
 * commit is not an ancestor of the head, the compare may not list every file, or a `SKILL.md`
 * changed otherwise.
 */
async function catchUp(github: Client, id: string, index: string, head: string, paths: Set<string>): Promise<Set<string> | undefined> {
  type Compare = { status: string; files?: { filename: string; status: string; previous_filename?: string }[] };
  let compare: Compare;
  try {
    compare = await github.json<Compare>(`${API}/repos/${id}/compare/${index}...${head}`);
  } catch (error) {
    // GitHub no longer has the index commit (a force push: 404), or failed this one answer: the
    // search list as it is. GitHub answering no more requests stops the scan, as anywhere else.
    if (error instanceof GitHubUnavailable || !(error instanceof AtlasError)) throw error;
    return undefined;
  }
  const changed = compare.files ?? [];
  if (compare.status !== 'ahead' || changed.length >= COMPARE_LIMIT) return undefined;
  const isSkill = (path: string | undefined) => path !== undefined && (path === 'SKILL.md' || path.endsWith('/SKILL.md'));
  const caughtUp = new Set(paths);
  for (const file of changed) {
    if (!isSkill(file.filename) && !isSkill(file.previous_filename)) continue;
    if (file.status === 'added' || file.status === 'copied') caughtUp.add(file.filename);
    else if (file.status === 'removed') caughtUp.delete(file.filename);
    else if (file.status === 'renamed') {
      if (file.previous_filename) caughtUp.delete(file.previous_filename);
      if (isSkill(file.filename)) caughtUp.add(file.filename);
    } else if (file.status !== 'modified') return undefined;
  }
  return caughtUp;
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

function client({ fetch: unmetered, token, meter }: GitHubOptions) {
  const fetch = meter ? meter.wrap(unmetered) : unmetered;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const answers = new Map<string, Promise<unknown>>(); // the root tree is asked for once per skill root

  async function get(url: string, init?: Parameters<Fetch>[1]): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new GitHubUnavailable(`Cannot reach GitHub: ${describe(error)}`);
    }
  }

  async function request(url: string, notFound: string, missing: number[]): Promise<unknown> {
    const response = await get(url, { headers });
    if (response.ok) return response.json();
    const body: unknown = await response.json().catch(() => undefined);
    const message = (body as { message?: unknown } | undefined)?.message;
    const text = typeof message === 'string' ? message : '';
    if (missing.includes(response.status)) throw new AtlasError(notFound);
    if ((response.status === 403 || response.status === 429) && /rate limit/i.test(text)) throw rateLimit(response);
    throw failure(response, url, text);
  }

  /** The rate limit, with when it resets if the refusal says so. */
  const rateLimit = (response: Response) => new RateLimited(resetTime(response.headers), Boolean(token));

  /** GitHub answers no more requests: these stop an organization scan. Any other failure is one repository's. */
  function failure(response: Response, url: string, text = ''): AtlasError {
    const { status } = response;
    if (status === 429) return rateLimit(response);
    if (status === 401) return new GitHubUnavailable('GitHub rejected the token in GITHUB_TOKEN');
    return new AtlasError(`GitHub answered ${status} for ${url}${text && `: ${text}`}`);
  }

  return {
    /** A GitHub API answer; `notFound` explains a 404, or another status in `missing`. */
    json<T>(url: string, notFound = `Not found on GitHub: ${url}`, missing = [404]): Promise<T> {
      if (!answers.has(url)) answers.set(url, request(url, notFound, missing));
      return answers.get(url) as Promise<T>;
    },
    /**
     * A GraphQL answer's `data`, partial when some fields failed. The rate limit, a rejected token or
     * GitHub unreachable stop the scan; any other failure is an AtlasError.
     */
    async graphql<T>(query: string): Promise<T> {
      const url = `${API}/graphql`;
      const response = await get(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      const body = (await response.json().catch(() => undefined)) as { data?: T | null; errors?: { type?: unknown }[]; message?: unknown } | undefined;
      const text = typeof body?.message === 'string' ? body.message : '';
      if (Array.isArray(body?.errors) && body.errors.some((error) => error?.type === 'RATE_LIMITED')) throw rateLimit(response);
      if ((response.status === 403 || response.status === 429) && /rate limit/i.test(text)) throw rateLimit(response);
      if (!response.ok) throw failure(response, url, text);
      if (!body?.data) throw new AtlasError(`GitHub answered no data for ${url}`);
      return body.data;
    },
    /** A file's bytes at the scanned commit, or undefined if it is not there. */
    async raw(url: string): Promise<Uint8Array | undefined> {
      // A private repository's files are read with the token too: without it, they answer 404.
      const response = await get(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (response.status === 404) {
        // The file host answers 404, not 401, for a token it does not accept: a token that stopped
        // working would make every file "not found". The API tells; `/rate_limit` costs no request.
        const check = token ? await get(`${API}/rate_limit`, { headers }) : undefined;
        if (check?.status === 401) throw failure(check, url);
        return undefined;
      }
      if (!response.ok) throw failure(response, url);
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
