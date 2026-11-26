// How many requests a scan makes to GitHub, by kind, and the quota GitHub says is left: read from its
// answers, never asked for. See spec/web.md#requests-and-quota.
import type { Fetch } from './github.ts';

/**
 * A scan's requests GitHub answered: `rest`, the REST API's, on the hourly limit (5,000 with a token,
 * 60 without); `graphql`, the GraphQL queries, on a quota of their own; `files`, the file reads from
 * raw.githubusercontent.com, on neither.
 */
export type Requests = { rest: number; graphql: number; files: number };

/** One limit GitHub said it keeps, as of its latest answer: `resetsAt` an ISO 8601 time. */
export type Limit = { remaining: number; limit: number; resetsAt: string };

/** The last limit seen of each resource GitHub named, `core` (REST) and `graphql` among them; null when none was seen. */
export type Quota = Record<string, Limit> | null;

/**
 * The quota GitHub's answers tell, kept across scans: each resource's latest window; in the same
 * window, the lowest `remaining`, so answers arriving out of order never raise it.
 */
export function quotaBook() {
  const seen = new Map<string, { remaining: number; limit: number; reset: number }>();
  return {
    /** An API answer's headers; one without all four of them is not a quota, and changes nothing. */
    record(headers: Headers) {
      const number = (name: string) => {
        const value = headers.get(name)?.trim();
        return value && /^\d+$/.test(value) ? Number(value) : undefined;
      };
      const resource = headers.get('x-ratelimit-resource')?.trim();
      const [remaining, limit, reset] = ['x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset'].map(number);
      if (!resource || remaining === undefined || limit === undefined || reset === undefined) return;
      if (Number.isNaN(new Date(reset * 1000).getTime())) return;
      const known = seen.get(resource);
      if (known && (reset < known.reset || (reset === known.reset && remaining > known.remaining))) return;
      seen.set(resource, { remaining, limit, reset });
    },
    current(): Quota {
      if (seen.size === 0) return null;
      const quota: Record<string, Limit> = {};
      for (const [resource, { remaining, limit, reset }] of [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        quota[resource] = { remaining, limit, resetsAt: new Date(reset * 1000).toISOString() };
      return quota;
    },
  };
}

export type QuotaBook = ReturnType<typeof quotaBook>;

/** One scan's requests, counted as GitHub answers them; each API answer's quota goes to the book. */
export function meter(book: QuotaBook = quotaBook()) {
  const requests: Requests = { rest: 0, graphql: 0, files: 0 };
  return {
    /** A copy of the counts so far. */
    requests: (): Requests => ({ ...requests }),
    quota: () => book.current(),
    /** The fetch, counted: a request that gets no answer is not counted. */
    wrap(fetch: Fetch): Fetch {
      return async (url, init) => {
        const response = await fetch(url, init);
        const { hostname, pathname } = new URL(url);
        if (hostname === 'raw.githubusercontent.com') requests.files++;
        else if (hostname === 'api.github.com') {
          if (pathname === '/graphql') requests.graphql++;
          else requests.rest++;
          book.record(response.headers);
        }
        return response;
      };
    },
  };
}

export type Meter = ReturnType<typeof meter>;
